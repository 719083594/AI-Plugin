import { unmoderatedTestConfig } from './helpers/config.mjs'
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { AIClient } from '../src/core/client.mjs'
import { Storage } from '../src/core/storage.mjs'
import { defaults, merge } from '../src/core/config.mjs'

const input = extra => ({ userId: 'voice-user-a', botId: 'voice-bot', text: '今天吃什么', ...extra })
const answer = (text = '今天吃番茄鸡蛋面。') => ({ contents: [{ type: 'text', text }], toolCalls: [], usage: {} })
const audioData = 'c2Vuc2l0aXZlLWZha2UtYXVkaW8='
const audio = text => ({ type: 'audio', data: audioData, mime: 'audio/wav', text })
const makeConfig = extra => unmoderatedTestConfig( merge({
  channels: [{ id: 'voice-test', type: 'openai', apiKey: 'test-model-secret', models: ['test-model'] }],
  presets: [{ ...structuredClone(defaults.presets[0]), model: 'test-model', tools: [] }],
  speech: { enabled: true, endpoint: 'https://speech.invalid', token: 'test-private-speech-token' },
  management: { enabled: false }, security: { maxRequestsPerWindow: 100 }
}, extra || {}))
function fixture(t, { config = makeConfig(), provider = async () => answer(), speechService = { synthesize: async text => audio(text) }, storage = new Storage(), ...options } = {}) {
  const client = new AIClient({ config: () => config, storage, provider, speechService, imageStore: {}, ...options })
  t.after(() => client.close())
  return { client, config, storage }
}
function history(client, storage, who = input()) {
  const state = storage.state(client.userKey(who))
  return storage.history(state.current.conversationId, 100, state.current.messageId)
}
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
async function within(promise, milliseconds = 1000) {
  const stop = new AbortController()
  try { return await Promise.race([promise, delay(milliseconds, undefined, { signal: stop.signal }).then(() => { throw new Error('operation failed to settle after cancellation') })]) }
  finally { stop.abort() }
}

test('default text chat never calls the configured speech service', async t => {
  let calls = 0
  const { client } = fixture(t, { speechService: { synthesize: async () => { calls++; throw new Error('unexpected TTS') } } })
  const delivered = []
  const result = await client.chat(input(), { send: async output => { delivered.push(output); return true } })
  assert.equal(client.speechSettings().mode, 'text')
  assert.equal(calls, 0)
  assert.equal(result.contents.some(part => part.type === 'audio'), false)
  assert.equal(delivered.length, 1)
  assert.equal(result.text, '今天吃番茄鸡蛋面。')
})

