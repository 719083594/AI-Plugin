import test from 'node:test'
import assert from 'node:assert/strict'
import {once} from 'node:events'
import http from 'node:http'
import {readFileSync} from 'node:fs'
import {candidatesFor,createRaceState,raceCompletion,resetResourcePause,retryAfterMs,startServer,usable} from './gateway-race.mjs'

const high='qqbot-race-text-intern-new',peer='qqbot-race-text-intern-peer',old='qqbot-race-text-old'
const vision='qqbot-race-vision-intern-new'
const body=()=>({model:'qqbot-text',messages:[{role:'system',content:'角色原文。数字/链接照实保留。'},{role:'user',content:'合成问题，不连接真实模型。'}]})
const result=(text='合成有效回答。')=>({model:'upstream-model',choices:[{message:{role:'assistant',content:text}}]})
const response=(value,status=200,headers={})=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json',...headers}})
const spec=(model,priority=100,extra={})=>({model,priority,capabilities:[model.includes('-vision-')?'vision':'text','tools'],resourceGroup:model.startsWith('qqbot-race-text-intern')||model===vision?'intern':model,...extra})
const policy=(extra={})=>({maxParallel:2,fallbackReserveMs:60,candidates:[spec(high),spec(peer),spec(old,0)],resources:{intern:{maxConcurrent:2}},...extra})
function mockFetcher(run){
  const calls=[],cancelled=[]
  const fetcher=async(url,options)=>{
    const payload=JSON.parse(options.body),call={url,payload,signal:options.signal};calls.push(call)
    const value=await run(payload.model,call)
    if(value instanceof Response)return value
    const {delay=0,status=200,answer=result(),headers={}}=value||{}
    await new Promise((resolve,reject)=>{
      if(options.signal.aborted){cancelled.push(payload.model);reject(options.signal.reason);return}
      const timer=setTimeout(()=>{options.signal.removeEventListener('abort',abort);resolve()},delay)
      const abort=()=>{clearTimeout(timer);cancelled.push(payload.model);reject(options.signal.reason)}
      options.signal.addEventListener('abort',abort,{once:true})
    })
    return response(answer,status,headers)
  }
  return {fetcher,calls,cancelled}
}
function run(mock,options={}){return raceCompletion({body:body(),models:[high,peer,old],base:'https://upstream.invalid/v1',key:'synthetic-test-key',fetcher:mock.fetcher,state:createRaceState(),policy:policy(),timeoutMs:250,...options})}
const tool={type:'function',function:{name:'lookup',parameters:{type:'object',properties:{query:{type:'string'}},required:['query']}}}
const toolResult=(id='tool-one',reasoning)=>({choices:[{message:{role:'assistant',content:null,...(reasoning===undefined?{}:{reasoning_content:reasoning}),tool_calls:[{id,type:'function',function:{name:'lookup',arguments:'{ "query" : "synthetic" }'}}]}}]})
const toolBody=()=>({...body(),tools:[tool]})
const continuation=(initial,id='tool-one')=>({...initial,tools:[],messages:[...initial.messages,{role:'assistant',content:'',tool_calls:[{id,type:'function',function:{name:'lookup',arguments:'{"query":"synthetic"}'}}]},{role:'tool',tool_call_id:id,content:'实际合成结果：42。'}]})

