import test from 'node:test'
import assert from 'node:assert/strict'
import {GenerationService} from '../src/generation/index.mjs'

const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=','base64')
const image={data:png.toString('base64'),mime:'image/png'}
const settings={enabled:true,endpoint:'https://visual.example',token:'fixture-private-token',timeoutMs:1000}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})
const configuration=()=>({dependencies:[{id:8,api_name:'image',inputs:[1,2,3,4,5,6,7],outputs:[11,12,13]},{id:10,api_name:'story',inputs:[1,2,3,4,5,6,7,8,9,10],outputs:[21,22,23,24,25]}]})
function box(kind,payload){const result=Buffer.alloc(8+payload.length);result.writeUInt32BE(result.length);result.write(kind,4);payload.copy(result,8);return result}
const mp4=()=>Buffer.concat([box('ftyp',Buffer.from('isom\x00\x00\x02\x00isomiso2')),box('moov',box('trak',Buffer.from('fixture'))),box('mdat',Buffer.from([0,0,0,1,0x65,1,2,3]))])
function events(messages,{simple=false,chunk=11}={}){
  const text=messages.map(value=>simple?`event: ${value.event}\r\ndata: ${JSON.stringify(value.data)}\r\n\r\n`:`data: ${JSON.stringify(value)}\r\n\r\n`).join('')
  const bytes=new TextEncoder().encode(text)
  return new Response(new ReadableStream({start(controller){for(let offset=0;offset<bytes.length;offset+=chunk)controller.enqueue(bytes.slice(offset,offset+chunk));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
}
const result=(type='image',timing={total_seconds:6.2})=>type==='image'?[{path:'/tmp/gradio/hash/image.png',url:'https://visual.example/gradio_api/file=/tmp/gradio/hash/image.png'},{path:'/tmp/gradio/hash/image.png'},timing]:[{video:{path:'/tmp/gradio/hash/OrangeJuice.mp4',url:'https://visual.example/gradio_api/file=/tmp/gradio/hash/OrangeJuice.mp4'},subtitles:null},null,null,null,timing]
function fixture(extra,overrides={}){
  const calls=[];let api='image'
  const service=new GenerationService({config:()=>({...settings,...overrides}),fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options})
    const custom=await extra?.(url,options,calls)
    if(custom)return custom
    if(url.pathname==='/config')return json(configuration())
    if(url.pathname==='/gradio_api/upload')return json(['/tmp/gradio/upload/reference.png'])
    if(url.pathname.startsWith('/gradio_api/call/')&&options.method==='POST'){api=url.pathname.split('/').at(-1);return json({event_id:'task-123'})}
    if(url.pathname==='/gradio_api/queue/data')return events([{msg:'estimation',rank:0},{msg:'progress',progress_data:[{desc:'生成画面中'}]},{msg:'process_completed',success:true,output:{data:result(api==='image'?'image':'video')}}])
    if(url.pathname==='/gradio_api/cancel')return json({success:true})
    return new Response(api==='image'?png:mp4(),{headers:{'content-type':api==='image'?'image/png':'video/mp4'}})
  }})
  return {service,calls}
}

test('image uses exact Gradio6 API, preserves validated bytes and numeric timing, and caches descriptor',async()=>{
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:true,output:{data:result('image',{total_seconds:5.9,model:'flux',secret:'do-not-return',mix:{seconds:1,path:'https://secret.invalid'},bad:Infinity})}}]):null)
  const output=await f.service.image({prompt:'一只橘猫',seed:42})
  assert.equal(output.type,'image');assert.equal(output.mimeType,'image/png');assert.deepEqual(Buffer.from(output.data,'base64'),png)
  assert.deepEqual(output.timing,{total_seconds:5.9,model:'flux',mix:{seconds:1}})
  assert.deepEqual(JSON.parse(f.calls.find(call=>call.options.method==='POST').options.body),{data:['一只橘猫','flux',null,'',1024,1024,42]})
  assert(f.calls.some(call=>call.url==='https://visual.example/gradio_api/queue/data?session_hash=task-123'))
  assert(f.calls.every(call=>call.options.redirect==='manual'&&call.options.headers.Authorization==='Bearer fixture-private-token'))
  await f.service.image({prompt:'二次元橘猫',model:'anima',seed:0})
  assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/config').length,1)
  assert.equal(f.service.effects,undefined)
})

