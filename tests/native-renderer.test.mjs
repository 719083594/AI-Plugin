import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {pathToFileURL} from 'node:url';
import {deflateSync} from 'node:zlib';
import {createNativeCardRenderer,NativeCardRenderError,getNativeRenderStatus} from '../src/rendering/index.mjs';

let installedSharp;
try{installedSharp=(await import(process.env.AI_RENDERER_TEST_SHARP?pathToFileURL(process.env.AI_RENDERER_TEST_SHARP).href:'sharp')).default}
catch(error){if(process.env.AI_RENDERER_TEST_SHARP)throw error}

const flush=()=>new Promise(resolve=>setImmediate(resolve));
const card=(body='<rect width="1080" height="800" fill="#17313d"/><text x="40" y="80" fill="#ffffff" font-size="32">SYNTHETIC PRIVATE</text>',width=1080,height=800)=>({svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">${body}</svg>`,width,height,private:true});
function fakeSharp({pending=null,error=null,result=null,version='0.35.5'}={}){
  const calls=[];
  const sharp=(input,options)=>{
    calls.push(['input',input,options]);
    return {jpeg(options){calls.push(['jpeg',options]);return this},timeout(options){calls.push(['timeout',options]);return this},async toBuffer(options){calls.push(['toBuffer',options]);if(pending)await pending;if(error)throw error;return result||{data:Buffer.from([255,216,255,217]),info:{format:'jpeg',width:Number(/width="(\d+)"/.exec(input.toString())[1]),height:Number(/height="(\d+)"/.exec(input.toString())[1])}}},toFile(){assert.fail('no private output files')},metadata(){assert.fail('no second decode or file metadata pass')}};
  };
  sharp.versions={sharp:version};sharp.cache=value=>calls.push(['cache',value]);sharp.concurrency=value=>calls.push(['concurrency',value]);return {sharp,calls};
}
function chunk(type,data){const body=Buffer.concat([Buffer.from(type),data]);let crc=0xffffffff;for(const value of body){crc^=value;for(let bit=0;bit<8;bit++)crc=crc&1?0xedb88320^(crc>>>1):crc>>>1}const length=Buffer.alloc(4),sum=Buffer.alloc(4);length.writeUInt32BE(data.length);sum.writeUInt32BE((crc^0xffffffff)>>>0);return Buffer.concat([length,body,sum]);}
function png(width=1,height=1,padding=0){const header=Buffer.alloc(13);header.writeUInt32BE(width);header.writeUInt32BE(height,4);header[8]=8;header[9]=6;return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]),chunk('IHDR',header),chunk('IDAT',deflateSync(Buffer.from([0,230,170,80,255]))),...(padding?[chunk('tEXt',Buffer.concat([Buffer.from('QA\0'),Buffer.alloc(padding,65)]))]:[]),chunk('IEND',Buffer.alloc(0))]);}
const data=(bytes,type='png')=>`data:image/${type};base64,${bytes.toString('base64')}`;
const image=uri=>`<image x="10" y="10" width="100" height="100" href="${uri}" preserveAspectRatio="xMidYMid slice"/>`;

test('lazy sharp receives only a RAM SVG Buffer, private cache is disabled once, and JPEG output has a native 10s limit',async()=>{
  const b=fakeSharp();let loads=0;const reports=[],render=createNativeCardRenderer({loadSharp:async()=>{loads++;return {default:b.sharp}},onMetrics:metrics=>{reports.push(metrics);throw Error('synthetic logger failure')}});
  assert.equal(loads,0);for(let i=0;i<2;i++)assert.ok(Buffer.isBuffer(await render(card())));assert.equal(loads,1);
  assert.deepEqual(b.calls.filter(call=>call[0]==='cache'),[['cache',false]]);assert.deepEqual(b.calls.filter(call=>call[0]==='concurrency'),[['concurrency',1]]);
  const input=b.calls.find(call=>call[0]==='input');assert.equal(Buffer.isBuffer(input[1]),true);assert.deepEqual(input[2],{density:72,limitInputPixels:12000000,failOn:'warning',unlimited:false});
  assert.deepEqual(b.calls.find(call=>call[0]==='timeout')[1],{seconds:10});assert.deepEqual(b.calls.find(call=>call[0]==='toBuffer')[1],{resolveWithObject:true});
  assert.equal(reports.length,2);for(const metrics of reports){assert.deepEqual(Object.keys(metrics),['backend','elapsed','code']);assert.equal(metrics.backend,'sharp');assert.equal(metrics.code,'OK');assert.ok(Number.isFinite(metrics.elapsed)&&metrics.elapsed>=0);assert.equal(Object.isFrozen(metrics),true);assert.doesNotMatch(JSON.stringify(metrics),/PRIVATE|SYNTHETIC|svg|width|file:|http/)}
});

