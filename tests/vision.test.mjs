import { unmoderatedTestConfig } from './helpers/config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { AIClient } from '../src/core/client.mjs'
import { defaults, merge } from '../src/core/config.mjs'
import { Storage } from '../src/core/storage.mjs'
import { ImageStore } from '../src/media/index.mjs'
import { selectVision } from '../src/core/vision.mjs'

const png='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII='
const who={userId:'10001',botId:'20001',text:'请看图'}
const config=()=>unmoderatedTestConfig({management:{enabled:false},security:{maxRequestsPerWindow:100},channels:[{id:'gateway',type:'openai',enabled:true,models:[{name:'chat',features:['chat','tool']},{name:'eye',features:['visual','chat','tool']}]}],presets:[{...defaults.presets[0],model:'chat',systemPrompt:'你是星，保留角色风格。',tools:[]}]})
const answer=text=>({contents:[{type:'text',text}],toolCalls:[],usage:{totalTokens:1}})
async function fixture(t,provider){
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'ai-vision-test-')),c=config(),storage=new Storage(),images=new ImageStore({directory:path.join(root,'images')})
 const client=new AIClient({root,config:()=>c,storage,imageStore:images,provider})
 t.after(async()=>{client.close(); assert.ok(path.basename(root).startsWith('ai-vision-test-'));await fs.rm(root,{recursive:true,force:true})})
 return {client,c,storage,images}
}
test('both visual capability spellings work and a text-only role is never a vision fallback',()=>{
 const c=config();assert.equal(selectVision(c,c.presets[0]).model,'eye')
 c.channels[0].models[1].features=['vision'];assert.equal(selectVision(c,c.presets[0]).model,'eye')
 c.channels[0].models.pop();assert.throws(()=>selectVision(c,c.presets[0]),/视觉模型/)
})
test('explicit visual binding is honored, disabled and known text-only bindings fail',()=>{
 const c=config();c.media.visionModel='eye';c.media.visionChannelId='gateway';assert.equal(selectVision(c,c.presets[0]).model,'eye')
 c.media.visionModel='chat';assert.throws(()=>selectVision(c,c.presets[0]),/未声明视觉/)
 c.media.visionModel='eye';c.channels[0].enabled=false;assert.throws(()=>selectVision(c,c.presets[0]),/没有可用/)
})
test('one image request retains the role and history, stores refs and sends only once',async t=>{
 const requests=[]; const {client,storage}=await fixture(t,async request=>{requests.push(structuredClone(request));return answer('看到了红色方形')})
 await client.chat({...who,text:'记住代号青杉'})
 const prior=storage.state(client.userKey(who)).current.conversationId
 let sends=0;const result=await client.chat({...who,images:[{type:'image',data:png}]},{send:async()=>{sends++;return true}})
 assert.equal(sends,1);assert.equal(result.model,'eye');assert.equal(result.presetId,'default')
 assert.equal(requests[1].messages[0].content[0].text,'你是星，保留角色风格。')
 assert.equal(requests[1].messages[1].content[0].text,'记住代号青杉')
 assert.equal(requests[1].messages.at(-1).content.at(-1).data,png)
 assert.equal(requests[1].options.stream,false)
 assert.equal(storage.state(client.userKey(who)).current.conversationId,prior)
 const saved=storage.history(prior,20);assert.match(JSON.stringify(saved),/img_/);assert.doesNotMatch(JSON.stringify(saved),new RegExp(png.slice(0,24)))
 await client.chat({...who,text:'你好'})
 assert.equal(requests[2].model,'chat');assert.ok(requests[2].messages.every(row=>!row.content.some(part=>part.type==='image')))
})
test('picture follow-up resolves prior cache and keeps the selected role',async t=>{
 const requests=[];const {client}=await fixture(t,async r=>{requests.push(r);return answer('真实描述')})
 await client.chat({...who,images:[{type:'image',data:png}]})
 await client.chat({...who,text:'刚才那张图里有什么？'})
 assert.equal(requests[1].model,'eye');assert.equal(requests[1].messages.at(-1).content.at(-1).data,png)
})
test('expired earlier images require a new image rather than guessing',async t=>{
 const {client,images}=await fixture(t,async()=>answer('描述'))
 await client.chat({...who,images:[{type:'image',data:png}]})
 for(const image of images.metadata.values())image.expiresAt=0
 await assert.rejects(client.chat({...who,text:'刚才那张图呢？'}),/重新发送图片/)
})
test('disabled recognition blocks direct inputs and image tools without provider calls',async t=>{
 let calls=0;const {client,c}=await fixture(t,async()=>{calls++;return answer('描述')});c.media.imagesEnabled=false
 await assert.rejects(client.chat({...who,images:[{type:'image',data:png}]}),/识图已关闭/)
 await assert.rejects(client.vision({images:[{type:'image',data:png}],context:who}),/识图已关闭/)
 assert.equal(calls,0)
})
test('foreign private, group and bot references cannot be sent to a model',async t=>{
 let calls=0;const {client,images}=await fixture(t,async()=>{calls++;return answer('描述')})
 for(const options of [{userId:'another'},{userId:who.userId,groupId:'other-group'},{userId:who.userId,origin:'other-bot'}]){
  const ref=await images.save({data:png},options)
  await assert.rejects(client.chat({...who,images:[{type:'image',ref}]}),/不能读取/)
 }
 assert.equal(calls,0)
})
test('rate limited visual requests report failure, send nothing and do not advance history',async t=>{
 const {client,storage}=await fixture(t,async()=>{throw Object.assign(new Error('upstream'),{status:429})})
 let sends=0;await assert.rejects(client.chat({...who,images:[{type:'image',data:png}]},{send:()=>{sends++;return true}}),/视觉模型当前限流/)
 assert.equal(sends,0);assert.equal(storage.stats().history,0)
})
test('ref-only content, image-only question, size and image count checks work',async t=>{
 let request;const {client,images}=await fixture(t,async r=>{request=r;return answer('描述')})
 const ref=await images.save({data:png},{userId:who.userId})
 await client.chat({...who,text:'',content:[{type:'image',ref}]})
 assert.match(request.messages.at(-1).content[0].text,/描述图片/)
 await assert.rejects(client.chat({...who,images:[{type:'image',data:'bm90LWFuLWltYWdl'}]}),/图片/)
 await assert.rejects(client.chat({...who,images:Array.from({length:5},()=>({type:'image',ref}))}),/最多.*4/)
})
test('QQ image normalization supports flattened and OneBot nested segments',async()=>{
 globalThis.plugin=class{};const {normalizeEvent,messageImages}=await import('../integrations/yunzai/index.js');delete globalThis.plugin
 const parts=[{type:'image',data:{url:'https://example.com/a.png'}},{type:'image',file:'base64://'+png},{type:'image',data:{file:'/private/file.png'}}]
 assert.equal(messageImages(parts).length,2)
 const input=normalizeEvent({user_id:who.userId,message:[{type:'text',data:{text:'这是什么'}},...parts]})
 assert.equal(input.text,'这是什么');assert.equal(input.images[1].data,png)
})