test('configured capabilities separate text, images, tools and other modalities; legacy discovery remains compatible',()=>{
  const models=[high,vision,old,'qqbot-race-text-old-notool','unrelated']
  const configured=policy({candidates:[spec(high),spec(vision),spec(old,0,{capabilities:['text']}),spec('qqbot-race-text-old-notool',0,{capabilities:['text']})]})
  assert.deepEqual(candidatesFor(models,body(),configured),[high,old,'qqbot-race-text-old-notool'])
  assert.deepEqual(candidatesFor(models,toolBody(),configured),[high])
  const image={...body(),messages:[{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,synthetic'}}]}]}
  assert.deepEqual(candidatesFor(models,image,configured),[vision])
  assert.deepEqual(candidatesFor(models,{...body(),model:'qqbot-vision'},configured),[vision])
  assert.deepEqual(candidatesFor(models,{...body(),messages:[{role:'user',content:[{type:'input_audio',input_audio:{data:'synthetic'}}]}]},configured),[])
  assert(candidatesFor(models,body()).includes(vision),'no-policy deployment retains original discovery behavior')
  assert(!candidatesFor(models,toolBody()).includes('qqbot-race-text-old-notool'))
})

test('a faster low-priority model never races a healthy quality group',async()=>{
  const mock=mockFetcher(model=>({delay:model===high?25:model===peer?80:0}))
  const winner=await run(mock)
  assert.equal(winner.winner,high);assert.equal(winner.fallback,false)
  assert.equal(winner.attemptCount,2)
  assert.deepEqual(mock.calls.map(call=>call.payload.model),[high,peer])
  await new Promise(resolve=>setTimeout(resolve,0))
  assert(mock.cancelled.includes(peer),'losing quality request is cancelled immediately')
})

test('fallback starts only after the quality group fails and remains observable',async()=>{
  const mock=mockFetcher(model=>({status:model===old?200:500}))
  const winner=await run(mock)
  assert.equal(winner.winner,old);assert.equal(winner.fallback,true);assert.equal(winner.priority,0)
  assert.equal(winner.attemptCount,3)
  assert.deepEqual(mock.calls.map(call=>call.payload.model),[high,peer,old])
})

test('a large quality catalog launches at most two candidates, not ten provider requests',async()=>{
  const models=Array.from({length:10},(_,index)=>'qqbot-race-text-intern-'+index)
  const mock=mockFetcher(()=>({delay:10}))
  const winner=await run(mock,{models,policy:policy({candidates:models.map(model=>spec(model))})})
  assert.equal(mock.calls.length,2);assert.equal(winner.attemptCount,2)
})

test('shared provider capacity applies across independent requests and releases after completion',async()=>{
  const state=createRaceState(),p=policy({candidates:[spec(high),spec(old,0)],resources:{intern:{maxConcurrent:1}}})
  const mock=mockFetcher(model=>({delay:model===high?35:1}))
  const first=run(mock,{state,policy:p})
  await new Promise(resolve=>setTimeout(resolve,3))
  const second=await run(mock,{state,policy:p})
  assert.equal(second.winner,old);assert(second.events.some(event=>event.skipped&&event.reason==='capacity'))
  assert.equal((await first).winner,high)
  assert.equal(state.resources.get('intern').active,0)
  assert.equal((await run(mock,{state,policy:p})).winner,high)
})

test('429 Retry-After cools every alias on the shared account across requests without immediate retry',async()=>{
  let now=100000,limited=true
  const state=createRaceState({now:()=>now}),p=policy({maxParallel:1})
  const mock=mockFetcher(model=>({status:model!==old&&limited?429:200,headers:{'retry-after':'10'}}))
  assert.equal((await run(mock,{state,policy:p})).winner,old)
  const before=mock.calls.length
  assert.equal((await run(mock,{state,policy:p})).winner,old)
  assert.deepEqual(mock.calls.slice(before).map(call=>call.payload.model),[old])
  assert.equal(state.cooldowns.get('intern'),110000)
  now=110001;limited=false
  assert.notEqual((await run(mock,{state,policy:p})).winner,old)
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:02:00 GMT',100000),20000)
  assert.equal(retryAfterMs('invalid',100000),30000)
})

test('rate-limit errors recover after Retry-After while quota errors pause the Intern account until explicit reset',async()=>{
  let now=100000,code='rate_limit_exceeded'
  const state=createRaceState({now:()=>now}),p=policy({maxParallel:1})
  const mock=mockFetcher(model=>({status:model===old?200:429,answer:model===old?result():{error:{code,message:'PRIVATE_ERROR_BODY'}},headers:{'retry-after':'2'}}))
  await run(mock,{state,policy:p});assert(!state.paused.has('intern'))
  assert.equal(state.cooldowns.get('intern'),102000)
  now=102001;code='wrapped: insufficient_quota'
  await run(mock,{state,policy:p});assert(state.paused.has('intern'))
  now+=600000
  const before=mock.calls.length
  const fallback=await run(mock,{state,policy:p})
  assert.equal(fallback.winner,old);assert.deepEqual(mock.calls.slice(before).map(call=>call.payload.model),[old])
  assert(fallback.events.some(event=>event.reason==='quota_paused'))
  assert.doesNotMatch(JSON.stringify(fallback.events),/PRIVATE_ERROR_BODY|wrapped/)
  resetResourcePause(state,'intern');assert(!state.paused.has('intern'))
  assert(!createRaceState().paused.has('intern'),'a gateway restart has fresh resource state')
})

test('quota classification reads at most 16 KiB, retains only a safe code and never pauses legacy resources',async()=>{
  let consumed=0,cancelled=false
  const longBody='{"error":{"code":"quota_exceeded","message":"'+'PRIVATE_'.repeat(100000)
  const stream=new ReadableStream({pull(controller){const chunk=longBody.slice(consumed,consumed+4096);consumed+=chunk.length;controller.enqueue(new TextEncoder().encode(chunk))},cancel(){cancelled=true}})
  const mock={fetcher:async(_url,options)=>JSON.parse(options.body).model===old?response(result()):new Response(stream,{status:429})}
  const state=createRaceState()
  assert.equal((await run(mock,{state,policy:policy({candidates:[spec(high),spec(old,0)]})})).winner,old)
  assert(state.paused.has('intern'));assert(cancelled);assert(consumed<=20480,'stream may prefetch one chunk, bounded parser retains only 16 KiB')
  assert.doesNotMatch(JSON.stringify([...state.paused]),/PRIVATE_/)
  const legacyState=createRaceState(),bad=mockFetcher(()=>({status:429,answer:{error:{code:'quota_exceeded'}}}))
  await assert.rejects(run(bad,{models:[old],state:legacyState,policy:policy({candidates:[spec(old,0)]})}))
  assert(!legacyState.paused.has(old))
})

test('RPM and conservative token reservations are shared and count failed attempts too',async()=>{
  let now=100000
  const state=createRaceState({now:()=>now}),mock=mockFetcher(model=>({status:model===high?500:200}))
  const p=policy({candidates:[spec(high),spec(old,0)],resources:{intern:{requestsPerMinute:1,maxOutputTokens:100}}})
  await run(mock,{state,policy:p})
  const before=mock.calls.length
  assert.equal((await run(mock,{state,policy:p})).winner,old)
  assert.deepEqual(mock.calls.slice(before).map(call=>call.payload.model),[old])
  now+=60001
  await run(mock,{state,policy:p})
  assert.equal(mock.calls.filter(call=>call.payload.model===high).length,2)
  const tooSmall=policy({candidates:[spec(high),spec(old,0)],resources:{intern:{tokensPerMinute:100,maxOutputTokens:64}}})
  const limited=await run(mock,{state:createRaceState(),policy:tooSmall})
  assert(limited.events.some(event=>event.reason==='token_budget'))
})

test('priority time budget reserves a real fallback window and cancels stalled primary attempts',async()=>{
  const mock=mockFetcher(model=>({delay:model===old?1:1000}))
  const start=Date.now(),winner=await run(mock,{timeoutMs:100,policy:policy({fallbackReserveMs:45})})
  assert.equal(winner.winner,old);assert(Date.now()-start<180)
  assert(mock.cancelled.includes(high));assert(mock.cancelled.includes(peer))
})

test('multiple priority stages preserve the full configured window for the last fallback group',async()=>{
  const middle='qqbot-race-text-middle'
  const p=policy({fallbackReserveMs:130,candidates:[spec(high,300,{timeoutMs:100}),spec(middle,200),spec(old,0)]})
  const mock=mockFetcher(model=>({delay:model===old?105:1000}))
  const winner=await run(mock,{models:[high,middle,old],policy:p,timeoutMs:320})
  assert.equal(winner.winner,old);assert.equal(winner.fallback,true)
})

test('a third legacy fallback remains reachable after its first two peers fail with bounded parallelism',async()=>{
  const third='qqbot-race-text-third'
  const mock=mockFetcher(model=>({status:model===third?200:500}))
  const winner=await run(mock,{models:[old,high,third],policy:policy({candidates:[spec(old,0),spec(high,0),spec(third,0)]})})
  assert.equal(winner.winner,third);assert.equal(winner.attemptCount,3)
})

test('external cancellation and hard deadline finish even if a fetch implementation ignores its signal',async()=>{
  const controller=new AbortController(),never={fetcher:()=>new Promise(()=>{})}
  const start=Date.now(),pending=run(never,{signal:controller.signal})
  setTimeout(()=>controller.abort(new Error('synthetic caller cancelled')),10)
  await assert.rejects(pending,/synthetic caller cancelled/)
  assert(Date.now()-start<150)
  await assert.rejects(run(never,{timeoutMs:35,policy:policy({candidates:[spec(high)]})}),error=>error.status===504)
})

test('candidate-only image normalization and output limits leave the original prompt and payload untouched',async()=>{
  const original={...body(),model:'qqbot-vision',max_tokens:9999,messages:[...body().messages,{role:'user',content:[{type:'image_url',image_url:{url:'data:image/png;base64,one'}},{type:'image_url',image_url:{url:'data:image/png;base64,two',detail:'high'}}]}]}
  const snapshot=structuredClone(original),mock=mockFetcher(()=>({}))
  await run(mock,{body:original,models:[vision],policy:policy({candidates:[spec(vision,100,{normalizeImageDetail:true})],resources:{intern:{maxOutputTokens:512}}})})
  const payload=mock.calls[0].payload
  assert.deepEqual(original,snapshot)
  assert.equal(payload.messages.at(-1).content[0].image_url.detail,'auto')
  assert.equal(payload.messages.at(-1).content[1].image_url.detail,'high')
  assert.equal(payload.messages[0].content,original.messages[0].content)
  assert.equal(payload.max_tokens,512);assert(!Object.hasOwn(payload,'thinking'))
})

test('large image DataURLs use an image allowance instead of millions of text tokens, without decoding',async()=>{
  const largeImage='data:image/png;base64,'+'A'.repeat(3*1024*1024)
  const imageBody={...body(),model:'qqbot-vision',messages:[{role:'user',content:[{type:'text',text:'合成图片问题'},{type:'image_url',image_url:{url:largeImage}}]}]}
  const state=createRaceState(),mock=mockFetcher(()=>({}))
  const p=policy({candidates:[spec(vision)],resources:{intern:{tokensPerMinute:50000,maxOutputTokens:1024}}})
  assert.equal((await run(mock,{body:imageBody,models:[vision],policy:p,state})).winner,vision)
  assert(state.resources.get('intern').requests[0].tokens<20000)
  assert.equal(mock.calls[0].payload.messages[0].content[1].image_url.url,largeImage)
})

test('a winning tool chain stays on its compatible winner while system task text changes',async()=>{
  const state=createRaceState(),p=policy(),initial=toolBody()
  const first=mockFetcher(model=>({delay:model===peer?1:20,answer:toolResult()}))
  assert.equal((await run(first,{state,policy:p,body:initial})).winner,peer)
  const next=continuation(initial);next.messages[0].content+='\n本轮搜索任务与当前角色原文。'
  const second=mockFetcher(()=>({answer:result('结果是42。')}))
  const winner=await run(second,{state,policy:p,body:next})
  assert.equal(winner.winner,peer);assert.equal(winner.sticky,true)
  assert.deepEqual(second.calls.map(call=>call.payload.model),[peer])
  assert.equal(second.calls[0].payload.messages.at(-1).content,'实际合成结果：42。')
})

test('reused tool IDs are isolated by user message, tool arguments and optional caller identifier',async()=>{
  const variants=[
    {first:{question:'first user question',query:'same query'},second:{question:'second user question',query:'same query'}},
    {first:{question:'same question',query:'first query'},second:{question:'same question',query:'second query'}},
    {first:{question:'same question',query:'same query',user:'caller-one'},second:{question:'same question',query:'same query',user:'caller-two'}}
  ]
  for(const variant of variants){
    const state=createRaceState(),contexts=[]
    for(const [index,value]of [variant.first,variant.second].entries()){
      const initial=toolBody();initial.messages.at(-1).content=value.question
      if(value.user)initial.user=value.user
      const answer=toolResult('call_0');answer.choices[0].message.tool_calls[0].function.arguments=JSON.stringify({query:value.query})
      const model=index===0?high:peer
      await run(mockFetcher(()=>({answer})),{state,body:initial,models:[model],policy:policy({candidates:[spec(model)]})})
      contexts.push({...initial,messages:[...initial.messages,answer.choices[0].message,{role:'tool',tool_call_id:'call_0',content:'synthetic result'}]})
    }
    assert.equal(state.tools.size,2,'a reused ID must not overwrite a separate chain')
    assert([...state.tools.keys()].every(key=>/^[a-f0-9]{64}$/.test(key)))
    for(const [index,context]of contexts.entries()){
      const mock=mockFetcher(()=>({})),winner=await run(mock,{state,body:context})
      assert.equal(winner.winner,index===0?high:peer);assert.equal(winner.sticky,true)
      assert.deepEqual(mock.calls.map(call=>call.payload.model),[index===0?high:peer])
    }
  }
})

test('colliding IDs never restore another user chain reasoning and final answers extend only matching entries',async()=>{
  let now=100000
  const state=createRaceState({now:()=>now}),p=policy({candidates:[spec(high,100,{restoreToolReasoning:true})]}),contexts=[]
  for(const question of ['first private question','second private question']){
    const initial=toolBody();initial.messages.at(-1).content=question
    const answer=toolResult('call_0','reasoning for '+question)
    await run(mockFetcher(()=>({answer})),{state,body:initial,models:[high],policy:p})
    contexts.push({...initial,messages:[...initial.messages,answer.choices[0].message,{role:'tool',tool_call_id:'call_0',content:'synthetic result'}]})
    delete contexts.at(-1).messages.at(-2).reasoning_content
  }
  assert.equal(state.tools.size,2)
  const original=[...state.tools].map(([key,row])=>({key,signature:row.signature,expiresAt:row.expiresAt}))
  now+=10000
  const mock=mockFetcher(()=>({}));await run(mock,{state,body:contexts[0],models:[high],policy:p})
  assert.equal(mock.calls[0].payload.messages.at(-2).reasoning_content,'reasoning for first private question')
  assert.equal(state.tools.get(original[0].key).signature,original[0].signature)
  assert.equal(state.tools.get(original[0].key).expiresAt,now+300000)
  assert.equal(state.tools.get(original[1].key).expiresAt,original[1].expiresAt)
})

test('a failed sticky winner permits quality peers and then fault fallback; stale TTL stops pinning',async()=>{
  let now=100000
  const state=createRaceState({now:()=>now}),initial=toolBody()
  await run(mockFetcher(model=>({delay:model===high?0:15,answer:toolResult()})),{state,body:initial})
  const second=mockFetcher(model=>({status:model===high?500:200}))
  const won=await run(second,{state,body:continuation(initial)})
  assert.equal(won.winner,peer);assert.equal(won.fallback,false)
  now+=300001
  const third=mockFetcher(()=>({delay:1}))
  const fresh=await run(third,{state,body:continuation(initial)})
  assert.equal(fresh.sticky,false);assert.equal(fresh.attemptCount,2)
})

test('opt-in reasoning restoration matches the same model, assistant content and semantic tool arguments only',async()=>{
  const state=createRaceState(),p=policy({candidates:[spec(high,100,{restoreToolReasoning:true}),spec(old,0)]}),initial=toolBody()
  await run(mockFetcher(()=>({answer:toolResult('tool-one','PRIVATE_SYNTHETIC_REASONING')})),{state,policy:p,body:initial})
  const next=continuation(initial),before=structuredClone(next),mock=mockFetcher(()=>({}))
  await run(mock,{state,policy:p,body:next})
  assert.equal(mock.calls[0].payload.messages.find(message=>message.tool_calls)?.reasoning_content,'PRIVATE_SYNTHETIC_REASONING')
  assert.deepEqual(next,before,'restoration modifies only the candidate clone')
  const changed=continuation(initial);changed.messages.at(-2).tool_calls[0].function.arguments='{"query":"different"}'
  const mismatch=mockFetcher(()=>({}));await run(mismatch,{state,policy:p,body:changed})
  assert(!Object.hasOwn(mismatch.calls[0].payload.messages.at(-2),'reasoning_content'))
  const changedContent=continuation(initial);changedContent.messages.at(-2).content='different assistant content'
  const wrongContent=mockFetcher(()=>({}));await run(wrongContent,{state,policy:p,body:changedContent})
  assert(!Object.hasOwn(wrongContent.calls[0].payload.messages.at(-2),'reasoning_content'))
  const existing=continuation(initial);existing.messages.at(-2).reasoning_content='provided by caller'
  const keep=mockFetcher(()=>({}));await run(keep,{state,policy:p,body:existing})
  assert.equal(keep.calls[0].payload.messages.at(-2).reasoning_content,'provided by caller')
})

test('reasoning is not sent to a fallback model, when disabled, or after TTL expiry',async()=>{
  let now=100000
  const state=createRaceState({now:()=>now}),initial=toolBody(),p=policy({candidates:[spec(high,100,{restoreToolReasoning:true}),spec(old,0,{restoreToolReasoning:true})]})
  await run(mockFetcher(()=>({answer:toolResult('tool-one','PRIVATE_REASONING')})),{state,policy:p,body:initial})
  const fallback=mockFetcher(model=>({status:model===high?500:200}))
  await run(fallback,{state,policy:p,body:continuation(initial)})
  assert(!Object.hasOwn(fallback.calls.find(call=>call.payload.model===old).payload.messages.at(-2),'reasoning_content'))
  const disabled=mockFetcher(()=>({}))
  await run(disabled,{state,policy:policy({candidates:[spec(high)]}),body:continuation(initial)})
  assert(!Object.hasOwn(disabled.calls[0].payload.messages.at(-2),'reasoning_content'))
  now+=300001
  const expired=mockFetcher(()=>({}))
  await run(expired,{state,policy:p,body:continuation(initial)})
  assert(!Object.hasOwn(expired.calls[0].payload.messages.at(-2),'reasoning_content'))
})

test('reasoning RAM cache has strict per-entry, total byte and entry count bounds',async()=>{
  const state=createRaceState(),p=policy({candidates:[spec(high,100,{restoreToolReasoning:true})],maxStickyEntries:2,maxStickyBytes:20})
  for(let index=0;index<4;index++)await run(mockFetcher(()=>({answer:toolResult('bounded-'+index,'123456789012345')})),{state,policy:p,body:toolBody()})
  assert(state.tools.size<=2);assert(state.stickyBytes<=20)
  const largeState=createRaceState()
  await run(mockFetcher(()=>({answer:toolResult('oversize','X'.repeat(65537))})),{state:largeState,policy:policy({candidates:[spec(high,100,{restoreToolReasoning:true})]}),body:toolBody()})
  assert.equal([...largeState.tools.values()][0].reasoning,undefined);assert.equal(largeState.stickyBytes,0)
  const defaultOff=createRaceState()
  await run(mockFetcher(()=>({answer:toolResult('not-retained','PRIVATE_REASONING')})),{state:defaultOff,body:toolBody(),policy:policy({candidates:[spec(high)]})})
  assert.equal([...defaultOff.tools.values()][0].reasoning,undefined);assert.equal(defaultOff.stickyBytes,0)
  assert.match([...defaultOff.tools.values()][0].signature,/^[a-f0-9]{64}$/)
  assert.doesNotMatch(JSON.stringify([...defaultOff.tools].map(([key,row])=>({key,signature:row.signature,reasoning:row.reasoning}))),/PRIVATE_REASONING|not-retained|合成问题/)
})

test('tool cache expiry physically removes optional reasoning even without another request',async()=>{
  const state=createRaceState(),p=policy({candidates:[spec(high,100,{restoreToolReasoning:true})],stickyTtlMs:15})
  await run(mockFetcher(()=>({answer:toolResult('expires-id','PRIVATE_SHORT_LIVED_REASONING')})),{state,policy:p,body:toolBody()})
  assert.equal(state.tools.size,1)
  await new Promise(resolve=>setTimeout(resolve,30))
  assert.equal(state.tools.size,0);assert.equal(state.stickyBytes,0)
})

test('tool usability rejects invented tools, malformed arguments, forced-choice violations and hidden-only responses',()=>{
  const initial=toolBody()
  assert(usable(toolResult(),initial))
  assert(!usable(toolResult(),{...initial,tool_choice:'none'}))
  assert(!usable(result(),{...initial,tool_choice:'required'}))
  assert(!usable(toolResult(),{...initial,tool_choice:{type:'function',function:{name:'other'}}}))
  assert(!usable(toolResult(),body()))
  const invalid=toolResult();invalid.choices[0].message.tool_calls[0].function.arguments='{}'
  assert(!usable(invalid,initial));assert(!usable(result('<think>internal only</think>')))
})

test('opt-in truncation rejection selects a complete peer while preserving legacy acceptance',async()=>{
  const truncated=result('只完成了前半句');truncated.choices[0].finish_reason='length'
  const complete=result('完整合成答案。');complete.choices[0].finish_reason='stop'
  const mock=mockFetcher(model=>({delay:model===high?0:10,answer:model===high?truncated:complete}))
  const winner=await run(mock,{policy:policy({candidates:[spec(high,100,{rejectTruncated:true}),spec(peer,100,{rejectTruncated:true}),spec(old,0)]})})
  assert.equal(winner.winner,peer);assert(winner.events.some(event=>event.reason==='TRUNCATED'))
  const legacy=await run(mockFetcher(()=>({answer:truncated})),{models:[high],policy:{}})
  assert.equal(legacy.winner,high);assert.equal(legacy.result.choices[0].finish_reason,'length')
})

async function serverFixture(t,fetcher,extra={}){
  const server=startServer({base:'https://upstream.invalid/v1',gatewayKey:'synthetic-upstream-key',secret:'synthetic-entry-secret',port:0,host:'127.0.0.1',log:false,fetcher,timeoutMs:250,race:policy(),...extra})
  await once(server,'listening')
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))})
  return {server,url:'http://127.0.0.1:'+server.address().port,headers:{authorization:'Bearer synthetic-entry-secret','content-type':'application/json'}}
}