test('a non-owner changes one global speech setting across users, bots and SQLite restarts', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-voice-persist-'))
  t.after(async () => {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep))
    assert.ok(path.basename(resolved).startsWith('ai-plugin-voice-persist-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const filename = path.join(root, 'voice.db'), config = makeConfig()
  const first = new AIClient({ root, config: () => config, storage: new Storage(filename), imageStore: {}, speechService: {} })
  const expected = { mode: 'voice', voice: '琪亚娜', game: 'honkai3', language: 'zh' }
  try {
    assert.deepEqual(first.setSpeechSettings(input({ isMaster: false }), expected), expected)
    assert.deepEqual(first.speechSettings(input({ userId: 'another-user', botId: 'another-bot' })), expected)
    const saved = first.storage.maintenance('speech-settings')
    assert.deepEqual(Object.fromEntries(Object.keys(expected).map(key => [key, saved[key]])), expected)
    assert.equal(first.storage.users().length, 0)
  } finally { first.close() }
  const reopened = new AIClient({ root, config: () => config, storage: new Storage(filename), imageStore: {}, speechService: {} })
  try { assert.deepEqual(reopened.speechSettings(input({ userId: 'after-restart' })), expected) }
  finally { reopened.close() }
})

test('switching the global speech settings preserves existing conversations and an active LLM request', async t => {
  const started = deferred(), providerResult = deferred(); let calls = 0, providerSignal, syntheses = 0
  const { client, storage } = fixture(t, {
    provider: async ({ signal }) => { if (++calls === 1) return answer('原来的回答'); providerSignal = signal; started.resolve(); return providerResult.promise },
    speechService: { synthesize: async text => { syntheses++; return audio(text) } }
  })
  await client.chat(input())
  const before = structuredClone(storage.state(client.userKey(input())))
  const pending = client.chat(input({ text: '切换时继续回答' }))
  await started.promise
  client.setSpeechSettings(input({ userId: 'voice-user-b' }), { mode: 'voice', voice: '纳西妲', game: 'genshin' })
  assert.equal(providerSignal.aborted, false)
  assert.deepEqual(storage.state(client.userKey(input())), before)
  providerResult.resolve(answer('继续完成回答'))
  const result = await within(pending)
  assert.equal(result.text, '继续完成回答')
  assert.equal(syntheses, 1)
  assert.equal(storage.state(client.userKey(input())).current.conversationId, before.current.conversationId)
  assert.equal(history(client, storage).length, 4)
})

test('voice chat emits audio but stores text history and never resends audio data to the model', async t => {
  const modelMessages = [], syntheses = [], delivered = []
  const { client, storage } = fixture(t, {
    provider: async request => { modelMessages.push(structuredClone(request.messages)); return answer('面已经煮好了。') },
    speechService: { synthesize: async (text, options) => { syntheses.push({ text, voice: options.voice }); return audio(text) } }
  })
  client.setSpeechSettings(input(), { mode: 'voice', voice: '纳西妲' })
  const result = await client.chat(input(), { send: async output => { delivered.push(structuredClone(output)); return true } })
  assert.equal(result.speechMode, 'voice')
  assert.equal(result.contents.filter(part => part.type === 'audio').length, 1)
  assert.equal(delivered[0].contents.at(-1).data, audioData)
  assert.deepEqual(syntheses[0], { text: '面已经煮好了。', voice: '纳西妲（草神）' })
  assert.doesNotMatch(JSON.stringify(history(client, storage)), new RegExp(audioData + '|audio/wav|"type":"audio"'))
  await client.chat(input({ text: '再加一个鸡蛋' }))
  assert.deepEqual(modelMessages[1].map(row => row.role), ['system', 'user', 'assistant', 'user'])
  assert.doesNotMatch(JSON.stringify(modelMessages[1]), new RegExp(audioData + '|base64://|audio/wav|"type":"audio"'))
})

test('TTS failure retains the completed text and redacts speech credentials in results and logs', async t => {
  const config = makeConfig(), deliveries = []
  const { client, storage } = fixture(t, { config, speechService: { synthesize: async () => { throw new Error(`unavailable ${config.speech.token} Bearer hidden-access-token ${config.channels[0].apiKey}`) } } })
  client.setSpeechSettings(input(), { mode: 'voice' })
  const result = await client.chat(input(), { send: async output => { deliveries.push(output); return true } })
  assert.equal(result.text, '今天吃番茄鸡蛋面。')
  assert.equal(result.contents.some(part => part.type === 'audio'), false)
  assert.ok(result.speechError)
  assert.equal(deliveries.length, 1)
  assert.equal(history(client, storage).length, 2)
  const exported = JSON.stringify({ result, logs: storage.logs(), history: history(client, storage) })
  assert.doesNotMatch(exported, /test-private-speech-token|hidden-access-token|test-model-secret/)
  assert.match(exported, /已隐藏/)
})

test('manual speak does not call the language model, switch modes or alter conversation history', async t => {
  let models = 0, syntheses = 0
  const { client, storage } = fixture(t, {
    provider: async () => { models++; return answer() },
    speechService: { synthesize: async text => { syntheses++; return audio(text) } }
  })
  await client.chat(input())
  const state = structuredClone(storage.state(client.userKey(input()))), beforeHistory = structuredClone(history(client, storage))
  const result = await client.speak(input(), '只把这句话读出来。')
  assert.equal(models, 1)
  assert.equal(syntheses, 1)
  assert.equal(result.contents[0].type, 'audio')
  assert.equal(result.text, '只把这句话读出来。')
  assert.equal(client.speechSettings().mode, 'text')
  assert.deepEqual(storage.state(client.userKey(input())), state)
  assert.deepEqual(history(client, storage), beforeHistory)
})

test('another user switching mode cancels only synthesis and delivers the original chat as text', async t => {
  const started = deferred(), oldAudio = deferred(), deliveries = []; let speechSignal
  const { client, storage } = fixture(t, { speechService: { synthesize: async (_text, { signal }) => { speechSignal = signal; started.resolve(); return oldAudio.promise } } })
  client.setSpeechSettings(input(), { mode: 'voice' })
  const pending = client.chat(input(), { send: async output => { deliveries.push(structuredClone(output)); return true } })
  await started.promise
  client.setSpeechSettings(input({ userId: 'switching-user' }), { mode: 'text' })
  assert.equal(speechSignal.aborted, true)
  const result = await within(pending)
  oldAudio.resolve(audio('过期语音'))
  await delay(0)
  assert.equal(result.text, '今天吃番茄鸡蛋面。')
  assert.ok(result.speechError)
  assert.equal(result.contents.some(part => part.type === 'audio'), false)
  assert.equal(deliveries.length, 1)
  assert.equal(history(client, storage).length, 2)
})

test('end, cancel and an external signal prevent late audio and failed turns from being sent or stored', async t => {
  for (const action of ['end', 'cancel', 'external']) {
    const started = deferred(), oldAudio = deferred(), external = new AbortController(); let speechSignal, sends = 0
    const { client, storage } = fixture(t, { speechService: { synthesize: async (_text, { signal }) => { speechSignal = signal; started.resolve(); return oldAudio.promise } } })
    client.setSpeechSettings(input(), { mode: 'voice' })
    const pending = client.chat(input(), { signal: external.signal, send: async () => { sends++; return true } })
    const rejected = assert.rejects(pending, /变更|取消|cancelled/)
    await started.promise
    if (action === 'external') external.abort(new Error('cancelled by caller'))
    else client[action](input())
    assert.equal(speechSignal.aborted, true, action)
    oldAudio.resolve(audio('不能发送的过期音频'))
    await within(rejected)
    assert.equal(sends, 0, action)
    assert.equal(storage.stats().history, 0, action)
  }
})

test('manual synthesis also respects external cancellation, end and cancel', async t => {
  for (const action of ['end', 'cancel', 'external']) {
    const started = deferred(), oldAudio = deferred(), external = new AbortController()
    const { client } = fixture(t, { speechService: { synthesize: async () => { started.resolve(); return oldAudio.promise } } })
    const pending = client.speak(input(), '请朗读', { signal: external.signal })
    const rejected = assert.rejects(pending, /变更|取消|cancelled/)
    await started.promise
    if (action === 'external') external.abort(new Error('cancelled by caller'))
    else client[action](input())
    oldAudio.resolve(audio('过期音频'))
    await within(rejected)
    assert.equal(client.speechControllers.size, 0)
  }
})

test('speech settings and synthesis enforce access lists, chat switches and input filters before contacting TTS', async t => {
  const cases = [
    { patch: { basic: { enabled: false } }, who: input(), expected: /停用/ },
    { patch: { security: { userBlacklist: ['voice-user-a'] } }, who: input(), expected: /权限/ },
    { patch: { security: { userWhitelist: ['other-user'] } }, who: input(), expected: /权限/ },
    { patch: { security: { groupBlacklist: ['forbidden-group'] } }, who: input({ groupId: 'forbidden-group' }), expected: /权限/ },
    { patch: { security: { groupWhitelist: ['allowed-group'] } }, who: input({ groupId: 'other-group' }), expected: /权限/ },
    { patch: { chat: { privateEnabled: false } }, who: input(), expected: /私聊.*关闭/ },
    { patch: { chat: { groupEnabled: false } }, who: input({ groupId: 'group' }), expected: /群聊.*关闭/ }
  ]
  for (const item of cases) {
    let syntheses = 0
    const { client } = fixture(t, { config: makeConfig(item.patch), speechService: { synthesize: async text => { syntheses++; return audio(text) } } })
    assert.throws(() => client.setSpeechSettings(item.who, { mode: 'voice' }), item.expected)
    await assert.rejects(client.speak(item.who, '不应发出的语音'), item.expected)
    assert.equal(client.speechSettings().mode, 'text')
    assert.equal(syntheses, 0)
  }
  let syntheses = 0
  const { client } = fixture(t, { config: makeConfig({ security: { inputBlockedWords: ['不可朗读'] } }), speechService: { synthesize: async text => { syntheses++; return audio(text) } } })
  await assert.rejects(client.speak(input(), '包含不可朗读内容'), /屏蔽/)
  assert.equal(syntheses, 0)
})

test('speech and chat share the per-user rate budget while global mode switching costs no TTS request', async t => {
  let syntheses = 0, models = 0
  const { client } = fixture(t, {
    config: makeConfig({ security: { maxRequestsPerWindow: 1 } }),
    provider: async () => { models++; return answer() },
    speechService: { synthesize: async text => { syntheses++; return audio(text) } }
  })
  client.setSpeechSettings(input(), { mode: 'voice' })
  client.setSpeechSettings(input(), { mode: 'text' })
  await client.speak(input(), '第一次')
  await assert.rejects(client.speak(input(), '第二次'), /频繁/)
  await assert.rejects(client.chat(input()), /频繁/)
  await client.speak(input({ userId: 'other-user' }), '其他用户')
  assert.equal(syntheses, 2)
  assert.equal(models, 0)
})
