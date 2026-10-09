import { unmoderatedTestConfig } from './helpers/config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import {SpeechService,createVoiceCatalog} from '../src/speech/index.mjs'
import {AIClient} from '../src/core/client.mjs'
import {Storage} from '../src/core/storage.mjs'
import {defaults,merge} from '../src/core/config.mjs'
import {handleVoiceCommand} from '../integrations/yunzai/voice-commands.mjs'

const voices=[
  {id:'zf_001',label:'中文女声001',language:'zh',group:'中文女声'},
  {id:'zm_009',label:'中文男声009',language:'zh',group:'中文男声'},
  {id:'af_maple',label:'Maple',language:'en',group:'英文'}
]
const metadata={defaultVoice:'zf_001',maxCharacters:200,languages:{Chinese:'zh',English:'en'},voices}
const settings={enabled:true,endpoint:'https://voice.example',defaultVoice:'zf_001',language:'zh',timeoutMs:1000}
const json=value=>new Response(JSON.stringify(value),{headers:{'content-type':'application/json'}})
function config(){return {components:[
  {id:1,props:{}},{id:2,props:{choices:[['中文','Chinese'],['英文','English']],value:'Chinese'}},
  {id:3,props:{choices:voices.map(row=>[row.label,row.id]),value:'zf_001'}},{id:4,props:{}},
  {id:5,props:{label:'Speech catalogue',value:metadata}}
],dependencies:[{api_name:'generate',inputs:[1,2,3,4],outputs:[6,7,8]}]}}
function wav(){
  const bytes=Buffer.alloc(48)
  bytes.write('RIFF');bytes.writeUInt32LE(40,4);bytes.write('WAVE',8);bytes.write('fmt ',12);bytes.writeUInt32LE(16,16);bytes.writeUInt16LE(1,20);bytes.writeUInt16LE(1,22);bytes.writeUInt32LE(24000,24);bytes.writeUInt32LE(48000,28);bytes.writeUInt16LE(2,32);bytes.writeUInt16LE(16,34);bytes.write('data',36);bytes.writeUInt32LE(4,40);bytes.writeInt16LE(5000,44)
  return bytes
}
function events(messages){
  const encoded=new TextEncoder().encode(messages.map(message=>'data: '+JSON.stringify(message)+'\r\n\r\n').join(''))
  // Fragment inside UTF-8 text and CRLF boundaries, as real network reads may.
  return new Response(new ReadableStream({start(controller){for(let i=0;i<encoded.length;i+=13)controller.enqueue(encoded.slice(i,i+13));controller.close()}}),{headers:{'content-type':'text/event-stream'}})
}
function fixture(extra,overrides={}){
  const calls=[],service=new SpeechService({config:()=>({...settings,...overrides}),fetchImpl:async(url,options)=>{
    calls.push({url:String(url),options})
    const response=await extra?.(url,options,calls)
    if(response)return response
    if(url.pathname==='/config')return json(config())
    if(url.pathname==='/gradio_api/call/generate')return json({event_id:'task-1'})
    if(url.pathname==='/gradio_api/queue/data')return events([{msg:'estimation',rank:0},{msg:'process_completed',success:true,output:{data:['成功',{path:'/tmp/gradio/hash/audio.wav',url:'https://voice.example/gradio_api/file=/tmp/gradio/hash/audio.wav'},{}]}}])
    return new Response(wav(),{headers:{'content-type':'audio/wav'}})
  }})
  return {calls,service}
}

test('Gradio5 uses actual speaker IDs, full queue events, cached remote catalogue and same-origin audio',async()=>{
  const f=fixture(null,{token:'test-private-token'})
  const catalogue=await f.service.catalogue()
  assert.equal(catalogue.listVoices().total,3)
  assert.equal(catalogue.resolveVoice('zf_001').label,'中文女声001')
  assert.equal(catalogue.resolveVoice('中文女声001').id,'zf_001')
  assert.equal(catalogue.normalizeGame('中文女声'),'中文女声')
  const audio=await f.service.synthesize('你好。',{voice:'中文女声001'})
  assert.equal(audio.voice,'中文女声001');assert.deepEqual(Buffer.from(audio.data,'base64'),wav())
  assert.deepEqual(JSON.parse(f.calls.find(row=>row.options.method==='POST').options.body),{data:['你好。','Chinese','zf_001','']})
  assert(f.calls.some(row=>row.url==='https://voice.example/gradio_api/queue/data?session_hash=task-1'))
  assert.equal(f.calls.filter(row=>new URL(row.url).pathname==='/config').length,1)
  assert(f.calls.every(row=>row.options.headers.Authorization==='Bearer test-private-token'))
  await f.service.synthesize('Hello.',{voice:'Maple',language:'en'})
  assert.deepEqual(JSON.parse(f.calls.filter(row=>row.options.method==='POST').at(-1).options.body).data,['Hello.','English','af_maple',''])
})

test('Gradio5 FileData path works without url and validates real remote text and language limits',async()=>{
  const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:true,output:{data:['ok',{path:'/tmp/audio.wav'},{}]}}]):null)
  await f.service.synthesize('你好')
  assert(f.calls.some(row=>new URL(row.url).pathname==='/gradio_api/file=/tmp/audio.wav'))
  const posts=f.calls.filter(row=>row.options.method==='POST').length
  await assert.rejects(f.service.synthesize('字'.repeat(201)),{code:'SPEECH_TOO_LONG'})
  await assert.rejects(f.service.synthesize('Hello',{voice:'Maple',language:'zh'}),{code:'SPEECH_PROTOCOL'})
  await assert.rejects(f.service.synthesize('你好',{voice:'旧角色'}),{code:'SPEECH_VOICE_NOT_FOUND'})
  assert.equal(f.calls.filter(row=>row.options.method==='POST').length,posts)
})

