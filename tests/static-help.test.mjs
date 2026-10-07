import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {buildStaticHelpCards,createStaticHelpReader,hashStaticHelpSource,createNativeCardRenderer} from '../src/rendering/index.mjs';

const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const content={title:'群管 · GroupGuard',subtitle:'常用操作与权限，一张图快速查阅',groups:[
  {title:'查看与帮助',items:[{command:'#群管帮助',description:'查看公开指令说明'},{command:'#群管状态 / #群管版本',description:'检查当前群设置与版本'}]},
  {title:'群成员管理',items:[{command:'禁言 @成员 [10分钟] / 解禁 @成员',description:'使用时请留意成员与时长',permission:'需要群管理员权限'}]}
],footer:'固定帮助图片由插件源码生成；修改说明后重新离线构建。'};
function jpeg(width=1080,height=400){
  const frame=Buffer.from([255,192,0,11,8,0,0,0,0,1,1,17,0]);frame.writeUInt16BE(height,5);frame.writeUInt16BE(width,7);
  return Buffer.concat([Buffer.from([255,216]),frame,Buffer.from([255,218,0,8,1,1,0,0,63,0,0,255,217])]);
}
function fixture(t,{sources=['lib/help-content.mjs'],prefix='#群管',topics=['help']}={}){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-static-help-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,'resources/help'),{recursive:true});const sourceFiles=[];
  for(const file of sources){fs.mkdirSync(path.dirname(path.join(root,file)),{recursive:true});const bytes=Buffer.from('export const help = "SYNTHETIC PUBLIC";\n');fs.writeFileSync(path.join(root,file),bytes);sourceFiles.push({file,sha256:hashStaticHelpSource(bytes)})}
  const manifest={version:1,hashAlgorithm:'sha256-lf-v1',prefix,cards:{},sources:sourceFiles};
  for(const topic of topics){const file=`resources/help/${topic}-1.jpg`,bytes=jpeg();fs.writeFileSync(path.join(root,file),bytes);manifest.cards[topic]=[{file,sha256:hash(bytes),width:1080,height:400}]}
  const manifestPath=path.join(root,'resources/help/manifest.json');const write=()=>fs.writeFileSync(manifestPath,JSON.stringify(manifest));write();
  return {root,manifest,manifestPath,write,read:createStaticHelpReader({root,defaultPrefix:prefix}),request:{topic:'help',private:false,prefix}};
}
function fakeSharp(){
  const sharp=input=>({jpeg(){return this},timeout(){return this},async toBuffer(){const svg=input.toString(),width=Number(/width="(\d+)"/.exec(svg)[1]),height=Number(/height="(\d+)"/.exec(svg)[1]);return {data:jpeg(width,height),info:{format:'jpeg',width,height}}}});
  sharp.versions={sharp:'0.35.5'};sharp.cache=()=>{};sharp.concurrency=()=>{};return sharp;
}

