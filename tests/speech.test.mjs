import test from 'node:test'
import assert from 'node:assert/strict'
import {SpeechService,listVoices,resolveVoice,normalizeGame,VOICE_GAMES} from '../src/speech/index.mjs'

const settings={enabled:true,endpoint:'https://voice.example',defaultVoice:'纳西妲（草神）',timeoutMs:1000}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})
function wav(){
  const bytes=Buffer.alloc(44+2205*2)
  bytes.write('RIFF');bytes.writeUInt32LE(bytes.length-8,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(22050,24);bytes.writeUInt32LE(44100,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(bytes.length-44,40)
  for(let i=44;i<bytes.length;i+=2)bytes.writeInt16LE(Math.round(Math.sin(i)*5000),i)
  return bytes
}
function gradioConfig(voices=['纳西妲（草神）','日语纳西妲（田村由加莉）']){
  return {components:[
    {id:1,props:{}},{id:2,props:{choices:['中文','日语','中日混合（测试标签）']}},{id:3,props:{choices:voices}},
    {id:4,props:{minimum:0.1,maximum:1}},{id:5,props:{minimum:0.1,maximum:1}},{id:6,props:{minimum:0.1,maximum:2}}
  ],dependencies:[{api_name:'generate',inputs:[1,2,3,4,5,6]}]}
}
function fixture(config={},extra){
  const calls=[]
  const service=new SpeechService({config:()=>({...settings,...config}),fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options})
    const custom=await extra?.(url,options,calls)
    if(custom)return custom
    if(url.pathname==='/config')return json(gradioConfig())
    if(url.pathname==='/api/generate/')return json({data:['生成成功!',{name:'/tmp/voice.wav',is_file:true},'生成耗时']})
    return new Response(wav(),{headers:{'content-type':'audio/wav'}})
  }})
  return {service,calls}
}