test('reference uploads bounded image bytes with FileData metadata before image generation',async()=>{
  const f=fixture()
  await f.service.image({prompt:'把猫画在窗边',reference:image,seed:42})
  const upload=f.calls.find(call=>new URL(call.url).pathname==='/gradio_api/upload')
  assert(upload.options.body instanceof FormData)
  assert.equal(upload.options.headers['Content-Type'],undefined)
  const file=upload.options.body.get('files')
  assert.equal(file.name,'reference.png');assert.equal(file.type,'image/png');assert.deepEqual(Buffer.from(await file.arrayBuffer()),png)
  const data=JSON.parse(f.calls.find(call=>new URL(call.url).pathname==='/gradio_api/call/image').options.body).data
  assert.deepEqual(data[2],{path:'/tmp/gradio/upload/reference.png',orig_name:'reference.png',mime_type:'image/png',meta:{_type:'gradio.FileData'}})
})

test('video uses story composition and auto video-conditioned effects, returning only the composed MP4',async()=>{
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:true,output:{data:result('video',{total_seconds:41.4,mix:{duration:4.5,extended_last_frame:true,subtitle_timing:'estimated'},speech:{seconds:3.1},effects:{seconds:2.4}})}}]):null)
  const output=await f.service.video({image,prompt:'橘猫慢慢转头',script:'阳光照进窗边。',voice:'zf_001',duration:3,seed:42})
  assert.equal(output.type,'video');assert.equal(output.mimeType,'video/mp4');assert.deepEqual(Buffer.from(output.data,'base64'),mp4())
  assert.equal(output.durationSeconds,4.5);assert.equal(output.effectsEnabled,true)
  const calls=f.calls.filter(call=>call.options.method==='POST')
  assert.equal(calls.length,2)
  assert.deepEqual(JSON.parse(calls[1].options.body).data,[{path:'/tmp/gradio/upload/reference.png',orig_name:'reference.png',mime_type:'image/png',meta:{_type:'gradio.FileData'}},'橘猫慢慢转头','',3,42,'阳光照进窗边。','zf_001','',true,true])
  assert(f.calls.every(call=>!/(?:\/effects|\/speech|\/mix)(?:\/|$)/.test(new URL(call.url).pathname)))
  assert.doesNotMatch(JSON.stringify(output),/https:|\/tmp\/|fixture-private-token/)
})

test('video permits no-effects and no-subtitles options; effectsEnabled takes priority over alias',async()=>{
  const f=fixture()
  await f.service.video({image,prompt:'缓慢摇镜头',duration:5,seed:8,effectsEnabled:false,effects:true,subtitles:false})
  const data=JSON.parse(f.calls.find(call=>new URL(call.url).pathname==='/gradio_api/call/story').options.body).data
  assert.deepEqual(data.slice(3),[5,8,'','zf_001','',false,false])
})

test('invalid inputs reject without network or spending GPU quota',async()=>{
  const f=fixture()
  for(const options of [{prompt:''},{prompt:'字'.repeat(2001)},{prompt:'cat',model:'unknown'},{prompt:'cat',model:'anima',reference:image},{prompt:'cat',seed:-1},{prompt:'cat',width:4096},{prompt:'cat',reference:{data:'!!!!',mime:'image/png'}},{prompt:'cat',reference:{data:png.toString('base64'),mime:'image/jpeg'}},{prompt:'cat',reference:{data:'data:image/jpeg;base64,'+png.toString('base64')}}])await assert.rejects(f.service.image(options),error=>error.code.startsWith('GENERATION_'))
  for(const options of [{prompt:'cat'},{image,prompt:'cat',duration:10},{image,prompt:'cat',duration:4},{image,prompt:'cat',script:'字'.repeat(201)},{image,prompt:'cat',voice:'中文女声001'},{image,prompt:'cat',effectsEnabled:'yes'},{image,prompt:'cat',subtitles:1}])await assert.rejects(f.service.video(options),error=>error.code.startsWith('GENERATION_'))
  assert.equal(f.calls.length,0)
  const disabled=fixture(null,{enabled:false})
  await assert.rejects(disabled.service.image({prompt:'cat'}),{code:'GENERATION_DISABLED'});assert.equal(disabled.calls.length,0)
})

test('service endpoints reject credentials, non-HTTPS, local addresses, and API URLs',async()=>{
  for(const endpoint of ['http://visual.example','https://a:b@visual.example','https://visual.example?token=secret','https://visual.example#x','https://127.0.0.1','https://169.254.169.254','https://localhost','https://visual.example/gradio_api/call/image']){
    const f=fixture(null,{endpoint});await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_ENDPOINT'});assert.equal(f.calls.length,0)
  }
})

test('a mismatched API contract fails before uploading any private image',async()=>{
  const f=fixture(url=>url.pathname==='/config'?json({dependencies:[{id:8,api_name:'image',inputs:[1],outputs:[2]}]}):null)
  await assert.rejects(f.service.video({image,prompt:'cat'}),{code:'GENERATION_PROTOCOL'})
  assert.equal(f.calls.length,1)
})