test('source-defined help builds readable public cards accepted by the strict native renderer',async()=>{
  const cards=buildStaticHelpCards(content),render=createNativeCardRenderer({loadSharp:()=>fakeSharp()});
  assert.equal(cards.length,1);
  for(const card of cards){assert.equal(card.width,1080);assert.ok(card.height>=400&&card.height<=2200);assert.equal(card.private,false);assert.match(card.svg,/font-size="26"/);assert.match(card.svg,/#群管帮助/);assert.match(card.svg,/需要群管理员权限/);assert.ok(Buffer.isBuffer(await render(card)))}
});

test('builder escapes untrusted-looking text as literal XML and accepts no account, raster, style or arbitrary SVG fields',async()=>{
  const cards=buildStaticHelpCards({...content,title:'<svg> & "Help"',groups:[{title:'<script>',items:[{command:'#help <img> & \'text\'',description:'Literal <foreignObject> example'}]}]});
  assert.match(cards[0].svg,/&lt;svg&gt; &amp; &quot;Help&quot;/);assert.doesNotMatch(cards[0].svg,/<script>|<foreignObject>|<image /);
  await createNativeCardRenderer({loadSharp:()=>fakeSharp()})(cards[0]);
  for(const extra of [{private:true},{account:{token:'synthetic'}},{images:[]},{svg:'<svg/>'},{theme:{background:'url(http://example.invalid)'}}])assert.throws(()=>buildStaticHelpCards({...content,...extra}),/Invalid public help/);
  for(const malformed of [null,[],{...content,groups:[]},{...content,title:'x\u0000'},{...content,groups:[{title:'x',items:[{command:'#help',session:'synthetic'}]}]},{...content,groups:[{title:'x',items:[{command:'#help',description:'\u202e'}]}]}])assert.throws(()=>buildStaticHelpCards(malformed),/Invalid public help/);
});

test('long help wraps descriptions and paginates without dropping commands, and excessive input is bounded',async()=>{
  const items=Array.from({length:100},(_,index)=>({command:`#synthetic-${index+1}`,description:'清晰的公开说明，支持自动换行。'.repeat(3)}));
  const cards=buildStaticHelpCards({...content,groups:[{title:'所有公开说明',items}]});assert.ok(cards.length>1&&cards.length<=8);
  const svg=cards.map(card=>card.svg).join('');
  for(const item of items)assert.equal(svg.split(`>${item.command}</text>`).length-1,1);
  for(const card of cards){assert.equal(card.private,false);assert.ok(card.width*card.height<=12000000);assert.ok(card.height<=2200)}
  await Promise.all(cards.slice(0,3).map(card=>createNativeCardRenderer({loadSharp:()=>fakeSharp()})(card)));
  const longHead=buildStaticHelpCards({...content,title:'公开帮助'.repeat(20),subtitle:'公开说明'.repeat(40),footer:'固定说明'.repeat(60),groups:[{title:'很长的分组名称需要自动换行'.repeat(4),items:[{command:'#'+'W'.repeat(100),description:'说明'.repeat(100)}]}]});
  for(const page of longHead)await createNativeCardRenderer({loadSharp:()=>fakeSharp()})(page);
  assert.match(longHead[0].svg,/公开帮助/);assert.ok((longHead[0].svg.match(/font-size="28"/g)||[]).length>1);
  assert.throws(()=>buildStaticHelpCards({...content,groups:[{title:'too long',items:Array.from({length:193},()=>({command:'#help'}))}]}),/Invalid public help/);
  assert.throws(()=>buildStaticHelpCards({...content,groups:[{title:'too many pages',items:Array.from({length:192},()=>({command:'#long-command '.repeat(8),description:'较长的说明。'.repeat(40)}))}]}),/eight pages/);
});

test('source hashes have one explicit cross-platform UTF-8 and LF algorithm',()=>{
  const lf='const title = "公开说明";\nconst enabled = true;\n';
  for(const source of [lf,lf.replace(/\n/g,'\r\n'),lf.replace(/\n/g,'\r'),'\ufeff'+lf,Buffer.from('\ufeff'+lf.replace(/\n/g,'\r\n'))])assert.equal(hashStaticHelpSource(source),hash(Buffer.from(lf)));
  assert.throws(()=>hashStaticHelpSource(Buffer.from([0xc0,0xaf])));assert.throws(()=>hashStaticHelpSource({private:true}));
});

test('flattened adapter can reference only the explicitly allowed root help-content.mjs',t=>{
  const f=fixture(t,{sources:['help-content.mjs']});assert.equal(f.read(f.request).length,1);
  f.manifest.sources[0].file='local.mjs';f.write();assert.equal(f.read(f.request),null);
});

test('fixed topics read verified JPEGs, cached buffers are isolated, and unchanged images are not reopened',t=>{
  const f=fixture(t),originalOpen=fs.openSync,opens=[];fs.openSync=function(file,...args){opens.push(String(file));return originalOpen.call(this,file,...args)};t.after(()=>{fs.openSync=originalOpen});
  const first=f.read(f.request);assert.equal(first.length,1);assert.ok(Buffer.isBuffer(first[0]));first[0][0]=0;
  const second=f.read(f.request);assert.equal(second[0][0],255);
  assert.equal(opens.filter(file=>file.endsWith('help-1.jpg')).length,1);assert.equal(opens.filter(file=>file.endsWith('help-content.mjs')).length,1);assert.equal(opens.filter(file=>file.endsWith('manifest.json')).length,2);
  for(const request of [{topic:'help',private:true},{topic:'help'},{topic:'help',private:false,prefix:'#other'},{topic:'../help',private:false},{topic:'unknown',private:false},{topic:'help',private:false,account:'synthetic'}])assert.equal(f.read(request),null);
});

test('source or image changes invalidate cache, while CRLF-only source changes remain valid by the declared algorithm',t=>{
  const f=fixture(t);assert.equal(f.read(f.request).length,1);const source=path.join(f.root,'lib/help-content.mjs');
  fs.writeFileSync(source,'export const help = "SYNTHETIC PUBLIC";\r\n');assert.equal(f.read(f.request).length,1);
  fs.writeFileSync(source,'export const help = "CHANGED PUBLIC COMMAND";\n');assert.equal(f.read(f.request),null);
  f.manifest.sources[0].sha256=hashStaticHelpSource(fs.readFileSync(source));f.write();assert.equal(f.read(f.request).length,1);
  const image=path.join(f.root,'resources/help/help-1.jpg'),changed=jpeg(1080,401);fs.writeFileSync(image,changed);assert.equal(f.read(f.request),null);
  f.manifest.cards.help[0].sha256=hash(changed);f.manifest.cards.help[0].height=401;f.write();assert.equal(f.read(f.request).length,1);
});

test('manifest paths, dimensions, privacy, algorithms and unexpected keys fail closed',t=>{
  const cases=[
    manifest=>manifest.sources[0].file='data/accounts.json',manifest=>manifest.sources[0].file='../help.mjs',manifest=>manifest.sources[0].file='lib/../config/local.json',manifest=>manifest.sources[0].file='lib\\help.mjs',
    manifest=>manifest.cards.help[0].file='resources/help/other-1.jpg',manifest=>manifest.cards.help[0].file='/absolute/help.jpg',manifest=>manifest.cards.help[0].height=9999,manifest=>manifest.cards.help[0].width=999,
    manifest=>manifest.hashAlgorithm='sha256',manifest=>manifest.prefix='#changed',manifest=>manifest.sources=[],manifest=>manifest.cards.help[0].private=true,manifest=>manifest.session='synthetic',manifest=>manifest.sources.push(manifest.sources[0])
  ];
  for(const mutate of cases){const f=fixture(t);mutate(f.manifest);f.write();assert.equal(f.read(f.request),null)}
  const f=fixture(t);for(const options of [{root:f.root,manifestFile:'../manifest.json'},{root:f.root,manifestFile:'config/local.json'},{root:f.root,manifestFile:'resources/help/manifest.json',private:true},{root:'',defaultPrefix:'#help'}])assert.equal(createStaticHelpReader(options)(f.request),null);
});

test('single-link ordinary file checks reject hardlinks for images, source and manifest',t=>{
  for(const relative of ['resources/help/help-1.jpg','lib/help-content.mjs','resources/help/manifest.json']){
    const f=fixture(t);assert.equal(f.read(f.request).length,1);
    fs.linkSync(path.join(f.root,relative),path.join(f.root,'extra-hardlink'));assert.equal(f.read(f.request),null);
  }
});

test('Windows unavailable path-device sentinel is compatible without relaxing other cross-API identity fields',t=>{
  const f=fixture(t),originalLstat=fs.lstatSync,originalFstat=fs.fstatSync;
  const target=f.manifestPath;
  try{
    fs.lstatSync=function(file,...args){const value=originalLstat.call(this,file,...args);if(String(file)===target)value.dev=0n;return value};
    const read=createStaticHelpReader({root:f.root,defaultPrefix:'#群管'});
    assert.equal(Boolean(read(f.request)?.length),process.platform==='win32');
    for(const field of ['ino','mode','nlink','size','mtimeNs','ctimeNs']){
      fs.fstatSync=function(fd,...args){const value=originalFstat.call(this,fd,...args);value[field]+=1n;return value};
      assert.equal(createStaticHelpReader({root:f.root,defaultPrefix:'#群管'})(f.request),null);
    }
    fs.fstatSync=originalFstat;
    const fd=fs.openSync(target,fs.constants.O_RDONLY),otherDevice=originalFstat(fd,{bigint:true}).dev+1n;fs.closeSync(fd);
    fs.lstatSync=function(file,...args){const value=originalLstat.call(this,file,...args);if(String(file)===target)value.dev=otherDevice;return value};
    assert.equal(createStaticHelpReader({root:f.root,defaultPrefix:'#群管'})(f.request),null);
  }finally{fs.lstatSync=originalLstat;fs.fstatSync=originalFstat}
});

test('path and descriptor identity/time changes during a read still fail closed independently',t=>{
  const originalLstat=fs.lstatSync,originalFstat=fs.fstatSync;
  try{
    for(const side of ['path','descriptor'])for(const field of ['dev','ino','mode','nlink','size','mtimeNs','ctimeNs']){
      const f=fixture(t);let pathCalls=0,descriptorCalls=0;
      fs.lstatSync=function(file,...args){
        const value=originalLstat.call(this,file,...args);
        if(String(file)===f.manifestPath&&++pathCalls>1&&side==='path')value[field]+=1n;
        return value;
      };
      fs.fstatSync=function(fd,...args){
        const value=originalFstat.call(this,fd,...args);
        if(++descriptorCalls>1&&side==='descriptor')value[field]+=1n;
        return value;
      };
      assert.equal(f.read(f.request),null);
      fs.lstatSync=originalLstat;fs.fstatSync=originalFstat;
    }
  }finally{fs.lstatSync=originalLstat;fs.fstatSync=originalFstat}
});

test('full-chain checks reject a symbolic directory inside the root',{skip:process.platform==='win32'&&process.env.AI_TEST_SYMLINKS!=='1'},t=>{
  const f=fixture(t),resources=path.join(f.root,'resources'),moved=path.join(f.root,'real-resources');assert.equal(f.read(f.request).length,1);
  fs.renameSync(resources,moved);fs.symlinkSync(moved,resources,'dir');assert.equal(f.read(f.request),null);
});

test('mismatched hashes, oversized files and invalid JPEG framing are rejected without a decoder',t=>{
  for(const bytes of [Buffer.from('<html>PUBLIC</html>'),Buffer.from([255,216,255,217]),Buffer.alloc(2*1024*1024+1)]){
    const f=fixture(t);fs.writeFileSync(path.join(f.root,'resources/help/help-1.jpg'),bytes);f.manifest.cards.help[0].sha256=hash(bytes);f.write();assert.equal(f.read(f.request),null);
  }
  const f=fixture(t);f.manifest.cards.help[0].sha256='0'.repeat(64);f.write();assert.equal(f.read(f.request),null);
});

test('static module has no network, model, browser, process launch or on-demand rendering path',()=>{
  const source=fs.readFileSync(new URL('../src/rendering/static-help.mjs',import.meta.url),'utf8');
  assert.doesNotMatch(source,/\b(?:fetch|writeFile|createWriteStream|launch|exec|spawn|createNativeCardRenderer)\s*\(/);
  assert.doesNotMatch(source,/from ['"](?:puppeteer|playwright|node:child_process|.*(?:config|storage|client))/);
});

let installedSharp;
try{installedSharp=(await import(process.env.AI_RENDERER_TEST_SHARP?pathToFileURL(process.env.AI_RENDERER_TEST_SHARP).href:'sharp')).default}catch(error){if(process.env.AI_RENDERER_TEST_SHARP)throw error}
test('real pinned backend renders both help themes and reader validates the generated JPEG',{skip:!installedSharp},async t=>{
  const sharp=installedSharp,render=createNativeCardRenderer({loadSharp:()=>sharp});
  for(const theme of ['dark','light']){
    const f=fixture(t),card=buildStaticHelpCards({...content,theme})[0],image=await render(card),meta=await sharp(image).metadata();
    assert.equal(meta.width,1080);assert.equal(meta.height,card.height);assert.equal(meta.format,'jpeg');
    fs.writeFileSync(path.join(f.root,'resources/help/help-1.jpg'),image);Object.assign(f.manifest.cards.help[0],{height:card.height,sha256:hash(image)});f.write();assert.ok(f.read(f.request)[0].equals(image));
  }
});
