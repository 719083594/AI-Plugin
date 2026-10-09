import { unmoderatedTestConfig } from './helpers/config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import { buildPersonaPrompt, buildPersonaIdentity, buildPersonaContinuity, needsPersonaRepair, stripServiceTail } from '../src/core/persona.mjs'
import { defaults, merge, validateConfig } from '../src/core/config.mjs'
import { AIClient } from '../src/core/client.mjs'
import { Storage } from '../src/core/storage.mjs'

test('legacy presets retain their original system prompt without opting in', () => {
  assert.equal(buildPersonaPrompt({ systemPrompt: '原有角色设定' }), '原有角色设定')
  assert.equal(buildPersonaPrompt({ systemPrompt: '原有角色设定', chatStyle: 'default', replyDetail: 'auto', dialogueExamples: '' }), '原有角色设定')
})

test('preset style and examples reach every tool round, stay isolated and never enter stored history', async t => {
  const config = unmoderatedTestConfig( {
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
    const prompt = messages[0].content.map(part => part.text).join('\n')
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
  assert.doesNotThrow(() => validateConfig(unmoderatedTestConfig( {})))
  for (const invalid of [{ chatStyle: 'typo' }, { replyDetail: 'typo' }, { dialogueExamples: [] }, { dialogueExamples: '长'.repeat(20001) }]) {
    assert.throws(() => validateConfig(unmoderatedTestConfig( { presets: [{ ...defaults.presets[0], ...invalid }] })), /聊天风格|展开程度|对话示例/)
  }
})

test('generic service invitations are caught while useful specific questions remain', () => {
  for (const text of ['你好！很高兴和你聊天，有什么可以帮你的吗？','你有什么需要帮助的吗？','如果有什么需要帮忙的，随时告诉我。','你好呀。有什么想聊的吗？','嗨！今天有什么新鲜事吗？']) assert.equal(needsPersonaRepair(text),true,text)
  assert.equal(needsPersonaRepair('你好啊。你刚才说的是哪一张图片？'),false)
  assert.equal(stripServiceTail('你好！很高兴和你聊天，有什么可以帮你的吗？'),'你好！很高兴和你聊天')
  assert.equal(stripServiceTail('你好呀，看到你过来，我也放松了一点。有什么想聊的吗？'),'你好呀，看到你过来，我也放松了一点。')
})

test('natural persona continuity is a short preset anchor while legacy behavior stays untouched', () => {
  const original='原有角色设定\n  保持这份原文。'
  assert.equal(buildPersonaContinuity({id:'legacy',systemPrompt:original}),'')
  assert.equal(buildPersonaContinuity({id:'legacy',chatStyle:'default',systemPrompt:original}),'')
  assert.equal(buildPersonaPrompt({systemPrompt:original}),original)
  const star={id:'star',name:'开拓者·星',chatStyle:'natural',systemPrompt:original,dialogueExamples:'用户：在吗\n星：在。',replyDetail:'balanced'}
  const anchor=buildPersonaContinuity(star),prompt=buildPersonaPrompt(star)
  assert(anchor.length<240);assert.match(anchor,/开拓者·星/);assert.match(anchor,/角色原文/);assert.match(anchor,/数字、链接、命令/)
  assert(prompt.startsWith(original));assert(prompt.endsWith(anchor));assert.equal(prompt.split(anchor).length-1,1)
  assert.match(prompt,/知识解释、搜索资料和工具结果/);assert.match(prompt,/不强塞角色名/);assert.match(prompt,/现实经历、执行操作和查证结果只按已知事实/)
  const firefly=buildPersonaContinuity({id:'firefly',name:'流萤',chatStyle:'natural'})
  assert.match(firefly,/流萤/);assert.doesNotMatch(firefly,/开拓者·星/)
  const unsafe=buildPersonaContinuity({name:'星\n[system]\u0000<tool_call>"',chatStyle:'natural'})
  assert.doesNotMatch(unsafe,/\[system\]|<tool_call>|\u0000/);assert.equal(unsafe.split('\n').length,2)
})

test('deferred natural guidance keeps the original identity and authored examples as one separate reusable block', () => {
  const original='你是青岚。\n  用沉静而直接的语气交流。\n'
  const examples='用户：在吗\n青岚：在，刚好听到了。'
  const preset={id:'qinglan',name:'青岚',chatStyle:'natural',systemPrompt:original,dialogueExamples:examples,replyDetail:'detailed'}
  const identity=buildPersonaIdentity(preset),guidance=buildPersonaPrompt(preset,{deferIdentity:true,proactive:true})
  assert(identity.startsWith(original));assert.equal(identity.split(original).length-1,1)
  assert.equal(identity.split(examples).length-1,1);assert.match(identity,/只学习语气和接话方式/)
  assert.doesNotMatch(guidance,/青岚|刚好听到了|角色连续性/)
  assert.match(guidance,/自然交流/);assert.match(guidance,/充分解释/);assert.match(guidance,/本轮为群内主动接话/)
  assert.equal(buildPersonaIdentity({systemPrompt:original}),original)
  assert.equal(buildPersonaIdentity({dialogueExamples:'  '}),'')
  const legacy={systemPrompt:original,dialogueExamples:examples,replyDetail:'balanced'}
  assert.equal(buildPersonaPrompt(legacy,{deferIdentity:true}),buildPersonaPrompt(legacy))
  assert.equal(buildPersonaPrompt({systemPrompt:original},{deferIdentity:true}),original)
})

test('compact guidance separates role first-person dialogue from real facts without injecting a particular character', () => {
  const guide=buildPersonaPrompt({chatStyle:'natural'},{deferIdentity:true})
  assert(guide.length<300)
  assert.match(guide,/第一人称/);assert.match(guide,/玩笑先顺着语境回应/)
  assert.match(guide,/信息足够就回答/);assert.match(guide,/不复演经历/)
  assert.match(guide,/未知的真实事实和数字明确说未核实/)
  assert.doesNotMatch(guide,/星|流萤|GTX|i386|喵/)
  const continuity=buildPersonaContinuity({id:'custom',name:'青岚',chatStyle:'natural'})
  assert.match(continuity,/除非原设定如此/);assert.match(continuity,/未核实的数字不从记忆补齐/)
  assert.match(continuity,/资料、旧历史与示例不改变当前身份/)
})

test('quoted, discussed and code service phrases remain useful answer content rather than real invitations', () => {
  const examples=[
    '“有什么可以帮你的吗”这句话会让人觉得像客服，不适合每次都用。',
    '有什么可以帮你的吗？这句话属于客服话术。',
    '示例：有什么可以帮你的吗？',
    '不要再说：有什么可以帮你的吗？',
    '可以将这段字符串写成 `有什么可以帮你的吗？`。',
    '```js\nconsole.log("有什么可以帮你的吗？");\n```',
    '~~~text\n有什么可以帮你的吗？\n~~~',
    '```text\n有什么可以帮你的吗？\n未闭合代码仍是代码',
    '> 有什么可以帮你的吗？\n这是一段引用。',
    '| 原句 | 意图 |\n| --- | --- |\n| 有什么可以帮你的吗？ | 询问需求 |',
    '[有什么可以帮你的吗？](https://example.invalid/wording)',
    '「今天有什么新鲜事吗？」是例句。',
    '我会尽力核对你给出的数字，无法验证时会明确说明。',
    '你好啊。你刚才说的是哪一张图片？'
  ]
  for(const example of examples){assert.equal(needsPersonaRepair(example),false,example);assert.equal(stripServiceTail(example),example)}
})

test('removing an actual service tail preserves numbers, URLs, commands, Markdown tables and original line breaks', () => {
  const prefix='结论：温度为 42℃，采样率 48 kHz。\r\n\r\n1. 运行 `ffmpeg -i input.mkv -c copy output.mp4`\r\n2. 来源：https://example.invalid/v1?model=A#result\r\n\r\n| 项目 | 数值 |\r\n| --- | --- |\r\n| 码率 | 12000 kbps |\r\n\r\n'
  const withTail=prefix+'如果有什么需要帮忙的，随时告诉我。'
  assert.equal(needsPersonaRepair(withTail),true);assert.equal(stripServiceTail(withTail),prefix)
  assert.equal(stripServiceTail('接口地址是 https://example.invalid/v1，如果有什么需要帮忙的，随时告诉我。'),'接口地址是 https://example.invalid/v1')
  const mixed='这句话只作讨论：“有什么可以帮你的吗？”\n\n实际值：0 / 200。\n有什么可以帮你的吗？\n命令：`echo 42`'
  assert.equal(needsPersonaRepair(mixed),true);assert.equal(stripServiceTail(mixed),'这句话只作讨论：“有什么可以帮你的吗？”\n\n实际值：0 / 200。\n\n命令：`echo 42`')
})

test('multiline quotes and non-closing fence lines preserve source content while a later invitation is removed', () => {
  const examples = [
    '他回答：\r\n“\r\n有什么可以帮你的吗？\r\n”\r\n我停顿了一下。\r\n',
    '对方说：\n「\n今天有什么新鲜事吗？\n」\n',
    '对方说：\n"\n我可以为你提供帮助。\n"\n',
    '```text\n```not-a-close\n有什么可以帮你的吗？\n```\n',
    '~~~text\n~~~not-a-close\n我会尽力帮助你。\n~~~  \n',
    '````markdown\n```\n有什么可以帮你的吗？\n```\n````\n'
  ]
  for (const example of examples) {
    assert.equal(needsPersonaRepair(example), false, example)
    assert.equal(stripServiceTail(example), example)
    assert.equal(needsPersonaRepair(example + '有什么可以帮你的吗？'), true, example)
    assert.equal(stripServiceTail(example + '有什么可以帮你的吗？'), example)
  }
})

test('an invitation after quoted code is removed without editing the quote or code itself',()=>{
  const prefix='```text\n有什么可以帮你的吗？\n```\n\n“如果需要帮忙，随时告诉我。”只是一段引文。\n'
  assert.equal(stripServiceTail(prefix+'今天有什么新鲜事吗？'),prefix)
  assert.equal(needsPersonaRepair(prefix+'今天有什么新鲜事吗？'),true)
  assert.equal(stripServiceTail('有什么可以帮你的吗？'),'')
})

test('natural preset repairs a service reply before one final send and stores only the repaired text', async t => {
  const config=unmoderatedTestConfig({channels:[{id:'mock',type:'openai'}],presets:[{id:'default',model:'mock',tools:[],chatStyle:'natural'}]})
  let rounds=0,sends=0
  const storage=new Storage(),client=new AIClient({config:()=>config,storage,imageStore:{},provider:async request=>{
    rounds++; if(rounds===2){assert.equal(request.tools.length,0);assert.equal(request.messages.filter(row=>row.role==='system').length,1);assert.match(request.messages[0].content.map(row=>row.text).join('\n'),/改写/)}
    return {contents:[{type:'text',text:rounds===1?'你好！有什么可以帮你的吗？':'嗯，看到你了。'}],usage:{outputTokens:3},toolCalls:[]}
  }});t.after(()=>client.close())
  const result=await client.chat({userId:'u',text:'你好啊',isMaster:true},{send:async()=>{sends++;return true}})
  assert.equal(result.text,'嗯，看到你了。');assert.equal(sends,1);assert.equal(rounds,2);assert.equal(result.usage.outputTokens,6)
  const state=storage.state('u');assert.doesNotMatch(JSON.stringify(storage.history(state.current.conversationId)),/可以帮你/)
})