test('HTTP integration preserves public entry aliases and exposes only routing metadata',async t=>{
  const mock=mockFetcher(model=>({status:model===old?200:500}))
  const f=await serverFixture(t,(url,options)=>url.endsWith('/models')?Promise.resolve(response({data:[high,peer,old].map(id=>({id}))})):mock.fetcher(url,options))
  const res=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify(body())})
  assert.equal(res.status,200);assert.equal(res.headers.get('x-qqbot-race-winner'),old)
  assert.equal(res.headers.get('x-qqbot-race-fallback'),'true');assert.equal(res.headers.get('x-qqbot-race-attempts'),'3')
  assert.equal((await res.json()).model,'qqbot-text')
  const health=await(await fetch(f.url+'/healthz')).text()
  assert.doesNotMatch(health,/synthetic-entry-secret|synthetic-upstream-key|角色原文|PRIVATE_/)
  assert.equal(f.server.requestTimeout,2250)
})

test('inventory work is included in the HTTP hard deadline, including a non-cooperative fetcher',async t=>{
  let calls=0
  const f=await serverFixture(t,()=>{calls++;return new Promise(()=>{})},{timeoutMs:45,inventoryTimeoutMs:200})
  const start=Date.now(),res=await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify(body())})
  assert.equal(res.status,504);assert(Date.now()-start<200);assert.equal(calls,1)
})

