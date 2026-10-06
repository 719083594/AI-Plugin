import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {AIClient} from '../src/core/client.mjs'
import {Storage} from '../src/core/storage.mjs'
import {defaults,merge} from '../src/core/config.mjs'
const row=(title,command,permission='all',category='群聊与消息')=>({title,command,permission,category,description:title+'的真实功能',source:'Example/index.js',directory:'Example',handler:title})
const rows=[row('帮助','#指令表'),row('联网搜索','#搜索 内容','all','搜索与资料'),row('群卫帮助','#群管帮助'),row('禁言','#群管禁言 @成员 10分钟','admin'),row('群开关','#群管开启','owner'),row('重启系统','#秘密重启','master','维护与更新')]
function setup(t,role='member') {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-command-knowledge-'));const storage=new Storage();let current=structuredClone(rows),available=true;const captured=[]
 const config=merge(defaults,{channels:[{id:'test',type:'openai',baseUrl:'https://example.invalid',apiKey:'test',models:['fake']}],presets:[{...defaults.presets[0],model:'fake',tools:[]}],memory:{knowledgeEnabled:true},security:{maxRequestsPerWindow:100}})
 const client=new AIClient({root,storage,config:()=>config,imageStore:{},host:{getCommandCatalog:async input=>available?{rows:current.filter(row=>!input||row.permission!=='master'||input.isMaster&&!input.groupId),pluginCount:1,memberRole:role}:null},provider:async request=>{captured.push(request.messages.find(row=>row.role==='system').content);return {contents:[{type:'text',text:'请使用 #搜索 内容'}],usage:{}}}})
 t.after(()=>{client.close();fs.rmSync(root,{recursive:true,force:true})});return {client,storage,config,captured,setRows:value=>current=value,disable:()=>available=false,root}
}
test('managed knowledge is updated in place, removes missing commands, preserves manual facts and isolates generic retrieval',async t=>{
 const {client,storage,setRows,root}=setup(t);const manual=storage.addKnowledge('手工资料','秘密重启的手工说明')
 assert.equal(await client.commandKnowledge.sync(),true);assert.equal(storage.stats().knowledge,7)
 const file=path.join(root,'data/knowledge/commands.md'),first=fs.statSync(file).mtimeMs;assert(fs.readFileSync(file,'utf8').includes('#秘密重启'))
 const timestamps=storage.db.prepare("SELECT createdAt FROM knowledge WHERE id LIKE 'commands:%'").all();assert.equal(await client.commandKnowledge.sync(),false);assert.equal(fs.statSync(file).mtimeMs,first)
 assert.deepEqual(storage.searchKnowledge('秘密重启').map(row=>row.id),[manual]);setRows([row('最新搜索','#搜 新内容','all','搜索与资料')]);assert.equal(await client.commandKnowledge.sync(),true)
 assert.equal(storage.stats().knowledge,2);assert(!fs.readFileSync(file,'utf8').includes('#秘密重启'));assert.deepEqual(timestamps.length,6)
})
test('natural capability questions use real scoped commands even when generic keyword matching would miss them',async t=>{
 const {client,captured,storage}=setup(t);await client.commandKnowledge.sync();assert.deepEqual(storage.searchKnowledge('你能干什么'),[])
 await client.chat({userId:'member',botId:'bot',groupId:'group',text:'你能干什么',isMaster:false,transient:true})
 const prompt=JSON.stringify(captured[0]);assert(prompt.includes('#搜索 内容'));assert(prompt.includes('#群管帮助'));assert(!prompt.includes('#秘密重启'));assert(!prompt.includes('#群管禁言 @'))
 const context=await client.commandKnowledge.context({userId:'member',groupId:'group',text:'怎么禁言'});assert(context.includes('禁言需要群管理员/群主权限'));assert(!context.includes('#群管禁言 @'))
 assert.equal(await client.commandKnowledge.context({userId:'member',text:'你好呀'}),'')
})
test('admin, owner and private master contexts remain separate; unavailable source and disabled switch do not recommend stale commands',async t=>{
 const admin=setup(t,'admin'),owner=setup(t,'owner'),unknown=setup(t,'unknown');const input={userId:'user',groupId:'group',text:'你能干什么',isMaster:false,memberRole:'owner'}
 assert((await admin.client.commandKnowledge.context(input)).includes('#群管禁言 @'));assert(!(await admin.client.commandKnowledge.context(input)).includes('#群管开启'))
 assert((await owner.client.commandKnowledge.context(input)).includes('#群管开启'));assert(!(await unknown.client.commandKnowledge.context(input)).includes('#群管禁言 @'))
 assert((await admin.client.commandKnowledge.context({...input,groupId:'',isMaster:true})).includes('#秘密重启'))
 assert(!(await admin.client.commandKnowledge.context({...input,isMaster:true})).includes('#秘密重启'))
 await admin.client.commandKnowledge.sync();admin.disable();assert.equal(await admin.client.commandKnowledge.context(input),'');admin.config.memory.commandKnowledgeEnabled=false;assert.equal(await admin.client.commandKnowledge.sync(),false)
})
test('periodic refresh detects plugin additions without calling a model',async t=>{
 t.mock.timers.enable({apis:['setInterval']});const {client,storage,setRows,captured}=setup(t)
 client.commandKnowledge.start();await client.commandKnowledge.pending;assert.equal(storage.stats().knowledge,6)
 setRows([...rows,row('天气','#天气 城市')]);t.mock.timers.tick(15000);await client.commandKnowledge.pending
 assert.equal(storage.stats().knowledge,7);assert.equal(captured.length,0)
})
test('optional command source errors do not break chat',async t=>{
 const {client,captured}=setup(t);client.host.getCommandCatalog=async()=>{throw new Error('source unavailable')}
 await client.chat({userId:'user',text:'你能干什么',transient:true});assert.equal(captured.length,1);assert(!JSON.stringify(captured[0]).includes('#秘密重启'))
})