test('quota and queue errors stay useful while upstream messages and credentials remain private',async()=>{
  for(const [message,code] of [['GPU quota exceeded https://secret.invalid hf_private','GENERATION_QUOTA'],['今天的免费 GPU 额度不足 secret','GENERATION_QUOTA'],['queue is full private-token','GENERATION_QUEUE_FULL'],['internal error https://secret.invalid private-token','GENERATION_UNAVAILABLE']]){
    const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:false,output:{error:message,data:[]}}]):null)
    await assert.rejects(f.service.image({prompt:'cat'}),error=>error.code===code&&!/secret|private|hf_|https:/.test(error.message))
    assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/gradio_api/call/image').length,1)
  }
})

test('HTTP auth, quota and queue-full responses are classified without exposing their bodies',async()=>{
  for(const [status,body,code] of [[403,'private-token','GENERATION_AUTH'],[429,'private-token','GENERATION_QUOTA'],[503,'{"detail":"queue is full private-token"}','GENERATION_QUEUE_FULL']]){
    const f=fixture(()=>new Response(body,{status}))
    await assert.rejects(f.service.image({prompt:'cat'}),error=>error.code===code&&!/private-token/.test(error.message))
    assert.equal(f.calls.length,1)
  }
})

test('full queue 404 falls back to documented call SSE without resubmitting the job',async()=>{
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?new Response('',{status:404}):url.pathname==='/gradio_api/call/image/task-123'?events([{event:'heartbeat',data:null},{event:'complete',data:result()}],{simple:true}):null)
  const output=await f.service.image({prompt:'cat'})
  assert.equal(output.type,'image')
  assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/gradio_api/call/image').length,1)
})

test('unsafe FileData paths and URLs fail before any download or credential forwarding',async()=>{
  for(const file of [{url:'https://evil.example/gradio_api/file=/tmp/a.png'},{path:'/etc/secret.png'},{path:'/tmp/../private.png'},{url:'https://visual.example/gradio_api/file=/tmp/a/../secret.png'},{url:'https://visual.example/gradio_api/file=/tmp/%252e%252e/secret.png'},{url:'https://visual.example/gradio_api/file=/tmp/a.png?token=private'},{url:'https://visual.example/admin'},{path:'/tmp/a.svg'},{path:'/tmp/a.png\u0000'}]){
    const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:true,output:{data:[file,null,{}]}}]):null)
    await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_FILE_INVALID'})
    assert.equal(f.calls.length,3)
    assert(f.calls.every(call=>new URL(call.url).origin==='https://visual.example'))
  }
})

test('unsafe upload paths fail before generation submission',async()=>{
  for(const path of ['/etc/secret.png','/tmp/../secret.png','https://evil.example/a.png','/tmp/reference.exe']){
    const f=fixture(url=>url.pathname==='/gradio_api/upload'?json([path]):null)
    await assert.rejects(f.service.video({image,prompt:'cat'}),{code:'GENERATION_FILE_INVALID'})
    assert.equal(f.calls.length,2)
  }
})

test('cross-origin redirects cannot receive HF credentials, including media download redirects',async()=>{
  for(const target of ['https://evil.example/private','https://user:password@visual.example/private']){
    const f=fixture(url=>url.pathname.startsWith('/gradio_api/file=')?new Response(null,{status:302,headers:{location:target}}):null)
    await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_PROTOCOL'})
    assert.equal(f.calls.length,4)
    assert(f.calls.every(call=>new URL(call.url).origin==='https://visual.example'))
  }
  const f=fixture(url=>url.pathname.startsWith('/gradio_api/file=')?new Response(null,{status:302,headers:{location:'/gradio_api/file=/etc/secret.png'}}):null)
  await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_FILE_INVALID'})
})

test('MIME spoofing, invalid image bytes and incomplete MP4 containers are refused',async()=>{
  for(const response of [()=>new Response('<html>login</html>',{headers:{'content-type':'text/html'}}),()=>new Response('not an image',{headers:{'content-type':'image/png'}}),()=>new Response(png,{headers:{'content-type':'image/jpeg'}})]){
    const f=fixture(url=>url.pathname.startsWith('/gradio_api/file=')?response():null)
    await assert.rejects(f.service.image({prompt:'cat'}),error=>['GENERATION_FILE_INVALID','GENERATION_IMAGE_INVALID'].includes(error.code))
  }
  for(const bytes of [Buffer.from('<html>not video</html>'),mp4().subarray(0,-3),Buffer.concat([box('ftyp',Buffer.from('isom\x00\x00\x02\x00isomiso2')),box('mdat',Buffer.alloc(100))])]){
    const f=fixture(url=>url.pathname.startsWith('/gradio_api/file=')?new Response(bytes,{headers:{'content-type':'video/mp4'}}):null)
    await assert.rejects(f.service.video({image,prompt:'cat'}),{code:'GENERATION_VIDEO_INVALID'})
  }
})