test('HTTP caller disconnect propagates cancellation to every started provider candidate',async t=>{
  let started
  const underway=new Promise(resolve=>{started=resolve})
  const mock=mockFetcher(()=>{started();return {delay:1000}})
  const f=await serverFixture(t,(url,options)=>url.endsWith('/models')?Promise.resolve(response({data:[high,peer,old].map(id=>({id}))})):mock.fetcher(url,options))
  const caller=new AbortController()
  const request=fetch(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify(body()),signal:caller.signal})
  await underway;caller.abort()
  await assert.rejects(request)
  await new Promise(resolve=>setTimeout(resolve,20))
  assert(mock.calls.every(call=>call.signal.aborted))
  assert.equal(mock.cancelled.length,mock.calls.length)
})

test('the HTTP deadline also bounds a partially uploaded request body',async t=>{
  let calls=0
  const f=await serverFixture(t,()=>{calls++;throw new Error('must not call')},{timeoutMs:45})
  const start=Date.now(),request=http.request(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers})
  request.on('error',()=>{})
  request.write('{"model":')
  const [res]=await once(request,'response')
  res.resume();await once(res,'end');request.destroy()
  assert.equal(res.statusCode,504);assert(Date.now()-start<200);assert.equal(calls,0)
})

test('unauthorized or invalid HTTP requests never invoke inventory or a model',async t=>{
  let calls=0
  const f=await serverFixture(t,()=>{calls++;throw new Error('must not call')})
  assert.equal((await fetch(f.url+'/v1/chat/completions',{method:'POST',body:JSON.stringify(body())})).status,401)
  assert.equal((await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers,body:'{'})).status,400)
  assert.equal((await fetch(f.url+'/v1/chat/completions',{method:'POST',headers:f.headers,body:JSON.stringify({...body(),stream:true})})).status,400)
  assert.equal(calls,0)
})

