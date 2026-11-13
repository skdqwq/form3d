import * as meshy from '../integration/meshy.mjs';

// Administrator-only library: intentionally no HTTP route or automatic refresh.
// A caller must select one known task and its expected owner, with a DB backup.
export async function refreshTaskAssets({db, env, taskId, expectedUser, adapter=meshy, now=Date.now}) {
  const region=meshy.meshyRegion(env);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId || '') || typeof expectedUser!=='string' || !expectedUser)
    throw new Error('Explicit task ID and owner are required.');
  const task=await db.prepare('SELECT * FROM reconstruction_tasks WHERE id=? AND user_id=?').bind(taskId,expectedUser).first();
  if (!task || task.status!=='SUCCEEDED' || !/^[A-Za-z0-9_-]{1,128}$/.test(task.remote_id || ''))
    throw new Error('The selected task must already have succeeded with a valid remote ID.');
  const result=await adapter.getImageTo3D(env,task.remote_id);
  if (result.id!==task.remote_id || result.status!=='SUCCEEDED') throw new Error('Upstream task identity or status does not match.');
  const assets=meshy.safeAssets(result.assets);
  const host=region==='cn'?'assets.meshy.cn':'assets.meshy.ai';
  if (!assets.glb || !assets.stl || Object.values(assets).some(value=>new URL(value).hostname!==host))
    throw new Error('The selected region did not return both expected official asset URLs.');
  const expiry=result.expiresAt ?? null;
  if (expiry!==null && (!Number.isFinite(expiry) || expiry<=now())) throw new Error('Refreshed assets have an invalid or expired timestamp.');
  // Do not rewrite a hostname or reuse signatures from the previous region.
  // The compare-and-swap prevents overwriting a task changed during the GET.
  const updated=await db.prepare("UPDATE reconstruction_tasks SET assets_json=?,expires_at=?,updated_at=? WHERE id=? AND user_id=? AND remote_id=? AND status='SUCCEEDED' AND updated_at=? AND assets_json IS ?")
    .bind(JSON.stringify(assets),expiry,now(),task.id,expectedUser,task.remote_id,task.updated_at,task.assets_json).run();
  if (updated.meta.changes!==1) throw new Error('The selected task changed; no assets were refreshed.');
  return {updated:true,region,formats:['glb','stl']};
}
