// Public, source-defined help only. Offline builders return safe SVG cards;
// online readers only read verified, prebuilt JPEGs and never render on demand.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';

const WIDTH=1080,MAX_HEIGHT=2200,MAX_PAGES=8,MAX_ITEMS=192;
const FONT='Noto Sans CJK SC, Microsoft YaHei, sans-serif';
const HASH=/^[a-f0-9]{64}$/,TOPIC=/^[a-z][a-z0-9-]{0,39}$/;
const MAX_MANIFEST=128*1024,MAX_SOURCE=1024*1024,MAX_IMAGE=2*1024*1024,MAX_CACHE=16*1024*1024;
const THEMES={
  dark:{base:'#102834',surface:'#1b3946',surfaceAlt:'#21424d',stroke:'#385863',text:'#f6f2e7',muted:'#b2c5cd',accent:'#e7c47b',soft:'#234957',badge:'#314e57'},
  light:{base:'#edf2f3',surface:'#ffffff',surfaceAlt:'#f7f9f8',stroke:'#d3dfe0',text:'#183642',muted:'#526f7a',accent:'#9c702d',soft:'#e2ecec',badge:'#e9e1d2'}
};
const escape=value=>value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&apos;');
const plain=value=>value&&typeof value==='object'&&!Array.isArray(value)&&Object.getPrototypeOf(value)===Object.prototype;
const ownKeys=(value,allowed)=>Object.keys(value).every(key=>allowed.includes(key));
const invalid=()=>{throw new TypeError('Invalid public help content')};
function text(value,max,optional=false){
  if(optional&&value===undefined)return '';
  if(typeof value!=='string'||(!optional&&!value.trim())||Array.from(value).length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value))invalid();
  return value.replace(/\r\n?/g,'\n').trim();
}
const characterWidth=(value,size)=>/\s/u.test(value)?size*.32:/[WMwm@]/.test(value)?size*.94:/[A-Z]/.test(value)?size*.72:/[a-z0-9#._/:[\](){}+\-=]/.test(value)?size*.60:size;
function wrap(value,width,size){
  const lines=[];
  for(const paragraph of value.split('\n')){
    let current='',used=0;
    for(const character of paragraph){const advance=characterWidth(character,size);if(current&&used+advance>width){lines.push(current.trimEnd());current='';used=0}current+=character;used+=advance}
    lines.push(current.trimEnd());
  }
  return lines.length?lines:[''];
}
const label=(value,x,y,size,fill,weight=400)=>`<text x="${x}" y="${y}" fill="${fill}" font-size="${size}" font-weight="${weight}">${escape(value)}</text>`;
function itemLayout(item){
  if(!plain(item)||!ownKeys(item,['command','description','permission']))invalid();
  const command=text(item.command,200),description=text(item.description,400,true),permission=text(item.permission,36,true);
  const commandLines=wrap(command,420,26),descriptionLines=description?wrap(description,420,21):[];
  const permissionLines=permission?wrap(permission,420,18):[];
  return {commandLines,descriptionLines,permissionLines,height:commandLines.length*34+descriptionLines.length*29+permissionLines.length*25+22};
}
function splitGroups(groups,maxGroupHeight){
  let itemCount=0;const result=[];
  for(const group of groups){
    if(!plain(group)||!ownKeys(group,['title','items'])||!Array.isArray(group.items)||!group.items.length||group.items.length>MAX_ITEMS)invalid();
    const title=text(group.title,60),items=group.items.map(itemLayout);itemCount+=items.length;if(itemCount>MAX_ITEMS)invalid();
    let chunk=[],height=0,part=0;
    const assemble=()=>{const titleLines=wrap(title+(part?' · 续':''),412,28);return {titleLines,items:chunk,height:height+98+(titleLines.length-1)*36}};
    for(const item of items){
      if(item.height+98+(wrap(title+' · 续',412,28).length-1)*36>maxGroupHeight)invalid();
      if(chunk.length&&assemble().height+item.height>maxGroupHeight){result.push(assemble());part++;chunk=[];height=0}
      chunk.push(item);height+=item.height;
    }
    if(chunk.length)result.push(assemble());
  }
  return result;
}
function renderGroup(group,x,y,palette){
  const headingDelta=(group.titleLines.length-1)*36;
  const output=[`<rect x="${x}" y="${y}" width="488" height="${group.height}" rx="22" fill="${palette.surface}" stroke="${palette.stroke}"/>`,
    `<rect x="${x+24}" y="${y+25}" width="5" height="28" rx="2" fill="${palette.accent}"/>`,
    ...group.titleLines.map((line,index)=>label(line,x+42,y+48+index*36,28,palette.accent,700)),
    `<line x1="${x+24}" y1="${y+69+headingDelta}" x2="${x+464}" y2="${y+69+headingDelta}" stroke="${palette.stroke}"/>`];
  let cursor=y+103+headingDelta;
  for(const [index,item] of group.items.entries()){
    if(index)output.push(`<line x1="${x+26}" y1="${cursor-20}" x2="${x+462}" y2="${cursor-20}" stroke="${palette.stroke}" opacity="0.6"/>`);
    for(const line of item.commandLines){output.push(label(line,x+28,cursor,26,palette.text,650));cursor+=34}
    for(const line of item.descriptionLines){output.push(label(line,x+28,cursor-1,21,palette.muted));cursor+=29}
    for(const line of item.permissionLines){output.push(label(line,x+28,cursor-1,18,palette.accent,500));cursor+=25}
    cursor+=22;
  }
  return output.join('');
}

/** Use only public command descriptions from trusted plugin source. No account,
 * context, arbitrary SVG, images, styles or network/font input is accepted. */
export function buildStaticHelpCards(input){
  if(!plain(input)||!ownKeys(input,['title','subtitle','groups','footer','theme'])||!Array.isArray(input.groups)||!input.groups.length||input.groups.length>32)invalid();
  const title=text(input.title,80),subtitle=text(input.subtitle,180,true),footer=text(input.footer,240,true),theme=input.theme??'dark';
  if(typeof theme!=='string'||!Object.hasOwn(THEMES,theme))invalid();
  const palette=THEMES[theme],titleLines=wrap(title,820,46),subtitleLines=subtitle?wrap(subtitle,970,23):[],footerLines=footer?wrap(footer,970,20):[];
  const header=76+titleLines.length*58+subtitleLines.length*34+35,footerHeight=footerLines.length*29+86;
  if(header+footerHeight>1200)invalid();
  const segments=splitGroups(input.groups,Math.min(1538,MAX_HEIGHT-header-footerHeight-24)),pages=[];let current=[],columns=[header,header];
  for(const group of segments){
    let column=columns[0]<=columns[1]?0:1;
    if(columns[column]+group.height+footerHeight>MAX_HEIGHT){
      pages.push({groups:current,height:Math.max(...columns)+footerHeight});current=[];columns=[header,header];column=0;
      if(pages.length>=MAX_PAGES)throw new RangeError('Public help exceeds eight pages');
    }
    if(columns[column]+group.height+footerHeight>MAX_HEIGHT)invalid();
    current.push({group,x:40+column*512,y:columns[column]});columns[column]+=group.height+24;
  }
  if(current.length)pages.push({groups:current,height:Math.max(...columns)+footerHeight});
  return pages.map((page,index)=>{
    const height=Math.max(400,Math.ceil(page.height)),output=[`<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}">`,
      `<defs><linearGradient id="help-background" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${palette.base}"/><stop offset="100%" stop-color="${palette.surfaceAlt}"/></linearGradient></defs>`,
      `<rect width="1080" height="${height}" rx="30" fill="url(#help-background)"/>`,
      `<path d="M 845 0 L 1080 0 L 1080 235 Z" fill="${palette.soft}" opacity="0.75"/>`,
      `<rect x="40" y="38" width="68" height="30" rx="10" fill="${palette.badge}"/>`,
      `<g font-family="${FONT}">`,label('GUIDE',52,60,16,palette.accent,700),label(`COMMAND DIRECTORY${pages.length>1?'   '+(index+1)+' / '+pages.length:''}`,124,60,16,palette.muted,500)];
    let y=117;for(const line of titleLines){output.push(label(line,40,y,46,palette.text,750));y+=58}
    for(const line of subtitleLines){output.push(label(line,42,y-6,23,palette.muted));y+=34}
    for(const item of page.groups)output.push(renderGroup(item.group,item.x,item.y,palette));
    const footerY=height-footerHeight+13;
    output.push(`<line x1="42" y1="${footerY}" x2="1038" y2="${footerY}" stroke="${palette.stroke}"/>`);
    for(const [lineIndex,line] of footerLines.entries())output.push(label(line,42,footerY+36+lineIndex*29,20,palette.muted));
    output.push(label('HELP · 随时查阅，按需使用',42,height-27,16,palette.accent,500),label(`${index+1} / ${pages.length}`,1000,height-27,16,palette.muted,500),'</g></svg>');
    return {svg:output.join(''),width:WIDTH,height,private:false};
  });
}

const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
/** Manifest source hash: strict UTF-8, optional BOM removed, all newlines LF.
 * Image hashes always use original JPEG bytes, never this source algorithm. */
export function hashStaticHelpSource(input){
  if(typeof input!=='string'&&!Buffer.isBuffer(input)&&!(input instanceof Uint8Array))throw new TypeError('Invalid public help source');
  let source=typeof input==='string'?input:new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(input);
  source=source.replace(/^\ufeff/,'').replace(/\r\n?/g,'\n');return digest(Buffer.from(source,'utf8'));
}
const fingerprint=stat=>[stat.dev,stat.ino,stat.mode,stat.nlink,stat.size,stat.mtimeNs,stat.ctimeNs].join(':');
function ordinary(file,maxBytes){
  let result;
  for(let current=file;;){
    const stat=fs.lstatSync(current,{bigint:true});
    if(stat.isSymbolicLink()||(current===file?(!stat.isFile()||stat.nlink!==1n||stat.size<1n||stat.size>BigInt(maxBytes)):!stat.isDirectory()))throw Error('INVALID_PUBLIC_HELP_FILE');
    if(current===file)result=stat;
    const parent=path.dirname(current);if(parent===current)break;current=parent;
  }
  return result;
}
function readOrdinary(file,maxBytes){
  const before=ordinary(file,maxBytes);let fd;
  try{
    fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));const opened=fs.fstatSync(fd,{bigint:true});
    if(!opened.isFile()||opened.nlink!==1n||fingerprint(opened)!==fingerprint(before))throw Error('PUBLIC_HELP_FILE_CHANGED');
    const bytes=Buffer.alloc(Number(opened.size));let offset=0;
    while(offset<bytes.length){const count=fs.readSync(fd,bytes,offset,bytes.length-offset,offset);if(!count)throw Error('PUBLIC_HELP_FILE_CHANGED');offset+=count}
    if(fingerprint(fs.fstatSync(fd,{bigint:true}))!==fingerprint(opened)||fingerprint(ordinary(file,maxBytes))!==fingerprint(opened))throw Error('PUBLIC_HELP_FILE_CHANGED');
    return {bytes,fingerprint:fingerprint(opened)};
  }finally{if(fd!==undefined)fs.closeSync(fd)}
}
function relativeSource(value){
  if(typeof value!=='string'||value.length>160||value.includes('\\')||! /^[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(part=>!part||part.startsWith('.')||/^(?:config|data|private|secrets|accounts|credentials|backups|node_modules)$/i.test(part)))return false;
  return /^(?:index\.js|api\.mjs|help-content\.mjs|package\.json|README\.md)$/.test(value)||/^(?:lib|src|integrations|yunzai)\/(?:[A-Za-z0-9_-]+\/)*[A-Za-z0-9_-]+\.(?:mjs|js|md)$/.test(value);
}
function jpegDimensions(bytes){
  if(bytes.length<16||bytes[0]!==255||bytes[1]!==216||bytes.at(-2)!==255||bytes.at(-1)!==217)return null;
  let offset=2,dimensions=null;
  while(offset<bytes.length-2){
    if(bytes[offset++]!==255)return null;while(bytes[offset]===255)offset++;
    const marker=bytes[offset++];if(marker===0xda)return dimensions;
    if(marker===0||marker===0xd8||marker===0xd9||marker>=0xd0&&marker<=0xd7||offset+2>bytes.length)return null;
    const size=bytes.readUInt16BE(offset);if(size<2||offset+size>bytes.length)return null;
    if([0xc0,0xc1,0xc2].includes(marker)){
      if(dimensions||size<8||bytes[offset+2]!==8)return null;
      const components=bytes[offset+7];if(![1,3,4].includes(components)||size!==8+3*components)return null;
      dimensions={height:bytes.readUInt16BE(offset+3),width:bytes.readUInt16BE(offset+5)};
    }
    offset+=size;
  }
  return null;
}
function validateManifest(manifest,defaultPrefix){
  if(!plain(manifest)||!ownKeys(manifest,['version','hashAlgorithm','prefix','cards','sources'])||manifest.version!==1||manifest.hashAlgorithm!=='sha256-lf-v1'||!plain(manifest.cards)||!Array.isArray(manifest.sources)||!manifest.sources.length||manifest.sources.length>16)throw Error('INVALID_PUBLIC_HELP_MANIFEST');
  if(manifest.prefix!==undefined&&(typeof manifest.prefix!=='string'||!manifest.prefix||manifest.prefix.length>64||/[\u0000-\u001f\u007f]/.test(manifest.prefix)))throw Error('INVALID_PUBLIC_HELP_MANIFEST');
  if(defaultPrefix!==undefined&&manifest.prefix!==defaultPrefix)throw Error('PUBLIC_HELP_PREFIX_CHANGED');
  const topics=Object.keys(manifest.cards);if(!topics.length||topics.length>32)throw Error('INVALID_PUBLIC_HELP_MANIFEST');
  for(const topic of topics){
    const cards=manifest.cards[topic];if(!TOPIC.test(topic)||!Array.isArray(cards)||!cards.length||cards.length>MAX_PAGES)throw Error('INVALID_PUBLIC_HELP_MANIFEST');
    for(const [index,card] of cards.entries())if(!plain(card)||!ownKeys(card,['file','sha256','width','height'])||card.file!==`resources/help/${topic}-${index+1}.jpg`||!HASH.test(card.sha256)||card.width!==WIDTH||!Number.isSafeInteger(card.height)||card.height<100||card.height>MAX_HEIGHT)throw Error('INVALID_PUBLIC_HELP_MANIFEST');
  }
  const seen=new Set();for(const source of manifest.sources){if(!plain(source)||!ownKeys(source,['file','sha256'])||!relativeSource(source.file)||!HASH.test(source.sha256)||seen.has(source.file))throw Error('INVALID_PUBLIC_HELP_MANIFEST');seen.add(source.file)}
}

/** Synchronous request-time reader. Only predefined topics and fixed public
 * files are allowed. No rendering, writes, browser, account or network APIs.
 * Every read checks the complete path chain; changed files are rehashed. */
export function createStaticHelpReader(options={}){
  let root,manifestRelative,defaultPrefix,configured=false;
  try{
    if(!plain(options)||!ownKeys(options,['root','defaultPrefix','manifestFile'])||typeof options.root!=='string'||!options.root)throw Error();
    root=path.resolve(options.root);manifestRelative=options.manifestFile??'resources/help/manifest.json';defaultPrefix=options.defaultPrefix;
    configured=/^resources\/help\/[a-z][a-z0-9-]{0,48}\.json$/.test(manifestRelative)&&(defaultPrefix===undefined||typeof defaultPrefix==='string'&&defaultPrefix.length>0&&defaultPrefix.length<=64&&!/[\u0000-\u001f\u007f]/.test(defaultPrefix));
  }catch{}
  const sourceCache=new Map(),imageCache=new Map();let cacheBytes=0;
  return function readStaticHelp(request={}){
    try{
      if(!configured||!plain(request)||!ownKeys(request,['topic','private','prefix'])||request.private!==false||typeof request.topic!=='string'||!TOPIC.test(request.topic))return null;
      const manifestPath=path.join(root,manifestRelative),manifestRead=readOrdinary(manifestPath,MAX_MANIFEST),manifest=JSON.parse(manifestRead.bytes.toString('utf8'));
      validateManifest(manifest,defaultPrefix);
      const expectedPrefix=defaultPrefix??manifest.prefix;if(request.prefix!==undefined&&request.prefix!==expectedPrefix||!Object.hasOwn(manifest.cards,request.topic))return null;
      const sources=[];let sourceBytes=0;
      for(const source of manifest.sources){
        const file=path.join(root,source.file),stat=ordinary(file,MAX_SOURCE),token=fingerprint(stat);sourceBytes+=Number(stat.size);if(sourceBytes>4*MAX_SOURCE)throw Error('PUBLIC_HELP_SOURCE_LIMIT');
        let cached=sourceCache.get(source.file);
        if(cached?.fingerprint!==token){const read=readOrdinary(file,MAX_SOURCE);cached={fingerprint:read.fingerprint,sha256:hashStaticHelpSource(read.bytes)};sourceCache.set(source.file,cached)}
        if(cached.sha256!==source.sha256)throw Error('PUBLIC_HELP_SOURCE_CHANGED');
        sources.push({file,fingerprint:cached.fingerprint});
      }
      const sourceNames=new Set(manifest.sources.map(source=>source.file));for(const name of sourceCache.keys())if(!sourceNames.has(name))sourceCache.delete(name);
      const cards=manifest.cards[request.topic],images=cards.map(card=>({card,file:path.join(root,card.file)}));
      for(const image of images)image.fingerprint=fingerprint(ordinary(image.file,MAX_IMAGE));
      const token=[digest(manifestRead.bytes),manifestRead.fingerprint,...sources.map(source=>source.fingerprint),...images.map(image=>image.fingerprint)].join(':');
      let cached=imageCache.get(request.topic);
      if(cached?.token!==token){
        const bytes=images.map(image=>{
          const read=readOrdinary(image.file,MAX_IMAGE),dimensions=jpegDimensions(read.bytes);
          if(read.fingerprint!==image.fingerprint||digest(read.bytes)!==image.card.sha256||dimensions?.width!==image.card.width||dimensions?.height!==image.card.height)throw Error('INVALID_PUBLIC_HELP_IMAGE');
          return read.bytes;
        });
        if(cached){cacheBytes-=cached.size;imageCache.delete(request.topic)}
        const size=bytes.reduce((sum,value)=>sum+value.length,0);cached={token,bytes,size};
        while((cacheBytes+size>MAX_CACHE||imageCache.size>=32)&&imageCache.size){const [key,entry]=imageCache.entries().next().value;imageCache.delete(key);cacheBytes-=entry.size}
        imageCache.set(request.topic,cached);cacheBytes+=size;
      }
      if(fingerprint(ordinary(manifestPath,MAX_MANIFEST))!==manifestRead.fingerprint||sources.some(source=>fingerprint(ordinary(source.file,MAX_SOURCE))!==source.fingerprint)||images.some(image=>fingerprint(ordinary(image.file,MAX_IMAGE))!==image.fingerprint))throw Error('PUBLIC_HELP_FILE_CHANGED');
      return cached.bytes.map(bytes=>Buffer.from(bytes));
    }catch{sourceCache.clear();imageCache.clear();cacheBytes=0;return null}
  };
}
