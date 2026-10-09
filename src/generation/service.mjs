import {randomInt} from 'node:crypto'
import {publicImageUrl} from '../media/remote.mjs'

const DEFAULTS={enabled:false,endpoint:'',token:'',timeoutMs:180000,maxImageBytes:10485760,maxVideoBytes:52428800,maxPromptCharacters:2000,defaultModel:'flux',defaultDuration:3,defaultEffects:true,subtitles:true}
const IMAGE_EXTENSIONS={ 'image/png':'png','image/jpeg':'jpg','image/webp':'webp','image/gif':'gif' }
const IMAGE_SUFFIXES=['png','jpg','jpeg','webp','gif']
const MAX_SEED=2147483647

export class GenerationError extends Error {
  constructor(code,message){super(message);this.name='GenerationError';this.code=code;this.recoverable=true}
}
const failure=(code,message)=>new GenerationError(code,message)
const cancelled=signal=>signal?.reason?.name==='TimeoutError'?failure('GENERATION_TIMEOUT','图片或视频生成等待超时，请稍后重试。'):failure('GENERATION_ABORTED','图片或视频生成已取消。')
function check(signal){if(signal.aborted)throw cancelled(signal)}
function cancelBody(body){try{void body?.cancel().catch(()=>{})}catch{}}
async function abortable(operation,signal){
  check(signal);let cancel
  const interrupted=new Promise((_,reject)=>{cancel=()=>reject(cancelled(signal));signal.addEventListener('abort',cancel,{once:true})})
  try{return await Promise.race([Promise.resolve().then(operation),interrupted])}
  finally{signal.removeEventListener('abort',cancel)}
}
const boundedNumber=(value,fallback,min,max)=>Number.isFinite(Number(value))?Math.min(max,Math.max(min,Number(value))):fallback
function endpointUrl(value){
  let base
  try{base=publicImageUrl(value)}catch{throw failure('GENERATION_ENDPOINT','请先配置有效的 HTTPS 图片与视频服务根地址。')}
  if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||/\/(?:gradio_api|call|api)(?:\/|$)/.test(base.pathname))throw failure('GENERATION_ENDPOINT','图片与视频服务须填写 HTTPS 根地址，不能包含凭证、查询参数或接口路径。')
  base.pathname=base.pathname.replace(/\/+$/,'')+'/'
  return base
}
const route=(base,path)=>new URL(path,base)
function remoteFailure(value){
  const message=typeof value==='string'?value:JSON.stringify(value??'')
  if(/quota|gpu.{0,30}(?:limit|budget)|exceeded|配额|额度/i.test(message))return failure('GENERATION_QUOTA','图片或视频服务的计算额度暂时用完，请稍后重试。')
  if(/queue.{0,30}full|队列.{0,10}满/i.test(message))return failure('GENERATION_QUEUE_FULL','图片或视频生成队列已满，请稍后再试。')
  return failure('GENERATION_UNAVAILABLE','图片或视频生成失败，请稍后重试。')
}
async function boundedBytes(response,maxBytes,signal,code='GENERATION_PROTOCOL'){
  if(Number(response.headers.get('content-length'))>maxBytes){cancelBody(response.body);throw failure(code,'生成服务返回的数据超过允许大小。')}
  if(!response.body)throw failure('GENERATION_PROTOCOL','生成服务返回了空响应。')
  const reader=response.body.getReader(),chunks=[];let size=0
  try{
    while(true){
      const {done,value}=await abortable(()=>reader.read(),signal)
      if(done)break
      size+=value.byteLength
      if(size>maxBytes)throw failure(code,'生成服务返回的数据超过允许大小。')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks,size)
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
async function boundedJson(response,maxBytes,signal){
  const bytes=await boundedBytes(response,maxBytes,signal)
  try{return JSON.parse(bytes.toString('utf8'))}catch{throw failure('GENERATION_PROTOCOL','生成服务返回了无效的任务数据。')}
}
function text(value,label,max,{empty=false}={}){
  if(value!==undefined&&value!==null&&typeof value!=='string')throw failure('GENERATION_INPUT',`${label}须为文字。`)
  const result=String(value??'').trim()
  if(!empty&&!result)throw failure('GENERATION_INPUT',`请提供${label}。`)
  if(Array.from(result).length>max)throw failure('GENERATION_INPUT',`${label}最多 ${max} 字，请缩短后重试。`)
  return result
}
function seedValue(value){
  if(value===undefined||value===null)return randomInt(0,MAX_SEED+1)
  if(!Number.isSafeInteger(value)||value<0||value>MAX_SEED)throw failure('GENERATION_INPUT','随机种子须为 0–2147483647 之间的整数。')
  return value
}
function booleanValue(value,fallback,label){
  if(value===undefined)return fallback
  if(typeof value!=='boolean')throw failure('GENERATION_INPUT',`${label}须为开启或关闭。`)
  return value
}
function imageMime(bytes){
  if(bytes.length>=33&&bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))&&bytes.toString('ascii',12,16)==='IHDR'&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0&&bytes.readUInt32BE(16)*bytes.readUInt32BE(20)<=40000000)return 'image/png'
  if(bytes.length>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255&&bytes.at(-2)===255&&bytes.at(-1)===217)return 'image/jpeg'
  if(bytes.length>=13&&['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))&&bytes.readUInt16LE(6)>0&&bytes.readUInt16LE(8)>0&&bytes.readUInt16LE(6)*bytes.readUInt16LE(8)<=40000000)return 'image/gif'
  if(bytes.length>=20&&bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP'&&bytes.readUInt32LE(4)+8===bytes.length)return 'image/webp'
  throw failure('GENERATION_IMAGE_INVALID','图片内容无效或格式不受支持。')
}
function preparedImage(input,maxBytes){
  if(!input)throw failure('GENERATION_IMAGE_REQUIRED','请附上或回复一张图片，作为视频首帧。')
  const claimed=input.mimeType||input.mime
  let bytes,dataMime
  if(Buffer.isBuffer(input)||input instanceof Uint8Array)bytes=Buffer.from(input)
  else if(Buffer.isBuffer(input.data)||input.data instanceof Uint8Array)bytes=Buffer.from(input.data)
  else if(typeof input.data==='string'){
    const dataUri=/^data:(image\/(?:png|jpeg|webp|gif));base64,/.exec(input.data)
    dataMime=dataUri?.[1]
    const encoded=dataUri?input.data.slice(dataUri[0].length):input.data
    if(encoded.length>Math.ceil(maxBytes/3)*4||encoded.length%4!==0||!encoded.length||!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded))throw failure('GENERATION_IMAGE_INVALID','图片数据为空、过大或格式无效。')
    bytes=Buffer.from(encoded,'base64')
    if(bytes.toString('base64')!==encoded)throw failure('GENERATION_IMAGE_INVALID','图片数据格式无效。')
    if(dataUri&&claimed&&dataUri[1]!==claimed)throw failure('GENERATION_IMAGE_INVALID','图片内容与声明的格式不一致。')
  }else throw failure('GENERATION_IMAGE_REQUIRED','请附上或回复一张图片，作为视频首帧。')
  if(!bytes.length||bytes.length>maxBytes)throw failure('GENERATION_IMAGE_TOO_LARGE','图片为空或超过允许大小。')
  const mime=imageMime(bytes)
  if((claimed&&claimed!==mime)||(dataMime&&dataMime!==mime))throw failure('GENERATION_IMAGE_INVALID','图片内容与声明的格式不一致。')
  return {bytes,mime,name:'reference.'+IMAGE_EXTENSIONS[mime]}
}
function validateTempPath(value,extensions){
  if(typeof value!=='string'||value.length>2048||!/^\/tmp\/[A-Za-z0-9_./-]+$/.test(value)||value.split('/').some(part=>part==='.'||part==='..')||!extensions.some(ext=>value.toLowerCase().endsWith('.'+ext)))throw failure('GENERATION_FILE_INVALID','生成服务返回了不受信任的媒体位置。')
  return value
}
function mediaFileUrl(value,base,extensions){
  if(typeof value!=='string'||!value||value.length>4096||/[\\?#\u0000-\u001f]/.test(value))throw failure('GENERATION_FILE_INVALID','生成服务返回了无效的媒体位置。')
  if(value.startsWith('/tmp/'))return route(base,'gradio_api/file='+validateTempPath(value,extensions))
  let decoded,url
  try{decoded=decodeURIComponent(value);url=new URL(value,base)}catch{throw failure('GENERATION_FILE_INVALID','生成服务返回了无效的媒体位置。')}
  if(decoded.split('/').some(part=>part==='.'||part==='..')||decoded.includes('%')||url.origin!==base.origin||url.username||url.password||url.search||url.hash)throw failure('GENERATION_FILE_INVALID','生成服务返回了不受信任的媒体位置。')
  const prefix=base.pathname+'gradio_api/file='
  if(!url.pathname.startsWith(prefix))throw failure('GENERATION_FILE_INVALID','生成服务返回了不受信任的媒体位置。')
  let name
  try{name=decodeURIComponent(url.pathname.slice(prefix.length))}catch{throw failure('GENERATION_FILE_INVALID','生成服务返回了无效的媒体位置。')}
  validateTempPath(name,extensions)
  return url
}
function fileValue(value){
  const file=value?.video??value
  if(typeof file==='string')return file
  if(!file||typeof file!=='object'||Array.isArray(file))throw failure('GENERATION_FILE_INVALID','生成服务没有返回媒体文件。')
  return file.url||file.path||file.name
}
function validateMp4(bytes){
  if(bytes.length<32)throw failure('GENERATION_VIDEO_INVALID','生成服务没有返回完整的 MP4 视频。')
  let offset=0,ftyp=false,moov=false,mdat=false,boxes=0
  while(offset<bytes.length){
    if(offset+8>bytes.length||++boxes>10000)throw failure('GENERATION_VIDEO_INVALID','生成服务返回的 MP4 视频不完整。')
    let size=bytes.readUInt32BE(offset),header=8
    const kind=bytes.toString('ascii',offset+4,offset+8)
    if(size===1){if(offset+16>bytes.length)throw failure('GENERATION_VIDEO_INVALID','生成服务返回的 MP4 视频不完整。');const extended=bytes.readBigUInt64BE(offset+8);if(extended>BigInt(bytes.length))throw failure('GENERATION_VIDEO_INVALID','生成服务返回的 MP4 视频不完整。');size=Number(extended);header=16}
    if(size===0)size=bytes.length-offset
    if(size<header||offset+size>bytes.length)throw failure('GENERATION_VIDEO_INVALID','生成服务返回的 MP4 视频不完整。')
    if(kind==='ftyp'&&offset<1048576&&size>=header+8)ftyp=true
    if(kind==='moov'&&size>header)moov=true
    if(kind==='mdat'&&size>header)mdat=true
    offset+=size
  }
  if(!ftyp||!moov||!mdat)throw failure('GENERATION_VIDEO_INVALID','生成服务没有返回有效的 MP4 视频。')
}
function safeTiming(value,depth=0){
  if(!value||typeof value!=='object'||Array.isArray(value)||depth>3)return {}
  const result={}
  for(const [key,item] of Object.entries(value).slice(0,30)){
    if(!/^[a-z][a-z0-9_]{0,47}$/i.test(key)||['__proto__','constructor','prototype'].includes(key))continue
    if(typeof item==='number'&&Number.isFinite(item)&&item>=0)result[key]=item
    else if(typeof item==='boolean')result[key]=item
    else if(key==='model'&&['flux','anima'].includes(item))result[key]=item
    else if(key==='subtitle_timing'&&item==='estimated')result[key]=item
    else if(item&&typeof item==='object'&&!Array.isArray(item))result[key]=safeTiming(item,depth+1)
  }
  return result
}
async function queueResult(response,signal,state){
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')){cancelBody(response.body);throw failure('GENERATION_PROTOCOL','生成服务没有返回有效的任务事件。')}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',size=0
  try{
    while(true){
      const {done,value}=await abortable(()=>reader.read(),signal)
      if(done)throw failure('GENERATION_PROTOCOL','生成任务连接提前结束，请稍后重试。')
      size+=value.byteLength
      if(size>2097152)throw failure('GENERATION_PROTOCOL','生成任务事件超过允许大小。')
      buffer+=decoder.decode(value,{stream:true})
      let boundary
      while((boundary=/\r?\n\r?\n/.exec(buffer))){
        const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length)
        const lines=block.split(/\r?\n/),eventName=lines.find(line=>line.startsWith('event:'))?.slice(6).trim()
        const raw=lines.filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
        if(!raw)continue
        let event
        try{event=JSON.parse(raw)}catch{throw failure('GENERATION_PROTOCOL','生成任务事件格式异常。')}
        if(eventName==='complete'){state.completed=true;if(!Array.isArray(event))throw remoteFailure(event);return event}
        if(eventName==='error'){state.completed=true;throw remoteFailure(event)}
        if(event?.msg==='process_completed'){
          state.completed=true
          if(event.success===false||event.output?.error)throw remoteFailure(event.output?.error)
          if(!Array.isArray(event.output?.data))throw failure('GENERATION_PROTOCOL','生成服务返回的媒体任务格式异常。')
          return event.output.data
        }
        if(['queue_full','unexpected_error'].includes(event?.msg))throw remoteFailure(event.message||event.msg)
        if(event?.msg==='close_stream')throw failure('GENERATION_PROTOCOL','生成任务连接提前结束，请稍后重试。')
      }
      if(buffer.length>262144)throw failure('GENERATION_PROTOCOL','生成任务单条事件超过允许大小。')
    }
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}

/** One visual job at a time. Audio effects are composed into videos by /story. */
export class GenerationService {
  constructor({config=()=>DEFAULTS,fetchImpl=fetch}={}){this.config=config;this.fetchImpl=fetchImpl;this.closed=new AbortController();this.active=false;this.waiters=[];this.cached=null}
  close(){this.closed.abort();this.cached=null}
  async acquire(signal){
    check(signal)
    if(!this.active){this.active=true;return}
    if(this.waiters.length>=3)throw failure('GENERATION_QUEUE_FULL','图片或视频生成正在忙，请稍后再试。')
    await new Promise((resolve,reject)=>{
      const ticket={resolve:()=>{signal.removeEventListener('abort',cancel);resolve()}}
      const cancel=()=>{const index=this.waiters.indexOf(ticket);if(index>=0)this.waiters.splice(index,1);reject(cancelled(signal))}
      signal.addEventListener('abort',cancel,{once:true});this.waiters.push(ticket)
    })
  }
  release(){const next=this.waiters.shift();if(next)next.resolve();else this.active=false}
  async request(url,{base,config,signal,method='GET',body,json=false,mediaExtensions,allowMissing=false}){
    for(let redirects=0;redirects<=3;redirects++){
      check(signal)
      if(url.origin!==base.origin)throw failure('GENERATION_PROTOCOL','生成服务跳转到了不受信任的位置。')
      const headers={...(json?{'Content-Type':'application/json'}:{}),...(config.token?{Authorization:`Bearer ${config.token}`}:{})}
      const response=await abortable(()=>this.fetchImpl(url,{method,body,headers,signal,redirect:'manual'}),signal)
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');cancelBody(response.body)
        if(!location||redirects===3||(method!=='GET'&&![307,308].includes(response.status)))throw failure('GENERATION_PROTOCOL','生成服务重定向异常，请检查配置地址。')
        let next
        try{next=new URL(location,url)}catch{throw failure('GENERATION_PROTOCOL','生成服务重定向地址无效。')}
        if(next.origin!==base.origin||next.username||next.password||next.hash)throw failure('GENERATION_PROTOCOL','生成服务跳转到了不受信任的位置。')
        if(mediaExtensions)mediaFileUrl(next.href,base,mediaExtensions)
        url=next;continue
      }
      if(!response.ok){
        if(allowMissing&&[404,405].includes(response.status)){cancelBody(response.body);return null}
        if([401,403].includes(response.status)){cancelBody(response.body);throw failure('GENERATION_AUTH','图片与视频服务授权失效，请联系机器人主人检查访问权限。')}
        if([402,429].includes(response.status)){cancelBody(response.body);throw failure('GENERATION_QUOTA','图片或视频服务的计算额度或请求频率已达上限，请稍后重试。')}
        let message=''
        try{message=(await boundedBytes(response,16384,signal)).toString('utf8')}catch(error){if(signal.aborted)throw error}
        const classified=remoteFailure(message)
        if(classified.code!=='GENERATION_UNAVAILABLE')throw classified
        throw failure('GENERATION_UNAVAILABLE',`图片与视频服务暂时不可用（HTTP ${response.status}），请稍后重试。`)
      }
      return response
    }
  }
  async descriptor(base,config,signal,api){
    if(this.cached?.endpoint===base.href&&this.cached.token===config.token&&Date.now()-this.cached.time<600000)return this.cached.apis[api]
    const response=await this.request(route(base,'config'),{base,config,signal})
    const remote=await boundedJson(response,2097152,signal),apis={}
    for(const [name,inputCount,outputCount] of [['image',7,3],['story',10,5]]){
      const dependency=remote.dependencies?.find(row=>row.api_name===name)
      if(!dependency||dependency.inputs?.length!==inputCount||dependency.outputs?.length!==outputCount||!Number.isInteger(dependency.id)||dependency.id<0)throw failure('GENERATION_PROTOCOL','图片与视频服务接口不兼容，请检查服务版本。')
      apis[name]={fnIndex:dependency.id}
    }
    this.cached={endpoint:base.href,token:config.token,time:Date.now(),apis}
    return apis[api]
  }
  async upload(image,context){
    const form=new FormData();form.append('files',new Blob([image.bytes],{type:image.mime}),image.name)
    const response=await this.request(route(context.base,'gradio_api/upload'),{...context,method:'POST',body:form})
    const paths=await boundedJson(response,65536,context.signal)
    if(!Array.isArray(paths)||paths.length!==1)throw failure('GENERATION_PROTOCOL','生成服务没有接收有效的图片。')
    const path=validateTempPath(paths[0],IMAGE_SUFFIXES)
    return {path,orig_name:image.name,mime_type:image.mime,meta:{_type:'gradio.FileData'}}
  }
  async job(api,data,context,state){
    const descriptor=await this.descriptor(context.base,context.config,context.signal,api)
    state.fnIndex=descriptor.fnIndex
    const submitted=await this.request(route(context.base,'gradio_api/call/'+api),{...context,method:'POST',json:true,body:JSON.stringify({data})})
    const task=await boundedJson(submitted,65536,context.signal)
    if(typeof task.event_id!=='string'||!/^[-_a-zA-Z0-9]{1,128}$/.test(task.event_id))throw failure('GENERATION_PROTOCOL','生成服务没有返回有效的任务编号。')
    state.eventId=task.event_id
    // Gradio's full queue stream preserves output.error for quota diagnosis.
    // A missing queue route falls back to the documented call stream, without
    // submitting the GPU job a second time.
    const response=await this.request(route(context.base,'gradio_api/queue/data?session_hash='+encodeURIComponent(task.event_id)),{...context,allowMissing:true})||await this.request(route(context.base,'gradio_api/call/'+api+'/'+encodeURIComponent(task.event_id)),context)
    const result=await queueResult(response,context.signal,state)
    return result
  }
  async download(value,type,context){
    const extensions=type==='image'?IMAGE_SUFFIXES:['mp4']
    const url=mediaFileUrl(fileValue(value),context.base,extensions)
    const response=await this.request(url,{...context,mediaExtensions:extensions})
    const claimed=response.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
    if(claimed&&claimed!=='application/octet-stream'&&(type==='image'?!Object.hasOwn(IMAGE_EXTENSIONS,claimed):claimed!=='video/mp4')){cancelBody(response.body);throw failure('GENERATION_FILE_INVALID','生成服务返回了网页或其他非媒体内容。')}
    const limit=type==='image'?context.config.maxImageBytes:context.config.maxVideoBytes
    const bytes=await boundedBytes(response,limit,context.signal,type==='image'?'GENERATION_IMAGE_TOO_LARGE':'GENERATION_VIDEO_TOO_LARGE')
    const mimeType=type==='image'?imageMime(bytes):'video/mp4'
    if(type==='video')validateMp4(bytes)
    if(claimed&&claimed!=='application/octet-stream'&&claimed!==mimeType)throw failure('GENERATION_FILE_INVALID','生成媒体内容与声明的格式不一致。')
    check(context.signal)
    return {type,data:bytes.toString('base64'),mimeType}
  }
  async cancelJob(state,context){
    if(!state.eventId||state.completed)return
    try{
      const response=await this.request(route(context.base,'gradio_api/cancel'),{...context,signal:AbortSignal.timeout(1500),method:'POST',json:true,body:JSON.stringify({session_hash:state.eventId,event_id:state.eventId,fn_index:state.fnIndex})})
      cancelBody(response?.body)
    }catch{/* Cancellation is best effort; never repeat a generation request. */}
  }
  async execute(api,options,prepare){
    const config={...DEFAULTS,...this.config()}
    if(!config.enabled)throw failure('GENERATION_DISABLED','AI 图片与视频生成尚未启用。')
    config.maxImageBytes=boundedNumber(config.maxImageBytes,DEFAULTS.maxImageBytes,1,DEFAULTS.maxImageBytes)
    config.maxVideoBytes=boundedNumber(config.maxVideoBytes,DEFAULTS.maxVideoBytes,32,DEFAULTS.maxVideoBytes)
    config.maxPromptCharacters=Math.floor(boundedNumber(config.maxPromptCharacters,DEFAULTS.maxPromptCharacters,1,2000))
    const base=endpointUrl(config.endpoint),timeout=new AbortController()
    const timer=setTimeout(()=>timeout.abort(new DOMException('Timed out','TimeoutError')),boundedNumber(config.timeoutMs,DEFAULTS.timeoutMs,1,600000))
    const signal=AbortSignal.any([timeout.signal,this.closed.signal,...(options.signal?[options.signal]:[])])
    const context={base,config,signal},state={};let acquired=false
    try{
      check(signal)
      const prepared=prepare(config)
      await this.acquire(signal);acquired=true
      // Check the API shape before uploading user images or spending GPU quota.
      await this.descriptor(base,config,signal,api)
      const input=prepared.image?await this.upload(prepared.image,context):null
      const result=await this.job(api,prepared.data(input),context,state)
      if(result.length!==(api==='image'?3:5)||!result[0])throw failure('GENERATION_PROTOCOL','生成服务没有返回完整的媒体结果。')
      const content=await this.download(result[0],api==='image'?'image':'video',context)
      const timing=safeTiming(result.at(-1))
      return {...content,...prepared.metadata,timing,...(api==='story'&&Number.isFinite(timing.mix?.duration)?{durationSeconds:timing.mix.duration}:{})}
    }catch(error){
      if(signal.aborted)throw cancelled(signal)
      if(error instanceof GenerationError)throw error
      throw failure('GENERATION_UNAVAILABLE','无法连接图片与视频服务，请稍后重试。')
    }finally{
      clearTimeout(timer)
      if(state.eventId&&!state.completed)await this.cancelJob(state,context)
      if(acquired)this.release()
    }
  }
  image(options={}){
    return this.execute('image',options,config=>{
      const prompt=text(options.prompt,'画面描述',config.maxPromptCharacters),model=options.model??config.defaultModel
      if(!['flux','anima'].includes(model))throw failure('GENERATION_INPUT','画风仅支持写实 / 通用（flux）或二次元（anima）。')
      if(model==='anima'&&options.reference)throw failure('GENERATION_INPUT','二次元模型暂不支持参考图，请移除参考图或改用写实画风。')
      const seed=seedValue(options.seed),width=options.width??1024,height=options.height??1024
      if(![768,1024].includes(width)||![768,1024].includes(height))throw failure('GENERATION_INPUT','图片宽高须为 768 或 1024。')
      return {image:options.reference?preparedImage(options.reference,config.maxImageBytes):null,data:reference=>[prompt,model,reference,'',width,height,seed],metadata:{model,seed}}
    })
  }
  video(options={}){
    return this.execute('story',options,config=>{
      const prompt=text(options.prompt,'动作与镜头描述',config.maxPromptCharacters),script=text(options.script,'配音文字',200,{empty:true}),effectsPrompt=text(options.effectsPrompt,'环境音效描述',config.maxPromptCharacters,{empty:true})
      const voice=options.voice??'zf_001'
      if(typeof voice!=='string'||!/^[-_a-zA-Z0-9]{1,80}$/.test(voice))throw failure('GENERATION_INPUT','视频配音须使用有效的音色编号，请查看 #AI音色列表。')
      const duration=options.duration??config.defaultDuration
      if(![3,5].includes(duration))throw failure('GENERATION_INPUT','短视频时长须为 3 秒或 5 秒。')
      const seed=seedValue(options.seed),effectsEnabled=booleanValue(options.effectsEnabled??options.effects,config.defaultEffects!==false,'视频音效'),subtitles=booleanValue(options.subtitles,config.subtitles!==false,'视频字幕')
      return {image:preparedImage(options.image,config.maxImageBytes),data:image=>[image,prompt,'',duration,seed,script,voice,effectsPrompt,effectsEnabled,subtitles],metadata:{seed,effectsEnabled}}
    })
  }
}