test('full queue error preserves quota classification without leaking the upstream message',async()=>{
  for(const [error,code] of [['GPU quota exceeded https://secret.invalid private-key','SPEECH_QUOTA'],[{message:'queue is full private-token'},'SPEECH_QUEUE_FULL'],['Internal failure private-token','SPEECH_UNAVAILABLE']]){
    const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:false,output:{error,data:[]}}]):null)
    await assert.rejects(f.service.synthesize('你好'),value=>value.code===code&&!/secret|private|https:/.test(value.message))
  }
})

test('Gradio5 refuses external, traversal and non-WAV FileData without downloading them',async()=>{
  for(const file of [{url:'https://evil.example/gradio_api/file=/tmp/a.wav'},{path:'/etc/private.wav'},{url:'https://voice.example/gradio_api/file=/tmp/%252e%252e/private.wav'},{url:'https://voice.example/gradio_api/file=/tmp/a.mp3'},{url:'https://voice.example/admin'}]){
    const f=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'process_completed',success:true,output:{data:['ok',file,{}]}}]):null)
    await assert.rejects(f.service.synthesize('你好'),{code:'SPEECH_AUDIO_INVALID'})
    assert.equal(f.calls.length,3)
  }
})

test('Gradio5 event streams, malformed task IDs and total timeout fail safely',async()=>{
  const ended=fixture(url=>url.pathname==='/gradio_api/queue/data'?events([{msg:'heartbeat'}]):null)
  await assert.rejects(ended.service.synthesize('你好'),{code:'SPEECH_PROTOCOL'})
  const invalid=fixture(url=>url.pathname==='/gradio_api/call/generate'?json({event_id:'../../private?token=secret'}):null)
  await assert.rejects(invalid.service.synthesize('你好'),{code:'SPEECH_PROTOCOL'});assert.equal(invalid.calls.length,2)
  const waiting=fixture(url=>url.pathname==='/gradio_api/queue/data'?new Response(new ReadableStream({pull(){return new Promise(()=>{})}}),{headers:{'content-type':'text/event-stream'}}):null,{timeoutMs:20})
  await assert.rejects(waiting.service.synthesize('你好'),{code:'SPEECH_TIMEOUT'})
})

test('obsolete persisted voices fall back through the remote catalogue without database writes',async t=>{
  const catalogue=createVoiceCatalog({...metadata,defaultLanguage:'zh'})
  const storage=new Storage(),saved={mode:'voice',voice:'纳西妲（草神）',game:'genshin',language:'zh',revision:9}
  storage.setMaintenance('speech-settings',saved)
  let spoken
  const speech={currentCatalog:()=>catalogue,catalogue:async()=>catalogue,synthesize:async(text,options)=>{spoken=options;return {type:'audio',data:Buffer.from(wav()).toString('base64'),mime:'audio/wav'}}}
  const configuration=unmoderatedTestConfig({speech:{...settings},management:{enabled:false}})
  const client=new AIClient({config:()=>configuration,storage,speechService:speech,imageStore:{}})
  t.after(()=>client.close())
  assert.deepEqual(client.speechSettings(),{mode:'voice',voice:'中文女声001',game:'中文女声',language:'zh'})
  await client.synthesizeSpeech('你好',saved)
  assert.equal(spoken.voice,'中文女声001')
  assert.deepEqual(storage.maintenance('speech-settings'),saved)
  const who={userId:'normal-user',groupId:'g',botId:'bot',isMaster:false}
  const changed=client.setSpeechSettings(who,{voice:'af_maple'})
  assert.equal(changed.voice,'Maple');assert.equal(changed.language,'en');assert.equal(changed.game,'英文')
  assert.deepEqual(client.speechSettings({userId:'another-user'}),changed)
})

test('voice commands discover remote categories and remain globally switchable; text mode needs no network',async()=>{
  const catalogue=createVoiceCatalog({...metadata,defaultLanguage:'zh'}),replies=[]
  let discovered=0,settings={mode:'text',voice:'中文女声001',game:'中文女声',language:'zh'}
  const client={config:()=>({basic:{enabled:true},chat:{groupEnabled:true,privateEnabled:true},security:{userWhitelist:[],userBlacklist:[],groupWhitelist:[],groupBlacklist:[]}}),speechSettings:()=>settings,currentSpeechCatalog:()=>catalogue,speechCatalog:async()=>{discovered++;return catalogue},setSpeechSettings:(input,patch)=>settings={...settings,...patch}}
  const run=text=>handleVoiceCommand({client,input:{userId:'regular',groupId:'g'},text,reply:message=>replies.push(message),send:()=>{}})
  await run('文字模式');assert.equal(discovered,0)
  await run('音色列表');assert.match(replies.at(-1),/中文女声：1/);assert.doesNotMatch(replies.at(-1),/原神|纳西妲/)
  await run('语音af_maple');assert.equal(settings.voice,'Maple');assert.equal(settings.language,'en');assert.equal(settings.mode,'voice')
})
