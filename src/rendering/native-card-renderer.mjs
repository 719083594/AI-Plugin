// Trusted plugin SVG builders only. Both public and private SVG/JPEG stay in
// RAM. This service has no file, browser, network, HTML or model API.
const MAX_PIXELS=12000000,MAX_SVG_BYTES=4*1024*1024,MAX_JPEG_BYTES=8*1024*1024;
const MAX_IMAGE_BYTES=256*1024,MAX_IMAGE_TOTAL=2*1024*1024,MAX_IMAGES=64;
const MAX_QUEUED=2,SHARP_VERSION='0.35.5';
const REGISTRY=Symbol.for('ai-plugin.memory-native-card-renderer.v1');
const state=globalThis[REGISTRY]||(globalThis[REGISTRY]={active:false,pending:[],configured:new WeakSet()});
const PNG=Buffer.from([137,80,78,71,13,10,26,10]);
const CRC_TABLE=Uint32Array.from({length:256},(_,value)=>{for(let bit=0;bit<8;bit++)value=value&1?0xedb88320^(value>>>1):value>>>1;return value>>>0});
const TAGS=new Set(['svg','defs','linearGradient','stop','rect','circle','path','text','tspan','g','clipPath','image','line']);
const GLOBAL=new Set(['fill','stroke','stroke-width','opacity','fill-opacity','stroke-opacity','transform','clip-path','font-family','font-size','font-weight','text-anchor','stroke-linecap','stroke-linejoin']);
const ATTRS={svg:['xmlns','width','height','viewBox'],defs:[],linearGradient:['id','x1','y1','x2','y2','gradientUnits','gradientTransform'],stop:['offset','stop-color','stop-opacity'],rect:['x','y','width','height','rx','ry'],circle:['cx','cy','r'],path:['d','fill-rule'],text:['x','y','dx','dy'],tspan:['x','y','dx','dy'],g:[],clipPath:['id','clipPathUnits'],image:['x','y','width','height','preserveAspectRatio','href'],line:['x1','y1','x2','y2']};
const NUMBER=/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;
const ID=/^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class NativeCardRenderError extends Error{
  constructor(code){super(code==='NATIVE_BACKEND_UNAVAILABLE'?'图片组件尚未就绪，请暂时查看文字内容。':'图片暂未生成，请暂时查看文字内容。');this.name='NativeCardRenderError';this.code=code;}
}
const fail=code=>{throw new NativeCardRenderError(code)};
function crc32(bytes){let crc=0xffffffff;for(const byte of bytes)crc=CRC_TABLE[(crc^byte)&255]^(crc>>>8);return (crc^0xffffffff)>>>0}
function dimensions(bytes,type){
  let width=0,height=0;
  if(type==='png'){
    if(bytes.length<45||!bytes.subarray(0,8).equals(PNG))fail('INVALID_NATIVE_IMAGE');
    let offset=8,header=false,data=false,ended=false;
    while(offset+12<=bytes.length){
      const length=bytes.readUInt32BE(offset),end=offset+length+12;
      if(end>bytes.length)fail('INVALID_NATIVE_IMAGE');
      const chunk=bytes.toString('ascii',offset+4,offset+8);
      if(!/^[A-Za-z]{4}$/.test(chunk)||crc32(bytes.subarray(offset+4,end-4))!==bytes.readUInt32BE(end-4)||['acTL','fcTL','fdAT'].includes(chunk))fail('INVALID_NATIVE_IMAGE');
      if(!header){if(chunk!=='IHDR'||length!==13)fail('INVALID_NATIVE_IMAGE');width=bytes.readUInt32BE(offset+8);height=bytes.readUInt32BE(offset+12);header=true}
      else if(chunk==='IHDR')fail('INVALID_NATIVE_IMAGE');
      if(chunk==='IDAT')data=true;
      if(chunk==='IEND'){if(length||end!==bytes.length||!data)fail('INVALID_NATIVE_IMAGE');ended=true;break}
      offset=end;
    }
    if(!ended)fail('INVALID_NATIVE_IMAGE');
  }else{
    if(bytes.length<12||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)fail('INVALID_NATIVE_IMAGE');
    let offset=2;
    while(offset<bytes.length-2){
      if(bytes[offset++]!==255)fail('INVALID_NATIVE_IMAGE');while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===0xda)break;
      if(marker===0||marker===0xd8||marker===0xd9||marker>=0xd0&&marker<=0xd7||offset+2>bytes.length)fail('INVALID_NATIVE_IMAGE');
      const length=bytes.readUInt16BE(offset);if(length<2||offset+length>bytes.length)fail('INVALID_NATIVE_IMAGE');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)){
        if(width||length<8||bytes[offset+2]!==8)fail('INVALID_NATIVE_IMAGE');
        height=bytes.readUInt16BE(offset+3);width=bytes.readUInt16BE(offset+5);
        const components=bytes[offset+7];if(![1,3,4].includes(components)||length!==8+3*components)fail('INVALID_NATIVE_IMAGE');
      }
      offset+=length;
    }
  }
  if(!width||!height||width>4096||height>4096||width*height>4194304)fail('INVALID_NATIVE_IMAGE');
  return width*height;
}
function entities(value){
  // Only the five XML predefined entities are needed by our text builder.
  // No DTD, numeric character references or custom entity can add syntax.
  const decoded=value.replace(/&(amp|lt|gt|quot|apos);/g,(_,name)=>({amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"})[name]);
  if(/&(?!(?:amp|lt|gt|quot|apos);)/.test(value)||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value))fail('UNSAFE_NATIVE_SVG');
  return decoded;
}
function coordinate(value){const raw=value.endsWith('%')?value.slice(0,-1):value;return NUMBER.test(raw)&&Number.isFinite(Number(raw))&&Math.abs(Number(raw))<=12000}
function geometryNumbers(value){return (value.match(/[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/g)||[]).every(number=>Number.isFinite(Number(number))&&Math.abs(Number(number))<=12000)}
function validateSvg(svg,width,height){
  if(/<!|<\?|\]\]>/.test(svg))fail('UNSAFE_NATIVE_SVG');
  const stack=[],ids=new Map(),refs=[];let index=0,nodes=0,root=false,closed=false,images=0,imageBytes=0,imagePixels=0;
  const space=()=>{while(/[\t\r\n ]/.test(svg[index]||'!'))index++};
  const name=()=>{const found=/^[A-Za-z][A-Za-z0-9-]*/.exec(svg.slice(index));if(!found)fail('UNSAFE_NATIVE_SVG');index+=found[0].length;return found[0]};
  function attribute(tag,key,raw){
    if(!ATTRS[tag].includes(key)&&!(tag!=='svg'&&tag!=='defs'&&tag!=='linearGradient'&&tag!=='stop'&&GLOBAL.has(key)))fail('UNSAFE_NATIVE_SVG');
    const value=entities(raw);
    if(key==='href'){
      if(raw!==value)fail('UNSAFE_NATIVE_SVG');
      const match=/^data:image\/(png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(raw);
      if(!match||match[2].length%4||match[2].length>Math.ceil(MAX_IMAGE_BYTES/3)*4)fail('INVALID_NATIVE_IMAGE');
      const bytes=Buffer.from(match[2],'base64');
      if(bytes.length>MAX_IMAGE_BYTES||bytes.toString('base64')!==match[2]||(imageBytes+=bytes.length)>MAX_IMAGE_TOTAL||++images>MAX_IMAGES)fail('NATIVE_IMAGE_LIMIT');
      // Bound decoded portraits as well as compressed bytes to avoid many tiny
      // compressed images expanding beyond the card's own pixel budget.
      if((imagePixels+=dimensions(bytes,match[1]))>MAX_PIXELS)fail('NATIVE_IMAGE_LIMIT');
    }else if(key==='xmlns'){if(tag!=='svg'||value!=='http://www.w3.org/2000/svg')fail('UNSAFE_NATIVE_SVG')}
    else if(key==='viewBox'){const values=value.trim().split(/[\s,]+/);if(values.length!==4||values.some(part=>!NUMBER.test(part))||values.map(Number).some((part,i)=>part!==[0,0,width,height][i]))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='id'){if(!ID.test(value)||ids.has(value))fail('UNSAFE_NATIVE_SVG');ids.set(value,tag)}
    else if(key==='fill'||key==='stroke'||key==='clip-path'){
      const local=/^url\(#([A-Za-z][A-Za-z0-9_-]{0,63})\)$/.exec(value);
      if(local)refs.push([local[1],key==='clip-path'?'clipPath':'linearGradient']);
      else if(key==='clip-path'||!(/^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|none|transparent|black|white)$/.test(value)))fail('UNSAFE_NATIVE_SVG');
    }else if(key==='stop-color'){if(!/^(?:#[0-9a-fA-F]{3,4}|#[0-9a-fA-F]{6}|#[0-9a-fA-F]{8}|transparent|black|white)$/.test(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='font-family'){if(value.length>160||!/[\p{L}\p{N}]/u.test(value)||!/^[\p{L}\p{N} ,'_-]+$/u.test(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='font-weight'){if(!/^(?:normal|bold|[1-9]\d{0,2}|1000)$/.test(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='font-size'){if(!NUMBER.test(value)||Number(value)<=0||Number(value)>512)fail('UNSAFE_NATIVE_SVG')}
    else if(key==='text-anchor'){if(!['start','middle','end'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='preserveAspectRatio'){if(!['none','xMidYMid slice','xMidYMid meet'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='gradientUnits'||key==='clipPathUnits'){if(!['userSpaceOnUse','objectBoundingBox'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='stroke-linecap'){if(!['butt','round','square'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='stroke-linejoin'){if(!['miter','round','bevel'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='fill-rule'){if(!['nonzero','evenodd'].includes(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='transform'||key==='gradientTransform'){if(value.length>256||!/^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\(\s*[-+\d.eE,\s]+\)\s*)+$/.test(value)||!geometryNumbers(value))fail('UNSAFE_NATIVE_SVG')}
    else if(key==='d'){if(value.length>32768||!/^[MmLlHhVvCcSsQqTtAaZz\d.eE+,\s-]+$/.test(value)||!geometryNumbers(value))fail('UNSAFE_NATIVE_SVG')}
    else if(['opacity','fill-opacity','stroke-opacity','stop-opacity'].includes(key)){if(!NUMBER.test(value)||Number(value)<0||Number(value)>1)fail('UNSAFE_NATIVE_SVG')}
    else if(!coordinate(value))fail('UNSAFE_NATIVE_SVG');
    return value;
  }
  while(index<svg.length){
    const next=svg.indexOf('<',index),end=next<0?svg.length:next,text=svg.slice(index,end);
    entities(text);if(text.trim()&&!['text','tspan'].includes(stack.at(-1)))fail('UNSAFE_NATIVE_SVG');index=end;if(next<0)break;
    index++;
    if(svg[index]==='/'){
      index++;const tag=name();space();if(svg[index++]!=='>'||stack.pop()!==tag)fail('UNSAFE_NATIVE_SVG');if(!stack.length)closed=true;continue;
    }
    const tag=name();if(!TAGS.has(tag)||closed||++nodes>10000||stack.length>=32)fail('UNSAFE_NATIVE_SVG');
    if(!root){if(tag!=='svg')fail('UNSAFE_NATIVE_SVG');root=true}else if(!stack.length||tag==='svg')fail('UNSAFE_NATIVE_SVG');
    const parent=stack.at(-1);
    if(parent==='defs'&&!['linearGradient','clipPath'].includes(tag)||parent==='linearGradient'&&tag!=='stop'||parent==='clipPath'&&!['rect','circle','path'].includes(tag)||['stop','rect','circle','path','image','line'].includes(parent)||['text','tspan'].includes(parent)&&tag!=='tspan'||tag==='defs'&&!['svg','g'].includes(parent)||['linearGradient','clipPath'].includes(tag)&&parent!=='defs'||tag==='stop'&&parent!=='linearGradient')fail('UNSAFE_NATIVE_SVG');
    const attrs=new Map();let empty=false;
    for(;;){
      const before=index;space();if(svg[index]==='>'){index++;break}if(svg[index]==='/'&&svg[index+1]==='>'){index+=2;empty=true;break}
      if(index===before||attrs.size>=32)fail('UNSAFE_NATIVE_SVG');const key=name();space();if(svg[index++]!=='=')fail('UNSAFE_NATIVE_SVG');space();const quote=svg[index++];if(quote!=='"'&&quote!=="'")fail('UNSAFE_NATIVE_SVG');
      const valueEnd=svg.indexOf(quote,index);if(valueEnd<0||svg.slice(index,valueEnd).includes('<')||attrs.has(key))fail('UNSAFE_NATIVE_SVG');const raw=svg.slice(index,valueEnd);index=valueEnd+1;attrs.set(key,attribute(tag,key,raw));
    }
    if(tag==='svg'&&(attrs.get('xmlns')!=='http://www.w3.org/2000/svg'||attrs.get('width')!==String(width)||attrs.get('height')!==String(height)||!attrs.has('viewBox')))fail('UNSAFE_NATIVE_SVG');
    if(tag==='image'&&!attrs.has('href'))fail('UNSAFE_NATIVE_SVG');
    if((tag==='clipPath'||parent==='clipPath')&&attrs.has('clip-path'))fail('UNSAFE_NATIVE_SVG');
    if(!empty)stack.push(tag);else if(!stack.length)closed=true;
  }
  if(!root||!closed||stack.length||refs.some(([id,tag])=>ids.get(id)!==tag))fail('UNSAFE_NATIVE_SVG');
}

/** Aggregate admission state only; never exposes input, owner or output. */
export function getNativeRenderStatus(){return Object.freeze({active:state.active?1:0,queued:state.pending.length,maxQueued:MAX_QUEUED})}

async function acquire(){
  if(!state.active){state.active=true;return}
  if(state.pending.length>=MAX_QUEUED)fail('NATIVE_RENDER_BUSY');
  await new Promise(resolve=>state.pending.push(resolve));
}
function release(){
  const next=state.pending.shift();
  if(next)next();else state.active=false;
}

/** Call only from trusted local SVG builders, never arbitrary user SVG/HTML.
 * loadSharp may resolve a local pinned backend installed by the host/plugin.
 * Loading this module does not load sharp or read any plugin configuration.
 * Cache/thread controls and the bounded FIFO are shared across this process. */
export function createNativeCardRenderer({onMetrics=null,loadSharp=()=>import('sharp')}={}){
  if(onMetrics!==null&&typeof onMetrics!=='function'||typeof loadSharp!=='function')throw new TypeError('Invalid native card renderer configuration');
  let backendPromise;
  async function backend(){
    if(!backendPromise)backendPromise=Promise.resolve().then(loadSharp).then(module=>{
      const sharp=typeof module==='function'?module:module?.default;
      if(typeof sharp!=='function'||typeof sharp.cache!=='function'||typeof sharp.concurrency!=='function'||sharp.versions?.sharp!==SHARP_VERSION)fail('NATIVE_BACKEND_UNAVAILABLE');
      if(!state.configured.has(sharp)){sharp.cache(false);sharp.concurrency(1);state.configured.add(sharp)}
      return sharp;
    }).catch(()=>{backendPromise=undefined;fail('NATIVE_BACKEND_UNAVAILABLE')});
    return backendPromise;
  }
  return async function renderNative(input){
    const started=performance.now();let code='OK',locked=false,svg;
    try{
      if(!input||typeof input!=='object'||Array.isArray(input))fail('INVALID_NATIVE_CARD');
      const {width,height,private:privatePage}=input;svg=input.svg;input=undefined;
      if(typeof svg!=='string'||!svg||Buffer.byteLength(svg)>MAX_SVG_BYTES||!Number.isSafeInteger(width)||width<320||width>1600||!Number.isSafeInteger(height)||height<100||height>12000||width*height>MAX_PIXELS||typeof privatePage!=='boolean')fail('INVALID_NATIVE_CARD');
      validateSvg(svg,width,height);
      await acquire();locked=true;
      const sharp=await backend(),pipeline=sharp(Buffer.from(svg,'utf8'),{density:72,limitInputPixels:MAX_PIXELS,failOn:'warning',unlimited:false});svg='';
      // Native timeout is awaited until libvips settles. A caller's external
      // deadline cannot release this slot while its native work is still alive.
      const result=await pipeline.jpeg({quality:88,chromaSubsampling:'4:4:4',progressive:false}).timeout({seconds:10}).toBuffer({resolveWithObject:true});
      const bytes=result?.data,info=result?.info;
      if(!Buffer.isBuffer(bytes)||bytes.length<4||bytes.length>MAX_JPEG_BYTES||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217||info?.format!=='jpeg'||info.width!==width||info.height!==height)fail('INVALID_NATIVE_IMAGE');
      return Buffer.from(bytes);
    }catch(error){
      const safe=error instanceof NativeCardRenderError?error:new NativeCardRenderError('NATIVE_RENDER_FAILED');code=safe.code;throw safe;
    }finally{
      svg='';input=undefined;if(locked)release();
      if(onMetrics)try{Promise.resolve(onMetrics(Object.freeze({backend:'sharp',elapsed:Math.round((performance.now()-started)*10)/10,code}))).catch(()=>{})}catch{}
    }
  };
}