test('declared and chunked output limits stop overlarge downloads',async()=>{
  for(const declared of [true,false]){
    const f=fixture(url=>url.pathname.startsWith('/gradio_api/file=')?new Response(new ReadableStream({start(controller){controller.enqueue(png);controller.enqueue(png);controller.close()}}),{headers:{'content-type':'image/png',...(declared?{'content-length':String(png.length*2)}:{})}}):null,{maxImageBytes:png.length})
    await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_IMAGE_TOO_LARGE'})
  }
  const f=fixture(null,{maxVideoBytes:32})
  await assert.rejects(f.service.video({image,prompt:'cat'}),{code:'GENERATION_VIDEO_TOO_LARGE'})
})

test('malformed task IDs, early stream closure and unbounded SSE events fail safely',async()=>{
  const badId=fixture(url=>url.pathname==='/gradio_api/call/image'?json({event_id:'../secret?token=x'}):null)
  await assert.rejects(badId.service.image({prompt:'cat'}),{code:'GENERATION_PROTOCOL'});assert.equal(badId.calls.length,2)
  const ended=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'heartbeat'}]):null)
  await assert.rejects(ended.service.image({prompt:'cat'}),{code:'GENERATION_PROTOCOL'})
  const huge=fixture(url=>url.pathname==='/gradio_api/queue/data'?new Response('data: '+ 'x'.repeat(262145),{headers:{'content-type':'text/event-stream'}}):null)
  await assert.rejects(huge.service.image({prompt:'cat'}),{code:'GENERATION_PROTOCOL'})
})

test('total timeout cancels stalled jobs and best-effort cancels the server task once',async()=>{
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?new Response(new ReadableStream({pull(){return new Promise(()=>{})}}),{headers:{'content-type':'text/event-stream'}}):null,{timeoutMs:20})
  await assert.rejects(f.service.image({prompt:'cat'}),{code:'GENERATION_TIMEOUT'})
  const cancellation=f.calls.filter(call=>new URL(call.url).pathname==='/gradio_api/cancel')
  assert.equal(cancellation.length,1)
  assert.deepEqual(JSON.parse(cancellation[0].options.body),{session_hash:'task-123',event_id:'task-123',fn_index:8})
  assert.equal(f.service.active,false)
})

test('caller cancellation removes a queued waiter and leaves the active job intact',async()=>{
  let complete
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?new Response(new ReadableStream({start(controller){complete=()=>{controller.enqueue(new TextEncoder().encode('data: '+JSON.stringify({msg:'process_completed',success:true,output:{data:result()}})+'\n\n'));controller.close()}}}),{headers:{'content-type':'text/event-stream'}}):null)
  const first=f.service.image({prompt:'first'})
  while(!complete)await new Promise(resolve=>setImmediate(resolve))
  const abort=new AbortController(),second=f.service.image({prompt:'second',signal:abort.signal})
  await new Promise(resolve=>setImmediate(resolve));abort.abort(new Error('private cancellation message'))
  await assert.rejects(second,error=>error.code==='GENERATION_ABORTED'&&!/private/.test(error.message))
  assert.equal(f.service.waiters.length,0)
  assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/gradio_api/call/image').length,1)
  complete();assert.equal((await first).type,'image');assert.equal(f.service.active,false)
})

test('queue admission is bounded, close cancels active and waiting tasks, and fetch errors are redacted',async()=>{
  let started=false
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?(started=true,new Response(new ReadableStream({pull(){return new Promise(()=>{})}}),{headers:{'content-type':'text/event-stream'}})):null)
  const active=f.service.image({prompt:'active'})
  while(!started)await new Promise(resolve=>setImmediate(resolve))
  const waiting=Array.from({length:3},(_,i)=>f.service.image({prompt:'waiting '+i}))
  await new Promise(resolve=>setImmediate(resolve))
  await assert.rejects(f.service.image({prompt:'full'}),{code:'GENERATION_QUEUE_FULL'})
  f.service.close()
  const settled=await Promise.allSettled([active,...waiting])
  assert(settled.every(row=>row.status==='rejected'&&row.reason.code==='GENERATION_ABORTED'))
  assert.equal(f.service.waiters.length,0)
  const privateFailure=fixture(()=>{throw new Error('fetch https://secret.invalid hf_credential')})
  await assert.rejects(privateFailure.service.image({prompt:'cat'}),error=>error.code==='GENERATION_UNAVAILABLE'&&!/secret|credential|https:/.test(error.message))
})
