import React, { useEffect, useRef, useState } from 'react';
import { Canvas } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

const MAX_FILE_BYTES = 100 * 1024 * 1024;
const MAX_FACES = 500000;

function disposeModel(root) {
  const geometries = new Set(), materials = new Set(), textures = new Set();
  root?.traverse((object) => {
    if (object.geometry) geometries.add(object.geometry);
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      if (!material) continue;
      materials.add(material);
      Object.values(material).forEach((value) => { if (value?.isTexture) textures.add(value); });
    }
  });
  geometries.forEach((geometry) => geometry.dispose());
  materials.forEach((material) => material.dispose());
  textures.forEach((texture) => texture.dispose());
}

function analyze(root) {
  root.updateMatrixWorld(true);
  const meshes = [];
  root.traverse((object) => {
    if (object.isSkinnedMesh || object.isInstancedMesh || object.morphTargetInfluences?.some(Boolean)) {
      throw new Error('暂不支持蒙皮、实例化或变形模型，请导出为静态网格后重试。');
    }
    if (object.isMesh && object.geometry?.getAttribute('position')) meshes.push(object);
  });
  if (!meshes.length) throw new Error('文件中没有可读取的三角网格。');
  const requestedFaces = meshes.reduce((sum, mesh) => {
    const geometry = mesh.geometry;
    const count = geometry.index ? geometry.index.count : geometry.getAttribute('position').count;
    const start = Math.max(0, geometry.drawRange.start || 0);
    return sum + Math.max(0, Math.min(count - start, geometry.drawRange.count)) / 3;
  }, 0);
  if (requestedFaces > MAX_FACES) throw new Error('模型超过 50 万个三角面，请先简化后再导入。');
  // Precise bounds account for the actual transformed vertices, not a rotated local bounding box.
  const bounds = new THREE.Box3().setFromObject(root, true);
  if (bounds.isEmpty()) throw new Error('模型没有有效的几何尺寸。');
  const size = bounds.getSize(new THREE.Vector3());
  const center = bounds.getCenter(new THREE.Vector3());
  const maxSize = Math.max(size.x, size.y, size.z);
  if (!Number.isFinite(maxSize) || maxSize <= 0) throw new Error('模型尺寸无效，请检查文件。');
  const tolerance = maxSize * 1e-7;
  const vertices = new Map(), parent = [], edges = new Map(), volumes = [];
  let faces = 0, degenerateFaces = 0;
  const vertexId = (v) => {
    if (![v.x, v.y, v.z].every(Number.isFinite)) throw new Error('网格包含无效坐标。');
    const key = `${Math.round((v.x - center.x) / tolerance)},${Math.round((v.y - center.y) / tolerance)},${Math.round((v.z - center.z) / tolerance)}`;
    let id = vertices.get(key);
    if (id === undefined) { id = parent.length; parent.push(id); vertices.set(key, id); }
    return id;
  };
  const find = (id) => {
    let node = id;
    while (parent[node] !== node) node = parent[node];
    while (parent[id] !== id) { const next = parent[id]; parent[id] = node; id = next; }
    return node;
  };
  const join = (a, b) => { a = find(a); b = find(b); if (a !== b) parent[b] = a; };
  const addEdge = (a, b) => {
    const key = a < b ? `${a}:${b}` : `${b}:${a}`;
    const edge = edges.get(key) || { count: 0, direction: 0 };
    edge.count++; edge.direction += a < b ? 1 : -1; edges.set(key, edge);
  };
  const a = new THREE.Vector3(), b = new THREE.Vector3(), c = new THREE.Vector3();
  const cross = new THREE.Vector3(), ab = new THREE.Vector3(), ac = new THREE.Vector3();
  for (const mesh of meshes) {
    const geometry = mesh.geometry, position = geometry.getAttribute('position'), index = geometry.index;
    const total = index ? index.count : position.count;
    const start = Math.max(0, geometry.drawRange.start || 0);
    const end = Math.min(total, start + geometry.drawRange.count);
    if ((end - start) % 3 !== 0) throw new Error('网格三角面数据不完整。');
    if (faces + (end - start) / 3 > MAX_FACES) throw new Error('模型超过 50 万个三角面，请先简化后再导入。');
    const read = (vector, offset) => {
      const i = index ? index.getX(offset) : offset;
      if (!Number.isInteger(i) || i < 0 || i >= position.count) throw new Error('网格索引无效。');
      return vector.fromBufferAttribute(position, i).applyMatrix4(mesh.matrixWorld);
    };
    for (let i = start; i < end; i += 3) {
      read(a, i); read(b, i + 1); read(c, i + 2);
      const ia = vertexId(a), ib = vertexId(b), ic = vertexId(c);
      faces++;
      ab.subVectors(b, a); ac.subVectors(c, a);
      if (ia === ib || ib === ic || ic === ia || cross.crossVectors(ab, ac).lengthSq() <= Math.pow(tolerance, 4)) {
        degenerateFaces++; continue;
      }
      addEdge(ia, ib); addEdge(ib, ic); addEdge(ic, ia);
      join(ia, ib); join(ib, ic);
      // Shift the origin towards the mesh to reduce cancellation for distant coordinates.
      const av = a.clone().sub(center), bv = b.clone().sub(center), cv = c.clone().sub(center);
      volumes.push([ia, av.dot(bv.cross(cv)) / 6]);
    }
  }
  if (!faces || !volumes.length) throw new Error('模型没有有效的三角面。');
  let boundaryEdges = 0, nonManifoldEdges = 0, inconsistentEdges = 0;
  for (const edge of edges.values()) {
    if (edge.count === 1) boundaryEdges++;
    else if (edge.count !== 2) nonManifoldEdges++;
    else if (edge.direction !== 0) inconsistentEdges++;
  }
  const watertight = boundaryEdges === 0 && nonManifoldEdges === 0 && degenerateFaces === 0;
  let volume = null;
  if (watertight && inconsistentEdges === 0) {
    const components = new Map();
    for (const [id, v] of volumes) { const key = find(id); components.set(key, (components.get(key) || 0) + v); }
    volume = [...components.values()].reduce((sum, v) => sum + Math.abs(v), 0);
    if (!Number.isFinite(volume) || volume <= 0) volume = null;
  }
  return {
    dimensions: { x: size.x, y: size.y, z: size.z },
    faces, boundaryEdges, nonManifoldEdges, inconsistentEdges, degenerateFaces,
    watertight, volume, unit: 'model units', tolerance,
    // This edge-based test does not detect self-intersections, nested shells or physical wall thickness.
    limitations: '拓扑检查不检测自相交、嵌套壳或壁厚；体积为原始模型单位的近似值。',
    view: { center: center.toArray(), scale: 2 / maxSize },
  };
}

