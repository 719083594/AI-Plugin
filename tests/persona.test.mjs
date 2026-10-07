import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonaPrompt, needsPersonaRepair, stripServiceTail } from '../src/core/persona.mjs'
import { defaults, merge, validateConfig } from '../src/core/config.mjs'
import { AIClient } from '../src/core/client.mjs'
import { Storage } from '../src/core/storage.mjs'

test('legacy presets retain their original system prompt without opting in', () => {
  assert.equal(buildPersonaPrompt({ systemPrompt: '原有角色设定' }), '原有角色设定')
  assert.equal(buildPersonaPrompt({ systemPrompt: '原有角色设定', chatStyle: 'default', replyDetail: 'auto', dialogueExamples: '' }), '原有角色设定')
})

test('preset style and examples reach every tool round, stay isolated and never enter stored history', async t => {
  const config = merge(defaults, {
    channels: [{ id: 'mock', type: 'openai', models: ['mock-model'] }],
    presets: [
      { id: 'star', model: 'mock-model', systemPrompt: '星的身份', chatStyle: 'natural', replyDetail: 'balanced', dialogueExamples: '用户：在吗\n星：在。喊两遍是有大事吗？', tools: ['web_search'], maxTokens: 3072 },
      { id: 'firefly', model: 'mock-model', systemPrompt: '流萤的身份', dialogueExamples: '用户：你好\n流萤：见到你很开心。', tools: [] }
    ], basic: { defaultPresetId: 'star' }, group: { proactiveEnabled: true }
  })
  const storage = new Storage(), requests = []
  const client = new AIClient({ config: () => config, storage, imageStore: {}, search: async () => ({ ok: true, results: [{ title: '来源', url: 'https://source.invalid/example' }] }), provider: async request => {
    requests.push(structuredClone(request.messages))
    return requests.length === 1
      ? { contents: [], toolCalls: [{ id: 'search1', name: 'web_search', arguments: { query: '示例' } }] }
      : { contents: [{ type: 'text', text: '本轮真实回答' }], toolCalls: [] }
  } })
  t.after(() => client.close())
  await client.chat({ userId: 'test', text: '帮我查查' })
  for (const messages of requests) {
    const prompt = messages[0].content[0].text
    assert.match(prompt, /星的身份/); assert.match(prompt, /客服/); assert.match(prompt, /三到六句/); assert.match(prompt, /喊两遍/)
    assert.doesNotMatch(prompt, /流萤/)
  }
  const state = storage.state('test')
  assert.doesNotMatch(JSON.stringify(storage.history(state.current.conversationId)), /喊两遍|自然聊天|星的身份/)
  await client.chat({ userId: 'other', text: '你好', presetId: 'firefly', transient: true })
  assert.match(requests.at(-1)[0].content[0].text, /见到你很开心/)
  assert.doesNotMatch(requests.at(-1)[0].content[0].text, /喊两遍|星的身份/)
  await client.chat({ userId: 'test', groupId: 'group', text: '闲聊', proactive: true })
  assert.match(requests.at(-1)[0].content[0].text, /本轮简短接话/)
})

test('persona settings reject malformed values while allowing older config', () => {
  assert.doesNotThrow(() => validateConfig(merge(defaults, {})))
  for (const invalid of [{ chatStyle: 'typo' }, { replyDetail: 'typo' }, { dialogueExamples: [] }, { dialogueExamples: '长'.repeat(20001) }]) {
    assert.throws(() => validateConfig(merge(defaults, { presets: [{ ...defaults.presets[0], ...invalid }] })), /聊天风格|展开程度|对话示例/)
  }
})

test('generic service invitations are caught while useful specific questions remain', () => {
  for (const text of ['你好！很高兴和你聊天，有什么可以帮你的吗？','你有什么需要帮助的吗？','如果有什么需要帮忙的，随时告诉我。','你好呀。有什么想聊的吗？','嗨！今天有什么新鲜事吗？']) assert.equal(needsPersonaRepair(text),true,text)
  assert.equal(needsPersonaRepair('你好啊。你刚才说的是哪一张图片？'),false)
  assert.equal(stripServiceTail('你好！很高兴和你聊天，有什么可以帮你的吗？'),'你好！')
  assert.equal(stripServiceTail('你好呀，看到你过来，我也放松了一点。有什么想聊的吗？'),'你好呀，看到你过来，我也放松了一点。')
})

test('natural preset repairs a service reply before one final send and stores only the repaired text', async t => {
  const config=merge(defaults,{channels:[{id:'mock',type:'openai'}],presets:[{id:'default',model:'mock',tools:[],chatStyle:'natural'}]})
  let rounds=0,sends=0
  const storage=new Storage(),client=new AIClient({config:()=>config,storage,imageStore:{},provider:async request=>{
    rounds++; if(rounds===2){assert.equal(request.tools.length,0);assert.match(request.messages.at(-1).content[0].text,/改写/)}
    return {contents:[{type:'text',text:rounds===1?'你好！有什么可以帮你的吗？':'嗯，看到你了。'}],usage:{outputTokens:3},toolCalls:[]}
  }});t.after(()=>client.close())
  const result=await client.chat({userId:'u',text:'你好啊',isMaster:true},{send:async()=>{sends++;return true}})
  assert.equal(result.text,'嗯，看到你了。');assert.equal(sends,1);assert.equal(rounds,2);assert.equal(result.usage.outputTokens,6)
  const state=storage.state('u');assert.doesNotMatch(JSON.stringify(storage.history(state.current.conversationId)),/可以帮你/)
})