test('trusted local gradients, clipping and XML text escapes are accepted with canonical raster data images',async()=>{
  const b=fakeSharp(),render=createNativeCardRenderer({loadSharp:()=>b.sharp}),jpeg=Buffer.from([255,216,255,192,0,11,8,0,1,0,1,1,1,17,0,255,218,0,8,1,1,0,0,63,0,0,255,217]);
  const body='<defs><linearGradient id="background" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#14313d"/><stop offset="100%" stop-color="#274d50"/></linearGradient><clipPath id="avatar-1"><rect x="10" y="10" width="100" height="100" rx="12"/></clipPath></defs><rect width="1080" height="800" fill="url(#background)"/><g font-family="Noto Sans CJK SC, sans-serif" font-weight="650"><text x="40" y="170">A &amp; B &lt;昵称&gt; &quot;Q&quot; &apos;P&apos;<tspan x="40" dy="40">合成</tspan></text></g>'+image(data(png())).replace('/>',' clip-path="url(#avatar-1)"/>')+image(data(jpeg,'jpeg'));
  assert.ok(Buffer.isBuffer(await render(card(body))));
});

test('unsafe XML, unsupported tags/attributes, entity obfuscation, external references and malformed structures fail before loading sharp',async()=>{
  let loaded=0;const render=createNativeCardRenderer({loadSharp:()=>{loaded++;return fakeSharp().sharp}});
  const bodies=['<script/>','<foreignObject/>','<style>text{fill:red}</style>','<rect onclick="secret()"/>','<rect style="fill:url(https://example.invalid/a)"/>','<image href="https://example.invalid/private.png"/>','<image href="file:///private/account.json"/>','<image href="data:image/svg+xml;base64,PHN2Zy8+"/>','<image href="d&#97;ta:image/png;base64,AAAA"/>','<g xml:base="file:///private/"/>','<use href="#a"/>','<rect fill="url(https://example.invalid/a)"/>','<rect fill="url(#missing)"/>','<defs><clipPath id="a" clip-path="url(#a)"><rect width="1" height="1"/></clipPath></defs>','<defs><linearGradient id="a"/><linearGradient id="a"/></defs>','<text>&secret;</text>','<text>&#x41;</text>','<text>unescaped & value</text>','<g><rect></g>','<svg/>','<rect width="1"width="2"/>','<rect width="1" width="2"/>','<path d="M 0 0 L 1e999 2"/>'];
  for(const body of bodies)await assert.rejects(render(card(body)),error=>error instanceof NativeCardRenderError&&['UNSAFE_NATIVE_SVG','INVALID_NATIVE_IMAGE'].includes(error.code));
  for(const svg of ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///private/">]>'+card().svg,'<?xml version="1.0"?>'+card().svg,card().svg+'<svg/>',card('<text><![CDATA[secret]]></text>').svg,card().svg.replace('xmlns="http://www.w3.org/2000/svg"','xmlns="https://example.invalid/"'),card().svg.replace('viewBox="0 0 1080 800"','viewBox="0 0 99999 800"')])await assert.rejects(render({...card(),svg}),error=>error.code==='UNSAFE_NATIVE_SVG');
  assert.equal(loaded,0);
});

test('SVG size, canvas size, tree depth and node count are bounded before backend allocation',async()=>{
  let loaded=0;const render=createNativeCardRenderer({loadSharp:()=>{loaded++;return fakeSharp().sharp}});
  for(const args of [undefined,null,false,0,'<svg/>',[]])await assert.rejects(render(args),error=>error.code==='INVALID_NATIVE_CARD');
  for(const args of [{...card(),width:319},{...card(),width:1601},{...card(),height:12001},card('',1600,8000),{...card(),width:1080.5},{...card(),private:undefined},{...card(),private:1},{...card(),private:'true'},{...card(),svg:'x'.repeat(4*1024*1024+1)}])await assert.rejects(render(args),error=>error.code==='INVALID_NATIVE_CARD');
  for(const body of ['<g>'.repeat(33)+'</g>'.repeat(33),'<rect/>'.repeat(10001)])await assert.rejects(render(card(body)),error=>error.code==='UNSAFE_NATIVE_SVG');assert.equal(loaded,0);
});

test('embedded rasters require valid magic/CRC/dimensions, canonical base64 and compressed/decoded aggregate limits',async()=>{
  let loaded=0;const render=createNativeCardRenderer({loadSharp:()=>{loaded++;return fakeSharp().sharp}}),valid=png(),bad=Buffer.from(valid);bad[29]^=1;
  const animated=Buffer.concat([valid.subarray(0,-12),chunk('acTL',Buffer.alloc(8)),valid.subarray(-12)]);
  for(const uri of [data(Buffer.from('<html>private</html>')),data(valid,'jpeg'),data(bad),data(animated),data(png(4097,1)),data(png(3000,2000)),data(Buffer.from([255,216,255,217]),'jpeg'),data(valid)+'=',data(valid).replace('base64,','base64,\n'),data(png(1,1,256*1024))])await assert.rejects(render(card(image(uri))),error=>['INVALID_NATIVE_IMAGE','NATIVE_IMAGE_LIMIT'].includes(error.code));
  for(const body of [image(data(valid)).repeat(65),image(data(png(1,1,240000))).repeat(9),image(data(png(4000,1000))).repeat(4)])await assert.rejects(render(card(body)),error=>error.code==='NATIVE_IMAGE_LIMIT');assert.equal(loaded,0);
});

test('backend/import errors and invalid output are sanitized, and asynchronous metrics rejection cannot change rendering',async()=>{
  const unavailable=createNativeCardRenderer({loadSharp:()=>{throw Error('COOKIE=synthetic-secret /private/account.json')}});await assert.rejects(unavailable(card()),error=>error.code==='NATIVE_BACKEND_UNAVAILABLE'&&!/COOKIE|secret|private/.test(error.message));
  const b=fakeSharp({error:Error('UID=synthetic-secret upstream failure')}),render=createNativeCardRenderer({loadSharp:()=>b.sharp,onMetrics:()=>Promise.reject(Error('synthetic log failure'))});await assert.rejects(render(card()),error=>error.code==='NATIVE_RENDER_FAILED'&&!error.message.includes('synthetic'));await flush();
  const oversized=Buffer.alloc(8*1024*1024+1);oversized[0]=255;oversized[1]=216;oversized[oversized.length-2]=255;oversized[oversized.length-1]=217;
  for(const result of [{data:Buffer.from('not a jpeg'),info:{format:'jpeg',width:1080,height:800}},{data:Buffer.from([255,216,255,217]),info:{format:'jpeg',width:1,height:1}},{data:oversized,info:{format:'jpeg',width:1080,height:800}}])await assert.rejects(createNativeCardRenderer({loadSharp:()=>fakeSharp({result}).sharp})(card()),error=>error.code==='INVALID_NATIVE_IMAGE');
});

test('public and private calls require explicit privacy and do not initialize any host, model or storage API',async()=>{
  const b=fakeSharp(),render=createNativeCardRenderer({loadSharp:()=>b.sharp});
  for(const privatePage of [false,true])assert.ok(Buffer.isBuffer(await render({...card(),private:privatePage})));
  assert.equal(getNativeRenderStatus().active,0);assert.equal(getNativeRenderStatus().queued,0);
  assert.equal(Object.isFrozen(getNativeRenderStatus()),true);
  const api=await import('ai-plugin/renderer');assert.equal(api.createNativeCardRenderer,createNativeCardRenderer);
});

test('one active pipeline plus two FIFO waiters are shared across module copies, even after caller deadline wins',async()=>{
  const peer=await import('../src/rendering/native-card-renderer.mjs?peer-copy');
  let finish;const pending=new Promise(resolve=>{finish=resolve}),first=fakeSharp({pending}),second=fakeSharp(),third=fakeSharp(),overflow=fakeSharp();
  const render=createNativeCardRenderer({loadSharp:()=>first.sharp}),other=peer.createNativeCardRenderer({loadSharp:()=>second.sharp}),last=createNativeCardRenderer({loadSharp:()=>third.sharp});
  const order=[],job=render(card()).then(value=>{order.push(1);return value});await flush();
  const next=other({...card(),private:false}).then(value=>{order.push(2);return value}),final=last(card()).then(value=>{order.push(3);return value});
  assert.deepEqual(getNativeRenderStatus(),{active:1,queued:2,maxQueued:2});
  assert.equal(await Promise.race([job.then(()=>false),Promise.resolve(true)]),true);
  assert.deepEqual(peer.getNativeRenderStatus(),{active:1,queued:2,maxQueued:2});
  await assert.rejects(createNativeCardRenderer({loadSharp:()=>overflow.sharp})(card()),error=>error.code==='NATIVE_RENDER_BUSY');
  assert.equal(second.calls.length,0);assert.equal(third.calls.length,0);assert.equal(overflow.calls.length,0);
  finish();for(const bytes of await Promise.all([job,next,final]))assert.ok(Buffer.isBuffer(bytes));
  assert.deepEqual(order,[1,2,3]);assert.deepEqual(getNativeRenderStatus(),{active:0,queued:0,maxQueued:2});
});

test('failed backend and native job release admission only after settlement, then healthy queued work proceeds',async()=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve}),broken=fakeSharp({pending,error:Error('COOKIE=synthetic-private-value')}),healthy=fakeSharp();
  const first=createNativeCardRenderer({loadSharp:()=>broken.sharp})(card());const rejected=assert.rejects(first,error=>error.code==='NATIVE_RENDER_FAILED'&&!error.message.includes('COOKIE'));
  await flush();const next=createNativeCardRenderer({loadSharp:()=>healthy.sharp})({...card(),private:false});
  assert.deepEqual(getNativeRenderStatus(),{active:1,queued:1,maxQueued:2});assert.equal(healthy.calls.length,0);
  finish();await rejected;assert.ok(Buffer.isBuffer(await next));
  let attempts=0;const retry=createNativeCardRenderer({loadSharp:()=>{if(++attempts===1)throw Error('synthetic offline import failure');return healthy.sharp}});
  await assert.rejects(retry(card()),error=>error.code==='NATIVE_BACKEND_UNAVAILABLE');assert.ok(Buffer.isBuffer(await retry(card())));assert.equal(attempts,2);
  for(const version of ['0.34.0','0.35.4',undefined]){
    const backend=fakeSharp({version});if(version===undefined)delete backend.sharp.versions;
    await assert.rejects(createNativeCardRenderer({loadSharp:()=>backend.sharp})(card()),error=>error.code==='NATIVE_BACKEND_UNAVAILABLE');
    assert.equal(backend.calls.length,0);
  }
  assert.equal(getNativeRenderStatus().active,0);
});

test('real pinned sharp converts synthetic public and private SVG to exact JPEG Buffers without browser or files',{skip:!installedSharp},async()=>{
  const sharp=installedSharp,render=createNativeCardRenderer({loadSharp:()=>sharp});
  for(const privatePage of [false,true]){
    const bytes=await render({...card('<rect width="320" height="100" fill="#14313d"/><text x="12" y="55" fill="#ffffff" font-size="26">SYNTHETIC QA</text>',320,100),private:privatePage}),metadata=await sharp(bytes).metadata();
    assert.equal(metadata.format,'jpeg');assert.equal(metadata.width,320);assert.equal(metadata.height,100);
  }
});

test('shared entry and renderer sources cannot perform IO, browser launches, model calls or config reads',()=>{
  for(const file of ['index.mjs','native-card-renderer.mjs']){
    const source=fs.readFileSync(new URL('../src/rendering/'+file,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\b(?:fetch|readFile|writeFile|createWriteStream|toFile|launch)\s*\(/);
    assert.doesNotMatch(source,/from ['"](?:node:fs|puppeteer|.*(?:config|storage|client))/);
  }
});