async function readModel(file) {
  if (!file || typeof file.arrayBuffer !== 'function') throw new Error('请选择有效的 GLB 或 STL 文件。');
  if (file.size > MAX_FILE_BYTES) throw new Error('文件超过 100 MB，请压缩或简化模型后重试。');
  const extension = file.name?.split('.').pop()?.toLowerCase();
  if (extension !== 'glb' && extension !== 'stl') throw new Error('仅支持 GLB 或 STL 文件。');
  const data = await file.arrayBuffer();
  if (extension === 'stl') {
    let geometry;
    try { geometry = new STLLoader().parse(data); }
    catch { throw new Error('STL 文件无法读取，文件可能已损坏或格式不受支持。'); }
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: '#9ab7d7', roughness: 0.7, side: THREE.DoubleSide }));
  }
  const manager = new THREE.LoadingManager();
  manager.setURLModifier((url) => {
    if (/^(blob:|data:)/i.test(url)) return url;
    throw new Error('GLB 引用了外部资源，请使用包含所有资源的独立 GLB 文件。');
  });
  let gltf;
  try { gltf = await new Promise((resolve, reject) => new GLTFLoader(manager).parse(data, '', resolve, reject)); }
  catch (error) {
    if (error?.message?.includes('GLB 引用了外部资源')) throw error;
    throw new Error('GLB 文件无法读取，可能已损坏、使用了不支持的压缩格式或包含外部资源。');
  }
  if (!gltf.scene) throw new Error('GLB 中没有可用场景。');
  return gltf.scene;
}

class ViewerErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error) { this.props.onError(error); }
  componentDidUpdate(previous) { if (previous.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() { return this.state.error ? <div role="alert" style={{ padding: 24 }}>3D 预览不可用，请检查浏览器的 WebGL 支持。</div> : this.props.children; }
}

/**
 * Viewer({modelFile, onAnalysis})
 * onAnalysis is called with status empty/loading/error/ready. Ready includes dimensions, faces,
 * edge counts, watertight, volume (or null), unit, tolerance and limitations.
 */
export default function Viewer({ modelFile, onAnalysis }) {
  const [model, setModel] = useState(null);
  const [view, setView] = useState(null);
  const [message, setMessage] = useState('选择 GLB 或 STL 文件以查看模型。');
  const callback = useRef(onAnalysis);
  callback.current = onAnalysis;
  useEffect(() => {
    let cancelled = false, loaded = null;
    setModel(null); setView(null);
    if (!modelFile) {
      setMessage('选择 GLB 或 STL 文件以查看模型。');
      callback.current?.({ status: 'empty' });
      return () => { cancelled = true; };
    }
    setMessage('正在读取和分析模型…');
    callback.current?.({ status: 'loading' });
    (async () => {
      try {
        loaded = await readModel(modelFile);
        if (cancelled) { disposeModel(loaded); return; }
        const result = analyze(loaded);
        if (cancelled) { disposeModel(loaded); return; }
        setModel(loaded); setView(result.view); setMessage('');
        const { view: _, ...analysis } = result;
        callback.current?.({ status: 'ready', ...analysis });
      } catch (error) {
        if (loaded) { disposeModel(loaded); loaded = null; }
        if (!cancelled) {
          const text = error?.message || '模型读取失败，请检查文件。';
          setMessage(text); callback.current?.({ status: 'error', error: text });
        }
      }
    })();
    return () => { cancelled = true; if (loaded) { disposeModel(loaded); loaded = null; } };
  }, [modelFile]);
  return <div style={{ position: 'relative', width: '100%', height: 360, background: '#f5f9fe', overflow: 'hidden' }}>
    {model && view ? <ViewerErrorBoundary resetKey={modelFile} onError={() => callback.current?.({ status: 'error', error: '3D 预览不可用，请检查浏览器的 WebGL 支持。' })}>
      <Canvas camera={{ position: [3, 2, 3], fov: 42 }} dpr={[1, 2]} frameloop="demand" fallback={<div role="alert">当前浏览器不支持 WebGL。</div>}>
        <ambientLight intensity={1.5} /><directionalLight position={[4, 6, 5]} intensity={2} />
        <group scale={view.scale} position={view.center.map((n) => -n * view.scale)}><primitive object={model} /></group>
        <OrbitControls makeDefault enablePan enableZoom enableRotate />
      </Canvas>
      <div style={{ position: 'absolute', bottom: 12, left: 12, fontSize: 12, color: '#506b8a', pointerEvents: 'none' }}>左键旋转 · 滚轮缩放 · 右键平移</div>
    </ViewerErrorBoundary> : <div role="status" style={{ height: '100%', display: 'grid', placeItems: 'center', padding: 24, color: '#506b8a', textAlign: 'center' }}>{message}</div>}
  </div>;
}
