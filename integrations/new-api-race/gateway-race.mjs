import http from 'node:http'
import fs from 'node:fs'
import {createHash} from 'node:crypto'
import {pathToFileURL} from 'node:url'

export const candidatePattern=/^qqbot-race-(text|vision)-[a-z0-9-]+$/
const reasoningEfforts=new Set(['none','minimal','low','medium','high'])
const failure=(message,status=503,code='RACE_FAILED')=>Object.assign(new Error(message),{status,code})
const positive=(value,fallback)=>Number.isFinite(Number(value))&&Number(value)>0?Number(value):fallback
const aborted=signal=>signal?.reason instanceof Error?signal.reason:failure('Request cancelled',499,'CANCELLED')

async function cancellable(operation,signal){
  if(signal?.aborted)throw aborted(signal)
  let cancel
  const cancellation=new Promise((_,reject)=>{cancel=()=>reject(aborted(signal));signal?.addEventListener('abort',cancel,{once:true})})
  try{return await Promise.race([Promise.resolve().then(operation),cancellation])}
  finally{signal?.removeEventListener('abort',cancel)}
}

export function createRaceState({now=Date.now}={}){
  return {now,resources:new Map(),modelActive:new Map(),cooldowns:new Map(),paused:new Set(),tools:new Map(),stickyBytes:0,cursors:new Map()}
}
export function resetResourcePause(state,group){state.paused.delete(group);state.cooldowns.delete(group)}
const defaultState=createRaceState()

function requirements(body){
  const kinds=new Set()
  for(const message of body.messages||[])if(Array.isArray(message.content))for(const part of message.content){
    const kind={image_url:'vision',video_url:'video',input_audio:'audio',file:'file'}[part?.type]
    if(kind)kinds.add(kind)
  }
  if(body.model==='qqbot-vision')kinds.add('vision')
  const tools=Boolean(body.tools?.length)||(body.messages||[]).some(message=>message.role==='tool'||message.tool_calls?.length)||Boolean(body.tool_choice&&body.tool_choice!=='none'&&body.tool_choice!=='auto')
  return {kinds,tools,multimodal:kinds.size>0}
}

function specifications(models,body,policy={}){
  validateReasoningEfforts(policy)
  const inventory=new Set(models),need=requirements(body)
  if(!Array.isArray(policy.candidates)){
    // Existing deployments retain discovery behavior until a policy is supplied.
    return [...inventory].filter(model=>candidatePattern.test(model)&&(!need.multimodal||model.startsWith('qqbot-race-vision-'))&&(!need.tools||!model.endsWith('-notool')))
      .map(model=>({model,priority:0,resourceGroup:model,legacy:true}))
  }
  return policy.candidates.filter(candidate=>{
    if(!candidate||candidate.enabled===false||!candidatePattern.test(candidate.model)||!inventory.has(candidate.model))return false
    const capabilities=new Set(candidate.capabilities||[])
    const kind=need.multimodal?'vision':'text'
    if(!candidate.model.startsWith('qqbot-race-'+kind+'-'))return false
    if(!capabilities.has(kind)||[...need.kinds].some(value=>!capabilities.has(value)))return false
    return !need.tools||capabilities.has('tools')
  }).map(candidate=>({...candidate,priority:Number(candidate.priority)||0,resourceGroup:candidate.resourceGroup||candidate.model}))
    .filter((candidate,index,rows)=>rows.findIndex(other=>other.model===candidate.model)===index)
}

function validateReasoningEfforts(policy){
  for(const candidate of Array.isArray(policy.candidates)?policy.candidates:[]){
    if(candidate?.reasoningEffort!==undefined&&!reasoningEfforts.has(candidate.reasoningEffort))throw failure('Invalid candidate reasoningEffort',500,'INVALID_REASONING_EFFORT')
  }
}

export function candidatesFor(models,body,policy={}){return specifications(models,body,policy).map(candidate=>candidate.model)}

