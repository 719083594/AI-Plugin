import {LEGACY_VOICE_CATALOG,createVoiceCatalog} from './voices.mjs'

const DEFAULTS={enabled:false,endpoint:'',token:'',defaultVoice:'纳西妲（草神）',language:'zh',timeoutMs:45000,maxCharacters:500,maxAudioBytes:10485760,noiseScale:0.6,noiseScaleW:0.668,lengthScale:1.2}
const LANGUAGES={zh:'中文',ja:'日语',mix:'中日混合（中文用[ZH][ZH]包裹起来，日文用[JA][JA]包裹起来）'}
const MODERN_LANGUAGES={Chinese:'zh',中文:'zh',English:'en',英文:'en',Japanese:'ja',日语:'ja'}
export class SpeechError extends Error {
  constructor(code,message){super(message);this.name='SpeechError';this.code=code;this.recoverable=true}
}
const failure=(code,message)=>new SpeechError(code,message)
const cancelled=signal=>failure(signal?.reason?.name==='TimeoutError'?'SPEECH_TIMEOUT':'SPEECH_ABORTED',signal?.reason?.name==='TimeoutError'?'语音合成等待超时，请稍后重试。':'语音合成已取消。')
function cancelBody(body){try{void body?.cancel().catch(()=>{})}catch{}}
function check(signal){if(signal.aborted)throw cancelled(signal)}
async function abortable(operation,signal){
  check(signal);let cancel
  const aborted=new Promise((_,reject)=>{cancel=()=>reject(cancelled(signal));signal.addEventListener('abort',cancel,{once:true})})
  try{return await Promise.race([Promise.resolve().then(operation),aborted])}
  finally{signal.removeEventListener('abort',cancel)}
}
function endpointUrl(endpoint){
  let url
  try{url=new URL(endpoint)}catch{throw failure('SPEECH_ENDPOINT','请先在 AI 语音配置中填写有效的 HTTPS Gradio 服务根地址。')}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||/\/(?:(?:api|run)\/generate|gradio_api\/call\/generate)\/?$/.test(url.pathname))throw failure('SPEECH_ENDPOINT','语音服务须填写 HTTPS 根地址，不能包含凭证、查询参数或生成接口路径。')
  url.pathname=url.pathname.replace(/\/+$/,'')+'/'
  return url
}
const route=(base,path)=>new URL(path,base)
function headers(config,json=false){return {...(json?{'Content-Type':'application/json'}:{}),...(config.token?{Authorization:`Bearer ${config.token}`}:{})}}
async function boundedBytes(response,maxBytes,signal){
  const declared=Number(response.headers.get('content-length'))
  if(Number.isFinite(declared)&&declared>maxBytes){cancelBody(response.body);throw failure('SPEECH_AUDIO_TOO_LARGE','语音服务返回的数据超过允许大小。')}
  if(!response.body)throw failure('SPEECH_PROTOCOL','语音服务返回了空响应。')
  const reader=response.body.getReader(),chunks=[];let count=0
  try{
    while(true){
      const {done,value}=await abortable(()=>reader.read(),signal)
      if(done)break
      count+=value.byteLength
      if(count>maxBytes)throw failure('SPEECH_AUDIO_TOO_LARGE','语音服务返回的数据超过允许大小。')
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks,count)
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
async function boundedJson(response,maxBytes,signal){
  const bytes=await boundedBytes(response,maxBytes,signal)
  try{return JSON.parse(bytes.toString('utf8'))}catch{throw failure('SPEECH_PROTOCOL','语音服务返回格式异常，请检查服务是否已经启动。')}
}
function validateWav(bytes){
  if(bytes.length<44||bytes.toString('ascii',0,4)!=='RIFF'||bytes.toString('ascii',8,12)!=='WAVE')throw failure('SPEECH_AUDIO_INVALID','语音服务没有返回有效的 WAV 音频。')
  const limit=bytes.readUInt32LE(4)+8
  if(limit>bytes.length||limit<44)throw failure('SPEECH_AUDIO_INVALID','语音服务返回的 WAV 音频不完整。')
  let format=null,audioBytes=0,offset=12
  while(offset+8<=limit){
    const tag=bytes.toString('ascii',offset,offset+4),size=bytes.readUInt32LE(offset+4),start=offset+8
    if(start+size>limit)throw failure('SPEECH_AUDIO_INVALID','语音服务返回的 WAV 音频不完整。')
    if(tag==='fmt '){
      if(size<16)throw failure('SPEECH_AUDIO_INVALID','语音服务返回的 WAV 参数无效。')
      format={codec:bytes.readUInt16LE(start),channels:bytes.readUInt16LE(start+2),sampleRate:bytes.readUInt32LE(start+4),byteRate:bytes.readUInt32LE(start+8),blockAlign:bytes.readUInt16LE(start+12),bits:bytes.readUInt16LE(start+14)}
    }
    if(tag==='data')audioBytes+=size
    offset=start+size+(size%2)
  }
  if(!format||![1,3].includes(format.codec)||format.channels<1||format.channels>8||format.sampleRate<8000||format.sampleRate>192000||![8,16,24,32].includes(format.bits)||format.blockAlign!==format.channels*format.bits/8||format.byteRate!==format.sampleRate*format.blockAlign||audioBytes<=0||audioBytes%format.blockAlign)throw failure('SPEECH_AUDIO_INVALID','语音服务返回的 WAV 音频为空或参数无效。')
  return audioBytes/format.byteRate
}
function audioFileUrl(value,base,modern=false){
  if(typeof value!=='string'||!value||value.length>2048||/[\\?#\u0000-\u001f]/.test(value))throw failure('SPEECH_AUDIO_INVALID','语音服务返回了无效的音频位置。')
  if(value.startsWith('https://')||value.startsWith('/file=')||value.startsWith('/gradio_api/file=')){
    let url
    try{url=new URL(value,base)}catch{throw failure('SPEECH_AUDIO_INVALID','语音服务返回了无效的音频位置。')}
    const prefix=['file=','gradio_api/file='].map(path=>base.pathname+path).find(path=>url.pathname.startsWith(path))
    if(url.origin!==base.origin||!prefix||url.username||url.password||url.search||url.hash)throw failure('SPEECH_AUDIO_INVALID','语音服务返回了不受信任的音频位置。')
    let name
    try{name=decodeURIComponent(url.pathname.slice(prefix.length))}catch{throw failure('SPEECH_AUDIO_INVALID','语音服务返回了无效的音频位置。')}
    validateTempName(name)
    return url
  }
  validateTempName(value)
  return route(base,(modern?'gradio_api/':'')+'file='+value.split('/').map(encodeURIComponent).join('/'))
}

const choices = field => {
  const rows=Array.isArray(field?.choices)?field.choices.map(value=>typeof value==='string'?{label:value,id:value}:Array.isArray(value)&&value.length===2&&value.every(item=>typeof item==='string')?{label:value[0],id:value[1]}:null):[]
  return rows.every(Boolean)?rows:[]
}
function remoteFailure(value){
  // The full queue stream retains output.error; the simplified /call stream
  // drops it in Gradio 5.33. Never forward raw upstream errors or addresses.
  const error=typeof value==='string'?value:JSON.stringify(value??'')
  if(/quota|gpu.{0,30}(?:limit|budget)|exceeded|配额|额度/i.test(error))return failure('SPEECH_QUOTA','语音服务的计算额度暂时用完，请稍后重试。')
  if(/queue.{0,30}full|队列.{0,10}满/i.test(error))return failure('SPEECH_QUEUE_FULL','语音服务排队已满，请稍后再试。')
  return failure('SPEECH_UNAVAILABLE','语音服务未生成音频，请缩短文字或稍后重试。')
}
async function queueResult(response,signal){
  if(!response.body||!response.headers.get('content-type')?.includes('text/event-stream')){cancelBody(response.body);throw failure('SPEECH_PROTOCOL','语音服务没有返回有效的任务事件。')}
  const reader=response.body.getReader(),decoder=new TextDecoder();let buffer='',count=0
  try{
    while(true){
      const {done,value}=await abortable(()=>reader.read(),signal)
      if(done)throw failure('SPEECH_PROTOCOL','语音服务任务连接提前结束，请稍后重试。')
      count+=value.byteLength
      if(count>2097152)throw failure('SPEECH_PROTOCOL','语音服务任务事件超过允许大小。')
      buffer+=decoder.decode(value,{stream:true})
      let boundary
      while((boundary=/\r?\n\r?\n/.exec(buffer))){
        const block=buffer.slice(0,boundary.index);buffer=buffer.slice(boundary.index+boundary[0].length)
        const data=block.split(/\r?\n/).filter(line=>line.startsWith('data:')).map(line=>line.slice(5).trimStart()).join('\n')
        if(!data)continue
        let event
        try{event=JSON.parse(data)}catch{throw failure('SPEECH_PROTOCOL','语音服务任务事件格式异常。')}
        if(event?.msg==='process_completed'){
          if(event.success===false||event.output?.error)throw remoteFailure(event.output?.error)
          if(!Array.isArray(event.output?.data)||!event.output.data[1])throw remoteFailure(event.output?.error)
          return {data:event.output.data}
        }
        if(event?.msg==='queue_full'||event?.msg==='unexpected_error')throw remoteFailure(event.message||event.msg)
        if(event?.msg==='close_stream')throw failure('SPEECH_PROTOCOL','语音服务任务连接提前结束，请稍后重试。')
      }
      if(buffer.length>262144)throw failure('SPEECH_PROTOCOL','语音服务单条任务事件超过允许大小。')
    }
  }finally{void reader.cancel().catch(()=>{});try{reader.releaseLock()}catch{}}
}
function validateTempName(value){
  if(!value.startsWith('/tmp/')||!value.endsWith('.wav')||value.includes('%')||/[\\?#\u0000-\u001f]/.test(value)||value.split('/').some(part=>part==='.'||part==='..'))throw failure('SPEECH_AUDIO_INVALID','语音服务返回了不受信任的音频位置。')
}

export class SpeechService {
  constructor({config=()=>DEFAULTS,fetchImpl=fetch}={}){
    this.config=config;this.fetchImpl=fetchImpl;this.active=false;this.waiters=[];this.cached=null;this.closed=new AbortController()
  }
  close(){this.closed.abort();this.cached=null}
  currentCatalog(){
    const config={...DEFAULTS,...this.config()}
    try{return this.cached?.endpoint===endpointUrl(config.endpoint).href&&this.cached.token===config.token?this.cached.descriptor.catalog:null}catch{return null}
  }
  async catalogue({signal:externalSignal}={}){
    const config={...DEFAULTS,...this.config()},base=endpointUrl(config.endpoint)
    const signal=AbortSignal.any([AbortSignal.timeout(Math.min(120000,Math.max(1000,Number(config.timeoutMs)||DEFAULTS.timeoutMs))),this.closed.signal,...(externalSignal?[externalSignal]:[])])
    try{return (await this.remoteConfig(base,config,signal)).catalog}
    catch(error){if(signal.aborted)throw cancelled(signal);if(error instanceof SpeechError)throw error;throw failure('SPEECH_UNAVAILABLE','无法读取语音服务音色目录，请稍后重试。')}
  }
  async acquire(signal){
    check(signal)
    if(!this.active){this.active=true;return}
    if(this.waiters.length>=3)throw failure('SPEECH_QUEUE_FULL','语音合成正在忙，请稍后再试。')
    await new Promise((resolve,reject)=>{
      const ticket={resolve:()=>{signal.removeEventListener('abort',cancel);resolve()},signal}
      const cancel=()=>{const index=this.waiters.indexOf(ticket);if(index>=0)this.waiters.splice(index,1);reject(cancelled(signal))}
      signal.addEventListener('abort',cancel,{once:true});this.waiters.push(ticket)
    })
  }
  release(){
    const next=this.waiters.shift()
    if(next)next.resolve();else this.active=false
  }
  async request(url,{config,signal,method='GET',body,audio=false,base}){
    for(let redirects=0;redirects<=3;redirects++){
      check(signal)
      if(url.origin!==base.origin)throw failure('SPEECH_PROTOCOL','语音服务重定向到了不受信任的位置。')
      const response=await abortable(()=>this.fetchImpl(url,{method,body,headers:headers(config,method==='POST'),signal,redirect:'manual'}),signal)
      if(response.status>=300&&response.status<400){
        const location=response.headers.get('location');cancelBody(response.body)
        if(!location||redirects===3||(method!=='GET'&&![307,308].includes(response.status)))throw failure('SPEECH_PROTOCOL','语音服务重定向异常，请检查配置地址。')
        let next
        try{next=new URL(location,url)}catch{throw failure('SPEECH_PROTOCOL','语音服务重定向地址无效。')}
        if(next.origin!==base.origin||next.username||next.password||next.hash)throw failure('SPEECH_PROTOCOL','语音服务重定向到了不受信任的位置。')
        if(audio)audioFileUrl(next.href,base)
        url=next;continue
      }
      if(!response.ok){cancelBody(response.body);throw failure('SPEECH_UNAVAILABLE',`语音服务暂时不可用（HTTP ${response.status}），请稍后重试。`)}
      return response
    }
  }
  async remoteConfig(base,config,signal){
    if(this.cached?.endpoint===base.href&&this.cached.token===config.token&&Date.now()-this.cached.time<600000)return this.cached.descriptor
    const response=await this.request(route(base,'config'),{base,config,signal})
    const remote=await boundedJson(response,2097152,signal)
    const dependency=remote.dependencies?.find(item=>item.api_name==='generate')
    const components=new Map((remote.components||[]).map(item=>[item.id,item.props]))
    const fields=dependency?.inputs?.map(id=>components.get(id))
    let descriptor
    if(fields?.length===6&&Array.isArray(fields[1]?.choices)&&Array.isArray(fields[2]?.choices)&&fields[1].choices.every(value=>typeof value==='string')&&fields[2].choices.every(value=>typeof value==='string'))descriptor={protocol:'vits',fields,catalog:LEGACY_VOICE_CATALOG}
    else if(fields?.length===4&&dependency.outputs?.length===3&&choices(fields[1]).length&&choices(fields[2]).length){
      const metadata=[...components.values()].find(props=>props?.label==='Speech catalogue')?.value
      const languages=Object.fromEntries(choices(fields[1]).map(row=>[row.id,metadata?.languages?.[row.id]||MODERN_LANGUAGES[row.id]]).filter(([,code])=>['zh','ja','en','mix'].includes(code)))
      const defaultLanguage=languages[fields[1].value]||Object.values(languages)[0]
      const rows=metadata?.voices || choices(fields[2]).map(row=>({...row,language:defaultLanguage,group:'通用'}))
      let catalog
      try{catalog=createVoiceCatalog({voices:rows,defaultVoice:metadata?.defaultVoice||fields[2].value,defaultLanguage,languages})}catch{throw failure('SPEECH_PROTOCOL','语音服务音色目录格式异常。')}
      if(!defaultLanguage||Object.values(languages).some(code=>!code))throw failure('SPEECH_PROTOCOL','语音服务没有提供支持的语言。')
      descriptor={protocol:'gradio5',fields,catalog,languages,maxCharacters:Math.min(500,Math.max(1,Number(metadata?.maxCharacters)||500))}
    }else throw failure('SPEECH_PROTOCOL','语音服务不兼容，未找到可用的 generate 接口。')
    this.cached={endpoint:base.href,token:config.token,time:Date.now(),descriptor}
    return descriptor
  }
  async synthesize(text,{voice,language,signal:externalSignal}={}){
    const config={...DEFAULTS,...this.config()}
    if(!config.enabled)throw failure('SPEECH_DISABLED','AI 语音尚未启用，请先配置语音服务。')
    const base=endpointUrl(config.endpoint)
    text=String(text??'').trim()
    if(!text)throw failure('SPEECH_EMPTY','请提供需要转换成语音的文字。')
    const maxCharacters=Math.min(500,Math.max(1,Number(config.maxCharacters)||500))
    if(Array.from(text).length>maxCharacters)throw failure('SPEECH_TOO_LONG',`这段文字超过语音上限 ${maxCharacters} 字，请缩短文字或切回文字模式。`)
    language=language||config.language
    if(!['zh','ja','mix','en'].includes(language))throw failure('SPEECH_PROTOCOL','语音语言须为 zh、ja、en 或 mix。')
    const maxAudioBytes=Math.min(26214400,Math.max(44,Number(config.maxAudioBytes)||DEFAULTS.maxAudioBytes))
    const timeout=new AbortController()
    const timer=setTimeout(()=>timeout.abort(new DOMException('Timed out','TimeoutError')),Math.min(600000,Math.max(1,Number(config.timeoutMs)||DEFAULTS.timeoutMs)))
    const signal=AbortSignal.any([timeout.signal,this.closed.signal,...(externalSignal?[externalSignal]:[])])
    let acquired=false
    try{
      await this.acquire(signal);acquired=true;check(signal)
      const descriptor=await this.remoteConfig(base,config,signal),{fields,catalog}=descriptor
      const selected=catalog.resolveVoice(voice||config.defaultVoice,{language}) || (!voice&&catalog.modern?catalog.resolveVoice(catalog.defaultVoice,{language}):null)
      if(!selected)throw failure('SPEECH_VOICE_NOT_FOUND','没有找到这个音色，请用 #AI音色列表 查看完整名称。')
      let result
      if(descriptor.protocol==='gradio5'){
        if(Array.from(text).length>descriptor.maxCharacters)throw failure('SPEECH_TOO_LONG',`当前语音服务每次最多 ${descriptor.maxCharacters} 字，请缩短文字。`)
        const languageLabel=Object.keys(descriptor.languages).find(label=>descriptor.languages[label]===language)
        if(!languageLabel||selected.language!==language)throw failure('SPEECH_PROTOCOL','当前语音服务不支持这个语言与音色组合。')
        const submitted=await this.request(route(base,'gradio_api/call/generate'),{base,config,signal,method:'POST',body:JSON.stringify({data:[text,languageLabel,selected.id,'']})})
        const task=await boundedJson(submitted,65536,signal)
        if(typeof task.event_id!=='string'||!/^[-_a-zA-Z0-9]{1,128}$/.test(task.event_id))throw failure('SPEECH_PROTOCOL','语音服务没有返回有效的任务编号。')
        const stream=await this.request(route(base,'gradio_api/queue/data?session_hash='+encodeURIComponent(task.event_id)),{base,config,signal})
        result=await queueResult(stream,signal)
      }else{
      if(!fields[2].choices.includes(selected.label))throw failure('SPEECH_VOICE_NOT_FOUND','当前语音服务不提供这个音色，请更换音色或检查模型。')
      const languageLabel=fields[1].choices.find(value=>value===LANGUAGES[language]||(language==='mix'&&value.startsWith('中日混合')))
      if(!languageLabel)throw failure('SPEECH_PROTOCOL','当前语音服务不支持配置的语言。')
      const controls=[config.noiseScale,config.noiseScaleW,config.lengthScale]
      if(controls.some((value,index)=>!Number.isFinite(value)||value<(fields[index+3].minimum??0.1)||value>(fields[index+3].maximum??(index===2?2:1))))throw failure('SPEECH_PROTOCOL','语音合成参数超出服务允许范围。')
      const response=await this.request(route(base,'api/generate/'),{base,config,signal,method:'POST',body:JSON.stringify({data:[text,languageLabel,selected.label,...controls]})})
      result=await boundedJson(response,Math.ceil(maxAudioBytes*4/3)+65536,signal)
      }
      if(!Array.isArray(result.data)||!result.data[1]||result.error)throw failure('SPEECH_UNAVAILABLE','语音服务未生成音频，请缩短文字或稍后重试。')
      const audio=result.data[1],value=typeof audio==='string'?audio:audio.url||audio.path||audio.name
      let bytes
      if(typeof value==='string'&&value.startsWith('data:')){
        const match=/^data:audio\/(?:wav|x-wav);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value)
        if(!match||match[1].length%4!==0)throw failure('SPEECH_AUDIO_INVALID','语音服务返回了无效的内嵌音频。')
        bytes=Buffer.from(match[1],'base64')
        if(bytes.length>maxAudioBytes)throw failure('SPEECH_AUDIO_TOO_LARGE','语音服务返回的数据超过允许大小。')
      }else{
        const url=audioFileUrl(value,base,descriptor.protocol==='gradio5')
        const file=await this.request(url,{base,config,signal,audio:true})
        const mime=file.headers.get('content-type')?.split(';')[0].trim().toLowerCase()
        if(mime&&!['audio/wav','audio/x-wav','audio/wave','application/octet-stream'].includes(mime)){cancelBody(file.body);throw failure('SPEECH_AUDIO_INVALID','语音服务返回了网页或其他非音频内容。')}
        bytes=await boundedBytes(file,maxAudioBytes,signal)
      }
      check(signal)
      const durationSeconds=validateWav(bytes)
      return {type:'audio',data:bytes.toString('base64'),mime:'audio/wav',voice:selected.label,text,durationSeconds}
    }catch(error){
      if(signal.aborted)throw cancelled(signal)
      if(error instanceof SpeechError)throw error
      // Fetch errors may contain an address or credentials. Never forward their raw messages.
      throw failure('SPEECH_UNAVAILABLE','无法连接语音服务，请检查服务状态或稍后重试。')
    }finally{clearTimeout(timer);if(acquired)this.release()}
  }
}
