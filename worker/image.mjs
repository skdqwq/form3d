// Bounded browser-normalized PNG validator. The image is never persisted here.
const MAX_BYTES=8*1024*1024;
const CRC_TABLE=Uint32Array.from({length:256},(_,n)=>{for(let k=0;k<8;k++)n=n&1?0xedb88320^(n>>>1):n>>>1;return n>>>0});
function crc32(bytes){let crc=0xffffffff;for(const b of bytes)crc=CRC_TABLE[(crc^b)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
export async function normalizedPng(dataUrl){
 if(typeof dataUrl!=='string'||dataUrl.length>MAX_BYTES*1.34+100||!dataUrl.startsWith('data:image/png;base64,'))throw new Error('请上传经过浏览器处理的 PNG 图片。');
 const raw=dataUrl.slice(22);if(!/^[A-Za-z0-9+/]+={0,2}$/.test(raw)||raw.length%4)throw new Error('图片编码无效。');
 let binary;try{binary=atob(raw)}catch{throw new Error('图片编码无效。')}
 if(binary.length>MAX_BYTES||binary.length<57)throw new Error('图片过大或无效。');
 const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0)),view=new DataView(bytes.buffer);
 if(![137,80,78,71,13,10,26,10].every((x,i)=>bytes[i]===x))throw new Error('PNG 文件头无效。');
 let offset=8,width=0,height=0,channels=0,ended=false,seenIdat=false;const idat=[],out=[bytes.subarray(0,8)];
 while(offset<bytes.length){
  if(offset+12>bytes.length)throw new Error('PNG 数据不完整。');
  const len=view.getUint32(offset),end=offset+12+len;if(end>bytes.length||len>MAX_BYTES)throw new Error('PNG 数据块无效。');
  if(crc32(bytes.subarray(offset+4,end-4))!==view.getUint32(end-4))throw new Error('PNG 数据校验失败。');
  const type=String.fromCharCode(...bytes.subarray(offset+4,offset+8));
  if(offset===8&&type!=='IHDR')throw new Error('PNG 图像头无效。');
  if(type==='IHDR'){
   if(width||len!==13)throw new Error('PNG 图像头无效。');
   width=view.getUint32(offset+8);height=view.getUint32(offset+12);const depth=bytes[offset+16],color=bytes[offset+17];
   if(width<32||height<32||width>1536||height>1536||depth!==8||![2,6].includes(color)||bytes[offset+18]||bytes[offset+19]||bytes[offset+20])throw new Error('请使用 32–1536 像素的 RGB/RGBA PNG 图片。');channels=color===6?4:3;
  }else if(type==='IDAT'){if(ended)throw new Error('PNG 图像数据无效。');seenIdat=true;idat.push(bytes.subarray(offset+8,offset+8+len));}
  else if(type==='IEND'){if(len||end!==bytes.length||!seenIdat)throw new Error('PNG 图像结尾无效。');ended=true;}
  else if((type.charCodeAt(0)&32)===0)throw new Error('PNG 含不支持的数据块。');
  if(['IHDR','IDAT','IEND'].includes(type))out.push(bytes.subarray(offset,end));offset=end;
 }
 if(!width||!ended)throw new Error('PNG 图片不完整。');
 // Stop decompression at the exact bounded scanline size; reject zip bombs.
 const row=width*channels+1,expected=row*height;let decoded=0;
 const reader=new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate')).getReader();
 try{while(true){const {done,value}=await reader.read();if(done)break;if(decoded+value.length>expected)throw new Error('PNG 解码尺寸不匹配。');for(let i=(row-decoded%row)%row;i<value.length;i+=row)if(value[i]>4)throw new Error('PNG 过滤数据无效。');decoded+=value.length;}}
 catch(e){await reader.cancel().catch(()=>{});throw new Error('PNG 图像数据无效。');}
 if(decoded!==expected)throw new Error('PNG 图像数据不完整。');
 return new Uint8Array(await new Blob(out).arrayBuffer());
}