export function usable(result,body={}){
  const message=result?.choices?.[0]?.message
  if(!message)return false
  if(Array.isArray(message.tool_calls)&&message.tool_calls.length){
    if(body.tool_choice==='none')return false
    return message.tool_calls.every(call=>{
      const tool=body.tools?.find(candidate=>candidate.type==='function'&&candidate.function?.name===call.function?.name)
      if(call.type!=='function'||typeof call.id!=='string'||!call.id||!tool||typeof call.function.arguments!=='string')return false
      if(body.tool_choice?.type==='function'&&call.function.name!==body.tool_choice.function?.name)return false
      try{
        const args=JSON.parse(call.function.arguments)
        if(tool.function.parameters?.type==='object'&&(!args||typeof args!=='object'||Array.isArray(args)))return false
        return (tool.function.parameters?.required||[]).every(key=>Object.hasOwn(args,key))
      }catch{return false}
    })
  }
  const forced=body.tool_choice==='required'||(body.tool_choice&&typeof body.tool_choice==='object')
  if(forced)return false
  const visible=text=>typeof text==='string'&&text.replace(/<think>[\s\S]*?<\/think>/gi,'').replace(/<think>[\s\S]*$/gi,'').replace(/<\/?(?:answer|analysis|reasoning)>/gi,'').trim().length>0
  return visible(message.content)||(Array.isArray(message.content)&&message.content.some(part=>visible(part.text)))
}

export function retryAfterMs(value,now=Date.now(),fallback=30000){
  if(value==null||value==='')return fallback
  const seconds=Number(value)
  const duration=Number.isFinite(seconds)?seconds*1000:Date.parse(value)-now
  return Number.isFinite(duration)?Math.max(1000,Math.min(300000,duration)):fallback
}