test('音色完整可分页，游戏别名与中文/日文同名角色精确解析，未知NPC不猜游戏',()=>{
  const all=listVoices({pageSize:100})
  assert.equal(all.total,804);assert.equal(all.pages,9);assert.equal(all.voices.length,100)
  assert.equal(VOICE_GAMES.length,4);assert.equal(normalizeGame('崩坏三'),'honkai3');assert.equal(normalizeGame('马娘'),'umamusume');assert.equal(normalizeGame('无此游戏'),null)
  assert.equal(resolveVoice('纳西妲').label,'纳西妲（草神）');assert.equal(resolveVoice('草神').language,'zh')
  assert.equal(resolveVoice('纳西妲',{language:'ja'}).label,'日语纳西妲（田村由加莉）')
  assert.equal(resolveVoice('日语纳西妲（田村由加莉）').language,'ja');assert.equal(resolveVoice('纳西'),null)
  assert.equal(resolveVoice('琪亚娜',{game:'崩坏3'}).game,'honkai3');assert.equal(resolveVoice('特别周').game,'umamusume')
  assert.equal(resolveVoice('芙萝拉').game,'other');assert.equal(resolveVoice('派蒙bh3').game,'honkai3');assert.equal(resolveVoice('派蒙').game,'genshin')
  assert.equal(listVoices({game:'原神',language:'ja',search:'纳西妲'}).total,1)
  assert.equal(listVoices({game:'不存在'}).total,0)
  const beyond=listVoices({game:'原神',page:999,pageSize:30})
  assert.equal(beyond.page,999);assert.equal(beyond.voices.length,0);assert(beyond.pages<999)
})
test('真实Gradio3.7协议与完整音色label，鉴权仅同origin，配置缓存与WAV时长',async()=>{
  const f=fixture({token:'secret-for-test'})
  const audio=await f.service.synthesize('你好。',{voice:'草神'})
  assert.equal(audio.type,'audio');assert.equal(audio.voice,'纳西妲（草神）');assert.equal(audio.mime,'audio/wav');assert.equal(audio.text,'你好。');assert.equal(audio.durationSeconds,0.1)
  assert.deepEqual(Buffer.from(audio.data,'base64'),wav())
  const request=f.calls.find(call=>call.options.method==='POST')
  assert.deepEqual(JSON.parse(request.options.body),{data:['你好。','中文','纳西妲（草神）',0.6,0.668,1.2]})
  assert(f.calls.every(call=>call.options.headers.Authorization==='Bearer secret-for-test'&&call.options.redirect==='manual'))
  await f.service.synthesize('こんにちは。',{voice:'纳西妲',language:'ja'})
  assert.equal(f.calls.filter(call=>new URL(call.url).pathname==='/config').length,1)
  assert.equal(JSON.parse(f.calls.filter(call=>call.options.method==='POST')[1].options.body).data[2],'日语纳西妲（田村由加莉）')
})
test('混合语言使用远端真实label，音色缺失不调用生成API',async()=>{
  const f=fixture()
  await f.service.synthesize('[ZH]你好[ZH][JA]こんにちは[JA]',{language:'mix'})
  assert.equal(JSON.parse(f.calls[1].options.body).data[1],'中日混合（测试标签）')
  await assert.rejects(f.service.synthesize('你好',{voice:'琪亚娜'}),{code:'SPEECH_VOICE_NOT_FOUND'})
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1)
})
test('禁用、空文本、超过字数和无效服务配置在请求前明确失败，不截断文字',async()=>{
  let requests=0
  for(const [config,text,code] of [[{enabled:false},'你好','SPEECH_DISABLED'],[{},' \n ','SPEECH_EMPTY'],[{},'好'.repeat(501),'SPEECH_TOO_LONG'],[{endpoint:'http://voice.example'},'你好','SPEECH_ENDPOINT'],[{endpoint:'https://user:password@voice.example'},'你好','SPEECH_ENDPOINT'],[{endpoint:'https://voice.example/api/generate/'},'你好','SPEECH_ENDPOINT']]){
    const service=new SpeechService({config:()=>({...settings,...config}),fetchImpl:async()=>{requests++;return json({})}})
    await assert.rejects(service.synthesize(text),{code})
  }
  assert.equal(requests,0)
})
test('音频下载拒绝外站URL、内网URL、任意文件、路径穿越及编码穿越',async()=>{
  for(const name of ['https://evil.example/file=/tmp/x.wav','https://127.0.0.1/file=/tmp/x.wav','/etc/passwd','file:///tmp/x.wav','/tmp/a/../../x.wav','https://voice.example/file=/tmp/%252e%252e/x.wav','https://voice.example/admin']){
    const f=fixture({},url=>url.pathname==='/api/generate/'?json({data:['ok',{name}]}):null)
    await assert.rejects(f.service.synthesize('你好'),{code:'SPEECH_AUDIO_INVALID'})
    assert.equal(f.calls.length,2)
  }
})
test('重定向受到origin、file路由和次数限制，不泄露token到外站',async()=>{
  for(const target of ['https://evil.example/file=/tmp/x.wav','https://voice.example/admin','https://voice.example/file=/tmp/../../private.wav']){
    const f=fixture({token:'secret-for-test'},url=>url.pathname.startsWith('/file=')?new Response(null,{status:302,headers:{location:target}}):null)
    await assert.rejects(f.service.synthesize('你好'))
    assert.equal(f.calls.length,3)
    assert(f.calls.every(call=>new URL(call.url).origin==='https://voice.example'))
  }
  const loop=fixture({},url=>url.pathname.startsWith('/file=')?new Response(null,{status:302,headers:{location:'/file=/tmp/voice.wav'}}):null)
  await assert.rejects(loop.service.synthesize('你好'),{code:'SPEECH_PROTOCOL'});assert.equal(loop.calls.length,6)
})
test('接受同站临时WAV重定向，拒绝网页、损坏WAV和超限响应',async()=>{
  const good=fixture({},url=>url.pathname==='/file=/tmp/voice.wav'?new Response(null,{status:302,headers:{location:'/file=/tmp/second.wav'}}):null)
  assert.equal((await good.service.synthesize('你好')).durationSeconds,0.1)
  const html=fixture({},url=>url.pathname.startsWith('/file=')?new Response('<html>请登录</html>',{headers:{'content-type':'text/html'}}):null)
  await assert.rejects(html.service.synthesize('你好'),{code:'SPEECH_AUDIO_INVALID'})
  const damaged=wav();damaged.writeUInt32LE(damaged.length*2,4)
  const invalid=fixture({},url=>url.pathname.startsWith('/file=')?new Response(damaged):null)
  await assert.rejects(invalid.service.synthesize('你好'),{code:'SPEECH_AUDIO_INVALID'})
  const big=fixture({maxAudioBytes:1000},url=>url.pathname.startsWith('/file=')?new Response(wav(),{headers:{'content-length':'4454'}}):null)
  await assert.rejects(big.service.synthesize('你好'),{code:'SPEECH_AUDIO_TOO_LARGE'})
  const streaming=fixture({maxAudioBytes:1000},url=>url.pathname.startsWith('/file=')?new Response(new ReadableStream({start(controller){controller.enqueue(wav());controller.close()}})):null)
  await assert.rejects(streaming.service.synthesize('你好'),{code:'SPEECH_AUDIO_TOO_LARGE'})
})
test('兼容内嵌base64 WAV；拒绝无音频、异常接口和不可信错误详情',async()=>{
  const inline=fixture({},url=>url.pathname==='/api/generate/'?json({data:['ok',`data:audio/wav;base64,${wav().toString('base64')}`]}):null)
  assert.equal((await inline.service.synthesize('你好')).mime,'audio/wav')
  const empty=fixture({},url=>url.pathname==='/api/generate/'?json({data:['上游失败敏感内容',null]}):null)
  await assert.rejects(empty.service.synthesize('你好'),error=>error.code==='SPEECH_UNAVAILABLE'&&!error.message.includes('敏感'))
  const wrong=fixture({},url=>url.pathname==='/config'?json({components:[],dependencies:[]}):null)
  await assert.rejects(wrong.service.synthesize('你好'),{code:'SPEECH_PROTOCOL'})
  const broken=fixture({},()=>{throw new Error('https://secret:password@upstream.invalid token-secret')})
  await assert.rejects(broken.service.synthesize('你好'),error=>error.code==='SPEECH_UNAVAILABLE'&&!error.message.includes('secret'))
})
test('生成与下载都受总超时控制，即使fetch或流忽略AbortSignal也会结束',async()=>{
  for(const stage of ['generate','download']){
    const f=fixture({timeoutMs:25},url=>{
      if(stage==='generate'&&url.pathname==='/api/generate/')return new Promise(()=>{})
      if(stage==='download'&&url.pathname.startsWith('/file='))return new Response(new ReadableStream({pull(){return new Promise(()=>{})}}))
    })
    await assert.rejects(f.service.synthesize('你好'),{code:'SPEECH_TIMEOUT'})
  }
})
test('CPU合成串行有界排队，排队取消/超时不发请求，取消后可继续使用',async()=>{
  let release,active=0,maximum=0
  const gate=new Promise(resolve=>{release=resolve})
  const f=fixture({timeoutMs:1000},async url=>{
    if(url.pathname==='/api/generate/'){
      active++;maximum=Math.max(maximum,active)
      if(f.calls.filter(call=>call.options.method==='POST').length===1)await gate
      active--;return json({data:['ok',{name:'/tmp/voice.wav'}]})
    }
  })
  const first=f.service.synthesize('第一个')
  await new Promise(resolve=>setTimeout(resolve,5))
  const controller=new AbortController()
  const second=f.service.synthesize('第二个',{signal:controller.signal})
  const third=f.service.synthesize('第三个'),fourth=f.service.synthesize('第四个')
  await assert.rejects(f.service.synthesize('第五个'),{code:'SPEECH_QUEUE_FULL'})
  controller.abort();await assert.rejects(second,{code:'SPEECH_ABORTED'})
  release();await Promise.all([first,third,fourth]);assert.equal(maximum,1)
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,3)
  await f.service.synthesize('完成后继续')
  const cancelled=new AbortController();cancelled.abort()
  const count=f.calls.length;await assert.rejects(f.service.synthesize('取消',{signal:cancelled.signal}),{code:'SPEECH_ABORTED'});assert.equal(f.calls.length,count)
})
test('排队消耗同一个总超时，close取消活动与等待请求',async()=>{
  let release
  const gate=new Promise(resolve=>{release=resolve})
  let config={...settings,timeoutMs:1000}
  const service=new SpeechService({config:()=>config,fetchImpl:async url=>url.pathname==='/config'?json(gradioConfig()):await gate})
  const first=service.synthesize('第一个')
  await new Promise(resolve=>setTimeout(resolve,5));config={...config,timeoutMs:15}
  await assert.rejects(service.synthesize('等候中的请求'),{code:'SPEECH_TIMEOUT'})
  service.close();await assert.rejects(first,{code:'SPEECH_ABORTED'});release(json({data:[]}))
})