test('actual rollout policy keeps eight tested Intern aliases separated by text, tools and vision',()=>{
  const p=JSON.parse(readFileSync(new URL('./policy.json',import.meta.url),'utf8'))
  const models=p.race.candidates.map(candidate=>candidate.model)
  assert.equal(models.length,13)
  const text=candidatesFor(models,body(),p.race),tools=candidatesFor(models,toolBody(),p.race)
  const images=candidatesFor(models,{...body(),model:'qqbot-vision'},p.race)
  const imageTools=candidatesFor(models,{...toolBody(),model:'qqbot-vision'},p.race)
  assert.equal(text.filter(model=>model.includes('-intern-')).length,4)
  assert.deepEqual(text,tools)
  assert.equal(images.filter(model=>model.includes('-intern-')).length,4)
  assert(!imageTools.some(model=>model.includes('deepseek-v4-flash-vision')||model.includes('agents-a1')))
  assert(imageTools.some(model=>model.includes('qwen3-8-27b')))
  assert(imageTools.some(model=>model.includes('kimi-k2-6')))
  assert.equal(p.race.resources.intern.maxConcurrent,2)
  assert.equal(p.race.resources.intern.requestsPerMinute,40)
  assert(!p.race.candidates.some(candidate=>candidate.restoreToolReasoning))
  assert(p.timeoutMs<p.aiInstanceTiming.timeoutMs)
  assert(p.timeoutMs<p.requestTimeoutMs)
  for(const candidate of p.race.candidates.filter(candidate=>candidate.resourceGroup==='intern'))assert(candidate.rejectTruncated)
})