async function upstreamErrorCode(response,signal){
  const reader=response.body?.getReader?.()
  if(!reader)return ''
  const chunks=[];let size=0
  try{
    while(size<16384){
      const {done,value}=await cancellable(()=>reader.read(),signal)
      if(done)break
      const part=value.subarray(0,16384-size);chunks.push(part);size+=part.byteLength
      if(part.byteLength<value.byteLength)break
    }
  }finally{Promise.resolve(reader.cancel()).catch(()=>{})}
  const text=Buffer.concat(chunks).toString('utf8')
  let fields=[]
  try{const value=JSON.parse(text);fields=[value?.error?.code,value?.error?.type,value?.code,value?.type]}
  catch{fields=[...text.matchAll(/"(?:code|type)"\s*:\s*"([^"\\]{1,128})"/g)].map(match=>match[1])}
  // Only these public protocol codes escape the bounded buffer. Never retain
  // messages, URLs, arbitrary code strings or the upstream body in state/logs.
  for(const field of fields)if(typeof field==='string')for(const code of ['insufficient_quota','quota_exceeded','rate_limit_exceeded'])if(new RegExp('(?:^|[^a-z_])'+code+'(?:$|[^a-z_])','i').test(field))return code
  return ''
}

function canonical(value){
  if(Array.isArray(value))return value.map(canonical)
  if(value&&typeof value==='object')return Object.fromEntries(Object.keys(value).sort().map(key=>[key,canonical(value[key])]))
  return value
}
function assistantSignature(message){
  const content=message.content==null?'':Array.isArray(message.content)&&message.content.every(part=>part.type==='text')?message.content.map(part=>part.text||'').join('\n'):message.content
  const calls=(message.tool_calls||[]).map(call=>{
    let args=call.function?.arguments
    try{args=JSON.parse(args)}catch{}
    return {id:call.id,type:call.type,name:call.function?.name,arguments:args}
  })
  return createHash('sha256').update(JSON.stringify(canonical({content,calls}))).digest('hex')
}
function restoreReasoning(payload,candidate,state){
  if(!candidate.restoreToolReasoning)return
  for(const {message,keys}of toolReferences(payload)){
    if(Object.hasOwn(message,'reasoning_content'))continue
    const cached=keys.map(key=>state.tools.get(key)).find(row=>row?.model===candidate.model&&row.expiresAt>state.now()&&typeof row.reasoning==='string')
    if(cached)message.reasoning_content=cached.reasoning
  }
}
function payloadFor(body,candidate,resource,state){
  const payload=structuredClone(body)
  payload.model=candidate.model;payload.stream=false
  if(candidate.reasoningEffort!==undefined)payload.reasoning_effort=candidate.reasoningEffort
  if(candidate.normalizeImageDetail)for(const message of payload.messages||[])if(Array.isArray(message.content))for(const part of message.content){
    if(part.type==='image_url'&&part.image_url&&typeof part.image_url==='object'&&part.image_url.detail==null)part.image_url.detail='auto'
  }
  restoreReasoning(payload,candidate,state)
  const cap=positive(candidate.maxOutputTokens,positive(resource.maxOutputTokens,resource.tokensPerMinute?4096:Infinity))
  if(Number.isFinite(cap)){
    const field=Object.hasOwn(payload,'max_completion_tokens')?'max_completion_tokens':'max_tokens'
    payload[field]=Math.min(positive(payload[field],cap),cap)
  }
  return payload
}

function reservation(state,candidate,payload,resource){
  const now=state.now(),group=candidate.resourceGroup
  if(state.paused.has(group))return {ok:false,reason:'quota_paused'}
  if((state.cooldowns.get(group)||0)>now)return {ok:false,reason:'cooldown'}
  const usage=state.resources.get(group)||{active:0,requests:[]}
  usage.requests=usage.requests.filter(row=>row.at>now-60000)
  state.resources.set(group,usage)
  if(usage.active>=positive(resource.maxConcurrent,Infinity)||(state.modelActive.get(candidate.model)||0)>=positive(candidate.maxConcurrent,Infinity))return {ok:false,reason:'capacity'}
  if(usage.requests.length>=positive(resource.requestsPerMinute,Infinity))return {ok:false,reason:'rate_budget'}
  // Base64 bytes are not text tokens. Count each image with a fixed configured
  // allowance, without downloading or decoding user images. This is a guard,
  // neither an exact tokenizer nor an InkStone account balance.
  let images=0
  const budgetMessages=(payload.messages||[]).map(message=>({...message,content:!Array.isArray(message.content)?message.content:message.content.map(part=>{
    if(part.type!=='image_url')return part
    images++;return {...part,image_url:{detail:part.image_url?.detail||'auto',url:'[image]'}}
  })}))
  const estimatedTokens=Buffer.byteLength(JSON.stringify(budgetMessages),'utf8')+images*positive(resource.imageTokenBudget,16384)+Buffer.byteLength(JSON.stringify(payload.tools||[]),'utf8')+128+positive(payload.max_completion_tokens,positive(payload.max_tokens,4096))
  if(usage.requests.reduce((sum,row)=>sum+row.tokens,0)+estimatedTokens>positive(resource.tokensPerMinute,Infinity))return {ok:false,reason:'token_budget'}
  usage.active++;usage.requests.push({at:now,tokens:estimatedTokens})
  state.modelActive.set(candidate.model,(state.modelActive.get(candidate.model)||0)+1)
  let released=false
  return {ok:true,release(){if(released)return;released=true;usage.active--;state.modelActive.set(candidate.model,Math.max(0,(state.modelActive.get(candidate.model)||0)-1))}}
}

function currentToolMessages(body){
  let lastUser=-1
  for(let index=0;index<(body.messages||[]).length;index++)if(body.messages[index].role==='user')lastUser=index
  return body.messages.slice(lastUser+1)
}
function toolScope(body){
  const messages=body.messages||[]
  let user=null
  for(let index=messages.length-1;index>=0;index--)if(messages[index].role==='user'){user=messages[index];break}
  // A caller-provided user identifier and the current user message isolate
  // chains without retaining their text. System tasks may change between tool
  // rounds. Identical requests without a caller identifier are indistinguishable.
  return createHash('sha256').update(JSON.stringify(canonical({user:body.user??null,message:user}))).digest('hex')
}
function toolReferences(body,messages=currentToolMessages(body)){
  const scope=toolScope(body),references=[]
  for(const message of messages){
    if(message?.role!=='assistant'||!message.tool_calls?.length)continue
    const signature=assistantSignature(message),keys=[]
    for(const call of message.tool_calls)if(typeof call.id==='string'&&call.id&&Buffer.byteLength(call.id,'utf8')<=1024){
      keys.push(createHash('sha256').update(JSON.stringify([scope,signature,call.id])).digest('hex'))
    }
    if(keys.length)references.push({message,signature,keys})
  }
  return references
}

function stickyCandidate(body,candidates,state){
  for(const key of toolReferences(body).flatMap(reference=>reference.keys).reverse()){
    const cached=state.tools.get(key)
    if(!cached)continue
    if(cached.expiresAt<=state.now()){forgetTool(state,key);continue}
    const candidate=candidates.find(row=>row.model===cached.model)
    if(candidate)return candidate
  }
  return null
}

function forgetTool(state,id){
  const cached=state.tools.get(id)
  if(cached){state.stickyBytes-=cached.bytes||0;clearTimeout(cached.expiryTimer)}
  state.tools.delete(id)
}
function rememberTools(body,result,winner,state,policy){
  const ttl=positive(policy.stickyTtlMs,300000),limit=positive(policy.maxStickyEntries,1000),byteLimit=positive(policy.maxStickyBytes,1048576)
  const perEntryLimit=Math.min(65536,positive(policy.maxReasoningBytes,65536))
  const keepReasoning=policy.candidates?.some(candidate=>candidate.model===winner&&candidate.restoreToolReasoning===true)
  for(const [id,row]of state.tools)if(row.expiresAt<=state.now())forgetTool(state,id)
  const assistant=result?.choices?.[0]?.message,newReferences=toolReferences(body,assistant?[assistant]:[])
  const additions=new Map()
  for(const reference of toolReferences(body))for(const key of reference.keys){
    const prior=state.tools.get(key)
    // Existing transcript calls only extend their original cache entry. They
    // cannot create a cache entry or move another model's reasoning to a winner.
    if(prior)additions.set(key,{signature:reference.signature,model:prior.model,reasoning:keepReasoning&&prior.model===winner?prior.reasoning:undefined})
  }
  for(const reference of newReferences)for(const key of reference.keys)additions.set(key,{signature:reference.signature,model:winner,reasoning:keepReasoning?assistant.reasoning_content:undefined})
  for(const [key,addition]of additions){
    const row={model:addition.model,signature:addition.signature,expiresAt:state.now()+ttl,bytes:0}
    const reasoning=addition.reasoning
    const bytes=typeof reasoning==='string'?Buffer.byteLength(reasoning,'utf8'):0
    if(bytes>0&&bytes<=perEntryLimit&&bytes<=byteLimit){row.reasoning=reasoning;row.bytes=bytes}
    forgetTool(state,key);state.tools.set(key,row);state.stickyBytes+=row.bytes
    row.expiryTimer=setTimeout(()=>{if(state.tools.get(key)===row)forgetTool(state,key)},ttl)
    row.expiryTimer.unref?.()
  }
  while(state.tools.size>limit||state.stickyBytes>byteLimit)forgetTool(state,state.tools.keys().next().value)
}

export async function raceCompletion({body,models,fetcher=fetch,base,key,signal,timeoutMs=8000,onAttempt=()=>{},policy={},state=defaultState}){
  const candidates=specifications(models,body,policy)
  if(!candidates.length)throw failure('No compatible enabled race candidates',503,'NO_CANDIDATES')
  const started=state.now(),controller=new AbortController()
  const combined=signal?AbortSignal.any([signal,controller.signal]):controller.signal
  const timer=setTimeout(()=>controller.abort(failure('Race deadline exceeded',504,'DEADLINE')),positive(timeoutMs,8000))
  const bestPriority=Math.max(...candidates.map(row=>row.priority)),sticky=stickyCandidate(body,candidates,state)
  const priorities=[...new Set(candidates.map(row=>row.priority))].sort((a,b)=>b-a)
  const groups=priorities.map(priority=>candidates.filter(row=>row.priority===priority&&row!==sticky)).filter(rows=>rows.length)
  if(sticky)groups.unshift([sticky])
  let attemptCount=0,lastStatus=0,timedOut=false
  const events=[]
  const report=event=>{events.push(event);try{onAttempt(event)}catch{}}
  try{
    for(let index=0;index<groups.length;index++){
      if(combined.aborted)throw aborted(combined)
      const remaining=positive(timeoutMs,8000)-(state.now()-started)
      if(remaining<=0)throw failure('Race deadline exceeded',504,'DEADLINE')
      const reserve=index<groups.length-1?Math.min(positive(policy.fallbackReserveMs,1500),remaining):0
      const stageBudget=remaining-reserve
      if(stageBudget<=0)continue
      const stage=new AbortController()
      const stageSignal=AbortSignal.any([combined,stage.signal])
      const stageTimer=setTimeout(()=>stage.abort(failure('Priority group deadline exceeded',504,'TIER_DEADLINE')),stageBudget)
      const rows=groups[index]
      const maxParallel=Math.max(1,Math.floor(positive(policy.maxParallel,Array.isArray(policy.candidates)?2:rows.length)))
      const cursorKey=rows.map(row=>row.model).join('|'),cursor=state.cursors.get(cursorKey)||0
      state.cursors.set(cursorKey,(cursor+maxParallel)%rows.length)
      const rotated=[...rows.slice(cursor),...rows.slice(0,cursor)].slice(0,positive(policy.maxAttemptsPerTier,Array.isArray(policy.candidates)?4:rows.length))
      try{
      while(rotated.length&&!stageSignal.aborted){
      const selected=[]
      while(rotated.length){
        const candidate=rotated.shift()
        const resource=policy.resources?.[candidate.resourceGroup]||{}
        const payload=payloadFor(body,candidate,resource,state),slot=reservation(state,candidate,payload,resource)
        if(!slot.ok){report({model:candidate.model,priority:candidate.priority,status:0,ms:state.now()-started,usable:false,skipped:true,reason:slot.reason});continue}
        selected.push({candidate,payload,slot})
        if(selected.length>=maxParallel)break
      }
      try{
        if(!selected.length)break
        const operations=selected.map(async({candidate,payload,slot})=>{
          attemptCount++
          const attempt=new AbortController(),attemptSignal=AbortSignal.any([stageSignal,attempt.signal])
          const attemptTimer=setTimeout(()=>attempt.abort(failure('Candidate deadline exceeded',504,'CANDIDATE_DEADLINE')),Math.min(stageBudget,positive(candidate.timeoutMs,stageBudget)))
          let status=0
          try{
            const response=await cancellable(()=>fetcher(base+'/chat/completions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+key},body:JSON.stringify(payload),signal:attemptSignal}),attemptSignal)
            status=response.status;lastStatus=status
            if(!response.ok){
              const code=await upstreamErrorCode(response,attemptSignal)
              const resource=policy.resources?.[candidate.resourceGroup]||{}
              const pauseOnQuota=resource.pauseOnQuotaExceeded??candidate.resourceGroup==='intern'
              if(pauseOnQuota&&['quota_exceeded','insufficient_quota'].includes(code)){
                state.paused.add(candidate.resourceGroup)
                throw failure('Candidate resource quota exhausted',status,'QUOTA_EXCEEDED')
              }
              if(status===429||code==='rate_limit_exceeded')state.cooldowns.set(candidate.resourceGroup,state.now()+retryAfterMs(response.headers?.get('retry-after'),state.now(),positive(policy.cooldownMs,30000)))
              // Never include response bodies, request text, credentials or URLs
              // in failures/observability. A rejected body need not be downloaded.
              throw failure('Candidate HTTP error',status,'UPSTREAM_HTTP')
            }
            const result=await cancellable(()=>response.json(),attemptSignal)
            if(attemptSignal.aborted)throw aborted(attemptSignal)
            if(!usable(result,body))throw failure('Candidate returned no usable answer',502,'UNUSABLE')
            if(candidate.rejectTruncated&&result.choices[0].finish_reason==='length')throw failure('Candidate returned a truncated answer',502,'TRUNCATED')
            report({model:candidate.model,priority:candidate.priority,status,ms:state.now()-started,usable:true})
            result.model=body.model
            return {result,winner:candidate.model,priority:candidate.priority}
          }catch(error){if(String(error.code).includes('DEADLINE'))timedOut=true;report({model:candidate.model,priority:candidate.priority,status,ms:state.now()-started,usable:false,reason:attemptSignal.aborted?'cancelled':error.code||'UPSTREAM_ERROR'});throw error}
          finally{clearTimeout(attemptTimer);slot.release()}
        })
        const winner=await cancellable(()=>Promise.any(operations),combined)
        stage.abort(failure('Another candidate won',499,'LOSER_CANCELLED'))
        rememberTools(body,winner.result,winner.winner,state,policy)
        return {...winner,ms:state.now()-started,candidates:candidates.map(row=>row.model),attemptCount,fallback:winner.priority<bestPriority,sticky:winner.winner===sticky?.model,events}
      }catch(error){if(combined.aborted)throw aborted(combined)}
      }
      }
      finally{clearTimeout(stageTimer);stage.abort(failure('Priority group completed',499,'GROUP_COMPLETE'))}
    }
    if(combined.aborted)throw aborted(combined)
    if(timedOut)throw failure('Race candidates exceeded their deadline',504,'DEADLINE')
    throw failure('All compatible candidates failed or are temporarily unavailable',lastStatus===429?429:503,'ALL_CANDIDATES_FAILED')
  }finally{clearTimeout(timer);controller.abort(failure('Race completed',499,'RACE_COMPLETE'))}
}

function readBody(req,signal,maxBytes){
  return cancellable(()=>new Promise((resolve,reject)=>{
    const chunks=[];let bytes=0
    const cleanup=()=>{req.off('data',data);req.off('end',end);req.off('error',error);signal.removeEventListener('abort',cancel)}
    const fail=value=>{cleanup();req.resume();reject(value)}
    const data=chunk=>{bytes+=chunk.length;if(bytes>maxBytes)fail(failure('Request too large',413,'BODY_TOO_LARGE'));else chunks.push(chunk)}
    const end=()=>{cleanup();resolve(Buffer.concat(chunks).toString())}
    const error=value=>fail(value),cancel=()=>fail(aborted(signal))
    req.on('data',data);req.once('end',end);req.once('error',error);signal.addEventListener('abort',cancel,{once:true})
  }),signal)
}

export function startServer(config){
  const base=config.base.replace(/\/$/,''),fetcher=config.fetcher||fetch,policy=config.race||{},state=createRaceState()
  validateReasoningEfforts(policy)
  const totalMs=positive(config.timeoutMs,8000),inventoryMs=positive(config.inventoryTimeoutMs,1500)
  let inventory=[],lastInventory=0
  const stats={requests:0,winners:{},failures:0,attempts:0,skipped:0,fallbacks:0}
  async function models(signal){
    if(Date.now()-lastInventory<3000)return inventory
    const timeout=AbortSignal.timeout(Math.max(1,Math.floor(inventoryMs)))
    const combined=AbortSignal.any([signal,timeout])
    try{
      const response=await cancellable(()=>fetcher(base+'/models',{headers:{Authorization:'Bearer '+config.gatewayKey},signal:combined}),combined)
      if(!response.ok)throw failure('Gateway model inventory unavailable')
      const data=await cancellable(()=>response.json(),combined)
      inventory=(data.data||[]).map(model=>model.id).filter(name=>candidatePattern.test(name));lastInventory=Date.now()
      return inventory
    }catch(error){if(signal.aborted)throw aborted(signal);if(inventory.length)return inventory;throw failure('Gateway model inventory unavailable',503,'INVENTORY_UNAVAILABLE')}
  }
  const server=http.createServer(async(req,res)=>{
    function send(status,value,extra={}){if(res.destroyed||res.writableEnded)return;res.writeHead(status,{'Content-Type':'application/json',...extra});res.end(JSON.stringify(value))}
    if(req.url==='/healthz'){send(200,{ready:true,stats,candidates:inventory,timeoutMs:totalMs,maxParallel:positive(policy.maxParallel,Array.isArray(policy.candidates)?2:inventory.length),stickyEntries:state.tools.size,pausedResourceGroups:[...state.paused]});return}
    if(req.headers.authorization!=='Bearer '+config.secret){send(401,{error:{message:'Unauthorized'}});return}
    if(req.method==='GET'&&req.url==='/v1/models'){send(200,{object:'list',data:['qqbot-text','qqbot-vision'].map(id=>({id,object:'model',owned_by:'gateway-race'}))});return}
    if(req.method!=='POST'||req.url!=='/v1/chat/completions'){send(404,{error:{message:'Unsupported endpoint'}});return}
    const controller=new AbortController(),started=Date.now()
    const timer=setTimeout(()=>controller.abort(failure('Request deadline exceeded',504,'DEADLINE')),totalMs)
    req.on('aborted',()=>controller.abort(failure('Client disconnected',499,'CLIENT_DISCONNECTED')))
    res.on('close',()=>{if(!res.writableEnded)controller.abort(failure('Client disconnected',499,'CLIENT_DISCONNECTED'))})
    try{
      const body=JSON.parse(await readBody(req,controller.signal,16*1024*1024))
      if(!['qqbot-text','qqbot-vision'].includes(body.model))throw failure('Invalid entry model',400,'INVALID_MODEL')
      if(body.stream)throw failure('This race entry supports non-streaming requests',400,'STREAM_UNSUPPORTED')
      if(!Array.isArray(body.messages))throw failure('messages must be an array',400,'INVALID_MESSAGES')
      stats.requests++
      const enabled=await models(controller.signal)
      const remaining=totalMs-(Date.now()-started)
      if(remaining<=0)throw failure('Request deadline exceeded',504,'DEADLINE')
      const result=await raceCompletion({body,models:enabled,base,key:config.gatewayKey,fetcher,signal:controller.signal,timeoutMs:remaining,policy,state,onAttempt:event=>{if(event.skipped)stats.skipped++;else stats.attempts++}})
      if(controller.signal.aborted)return
      stats.winners[result.winner]=(stats.winners[result.winner]||0)+1
      if(result.fallback)stats.fallbacks++
      if(config.log!==false)(config.log||console.log)(JSON.stringify({event:'winner',model:result.winner,priority:result.priority,ms:Date.now()-started,attempts:result.attemptCount,fallback:result.fallback,sticky:result.sticky}))
      send(200,result.result,{'x-qqbot-race-winner':result.winner,'x-qqbot-race-priority':String(result.priority),'x-qqbot-race-attempts':String(result.attemptCount),'x-qqbot-race-fallback':String(result.fallback),'x-qqbot-race-sticky':String(result.sticky)})
    }catch(error){stats.failures++;send(error instanceof SyntaxError?400:error.status||503,{error:{message:error instanceof SyntaxError?'Invalid JSON':error.status?error.message:'Gateway request failed',type:'gateway_race_error',code:'QQBOT_RACE_FAILED'}},{'x-should-retry':'false'})}
    finally{clearTimeout(timer)}
  })
  server.requestTimeout=positive(config.requestTimeoutMs,totalMs+2000)
  server.headersTimeout=Math.min(server.requestTimeout,positive(config.headersTimeoutMs,10000))
  server.listen(config.port??8080,config.host||'0.0.0.0')
  return server
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)startServer(JSON.parse(fs.readFileSync(process.argv[2]||'/run/config.json','utf8')))
