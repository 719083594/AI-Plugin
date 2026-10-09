import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { AIClient } from '../src/core/client.mjs'
import { defaults, merge, validateConfig, mask } from '../src/core/config.mjs'
import { Storage } from '../src/core/storage.mjs'
import { createVoiceCatalog } from '../src/speech/voices.mjs'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII='
const who = extra => ({ userId: 'media-user', botId: 'media-bot', groupId: 'media-group', ...extra })
const image = { type: 'image', data: png, mimeType: 'image/png' }
const video = { type: 'video', data: 'ZmFrZS12aWRlby1mb3ItY29yZS10ZXN0', mimeType: 'video/mp4' }
async function fixture(t, extra = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-generation-test-'))
  t.after(async () => {
    const resolved = path.resolve(root)
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep) && path.basename(resolved).startsWith('ai-generation-test-'))
    await fs.rm(resolved, { recursive: true, force: true })
  })
  const config = merge(defaults, { management: { enabled: false }, generation: { enabled: true, endpoint: 'https://media.invalid', token: 'test-private-media-token' }, ...extra.config })
  const calls = [], service = extra.generationService || { async image(args) { calls.push(['image', args]); return image }, async video(args) { calls.push(['video', args]); return video } }
  const client = new AIClient({ root, config: () => config, storage: new Storage(), generationService: service, ...extra.client })
  t.after(() => client.close())
  return { client, config, calls }
}

test('media commands work without a chat model, preserve global text mode and reuse only scoped generated images', async t => {
  const { client, calls } = await fixture(t)
  const generated = await client.generateImage(who(), { prompt: '画一只猫' })
  assert.equal(generated.contents[0].type, 'image')
  assert.match(generated.contents[0].ref, /^img_/)
  const result = await client.generateVideo(who(), { prompt: '转头', effectsEnabled: false })
  assert.equal(result.contents[0].type, 'video')
  assert.equal(calls[1][1].image.data, png)
  assert.equal(calls[1][1].effectsEnabled, false)
  assert.equal(client.speechSettings().mode, 'text')
  assert.equal(client.storage.stats().history, 0)
  await assert.rejects(client.generateVideo(who({ groupId: 'another-group' }), { prompt: '转头' }), /附带|引用/)
  await assert.rejects(client.generateVideo(who({ userId: 'another-user' }), { prompt: '转头' }), /附带|引用/)
  await assert.rejects(client.generateVideo(who({ groupId: 'another-group' }), { prompt: '转头', imageRef: generated.contents[0].ref }), /其他群/)
  client.end(who())
  await assert.rejects(client.generateVideo(who(), { prompt: '转头' }), /附带|引用/)
})

test('access restrictions, frequency and blocked words apply before media jobs', async t => {
  const { client, config, calls } = await fixture(t)
  config.security.userBlacklist = ['media-user']
  await assert.rejects(client.generateImage(who(), { prompt: '猫' }), /权限/)
  config.security.userBlacklist = []; config.chat.groupEnabled = false
  await assert.rejects(client.generateImage(who(), { prompt: '猫' }), /已关闭/)
  config.chat.groupEnabled = true; config.security.inputBlockedWords = ['blocked']
  await assert.rejects(client.generateImage(who(), { prompt: 'blocked' }), /屏蔽/)
  assert.equal(calls.length, 0)
  config.security.maxRequestsPerWindow = 1
  await assert.rejects(client.generateImage(who(), { prompt: '猫' }), /频繁/)
  await client.generateImage(who({ isMaster: true }), { prompt: '猫' })
  assert.equal(calls.length, 1)
})

test('video narration resolves current shared voice ID without changing the global mode', async t => {
  const catalog = createVoiceCatalog({ voices: [{ id: 'zf_001', label: '中文女声001', language: 'zh', group: '中文女声' }], defaultVoice: 'zf_001', defaultLanguage: 'zh', languages: { Chinese: 'zh' } })
  const { client, config, calls } = await fixture(t, { client: { speechService: { catalogue: async () => catalog, currentCatalog: () => catalog } } })
  config.speech = { ...config.speech, enabled: true, endpoint: 'https://speech.invalid', defaultVoice: 'zf_001' }
  await client.generateVideo(who({ images: [image] }), { prompt: '微笑', script: '你好', effectsPrompt: '轻风' })
  assert.equal(calls[0][1].voice, 'zf_001')
  assert.equal(calls[0][1].script, '你好')
  assert.equal(calls[0][1].effectsEnabled, true)
  assert.equal(client.speechSettings().mode, 'text')
})

test('reset cancels an active generation and no stale image is cached', async t => {
  let started, cancelled
  const ready = new Promise(resolve => { started = resolve })
  const { client } = await fixture(t, { generationService: { image: ({ signal }) => new Promise((resolve, reject) => { started(); signal.addEventListener('abort', () => { cancelled = true; reject(signal.reason) }, { once: true }) }) } })
  const running = client.generateImage(who(), { prompt: '猫' })
  await ready; client.end(who())
  await assert.rejects(running, /取消/)
  assert.equal(cancelled, true)
  assert.equal(client.storage.maintenance('generation-image:' + client.userKey(who())), null)
})

test('generation errors and private configs never expose media credentials', async t => {
  const { client, config } = await fixture(t, { generationService: { image: async () => { throw new Error('test-private-media-token Bearer hidden-test-token') } } })
  await assert.rejects(client.generateImage(who(), { prompt: '猫' }), error => !/test-private-media-token|hidden-test-token/.test(error.message) && /已隐藏/.test(error.message))
  assert.doesNotMatch(JSON.stringify(client.storage.logs()), /test-private-media-token|hidden-test-token/)
  assert.equal(mask(config).generation.token, '••••••••')
  for (const patch of [{ defaultDuration: 8 }, { endpoint: 'https://x.invalid/?token=bad' }, { timeoutMs: 600001 }, { defaultEffects: 'yes' }]) assert.throws(() => validateConfig(merge(config, { generation: patch })))
})

test('explicit AI tool generation sends finished media without a second model request or binary video history', async t => {
  let rounds = 0
  const { client } = await fixture(t, { config: { channels: [{ id: 'test', type: 'openai', apiKey: 'test-secret', models: ['test'] }], presets: [{ ...defaults.presets[0], model: 'test', tools: ['generate_image'] }] }, client: { provider: async () => { rounds++; if (rounds > 1) throw new Error('extra model call'); return { contents: [], toolCalls: [{ id: 'media-call', name: 'generate_image', arguments: { prompt: '一只小猫' } }], usage: {} } } } })
  const sent = []
  const result = await client.chat(who({ text: '帮我画一只小猫' }), { send: output => { sent.push(output); return true } })
  assert.equal(rounds, 1)
  assert.equal(result.contents.filter(part => part.type === 'image').length, 1)
  assert.equal(sent.length, 1)
  const state = client.storage.state(client.userKey(who()))
  const history = client.storage.history(state.current.conversationId, 100, state.current.messageId)
  assert.doesNotMatch(JSON.stringify(history), new RegExp(png))
  assert.match(JSON.stringify(history), /img_/)
})

test('generation tools are hidden from unconfigured or proactive chats', async t => {
  const definitions = []
  const { client, config } = await fixture(t, { config: { channels: [{ id: 'test', type: 'openai', models: ['test'] }], presets: [{ ...defaults.presets[0], model: 'test', tools: ['generate_image', 'generate_video'] }] }, client: { provider: async request => { definitions.push(request.tools); return { contents: [{ type: 'text', text: '你好' }], toolCalls: [], usage: {} } } } })
  config.generation.enabled = false
  await client.chat(who({ text: '你好' }))
  config.generation.enabled = true
  await client.chat(who({ text: '你好', proactive: true }))
  assert.deepEqual(definitions, [[], []])
})

test('video tool uses scoped cached image, retains no binary history and does not synthesize a redundant voice reply', async t => {
  let rounds = 0, syntheses = 0
  const { client, config } = await fixture(t, { config: { channels: [{ id: 'test', type: 'openai', models: ['test'] }], presets: [{ ...defaults.presets[0], model: 'test', tools: ['generate_video'] }] }, client: { speechService: { synthesize: async () => { syntheses++; throw new Error('unexpected speech') } }, provider: async () => { rounds++; return { contents: [], toolCalls: [{ id: 'video-call', name: 'generate_video', arguments: { prompt: '小猫转头', effectsEnabled: false } }], usage: {} } } } })
  await client.generateImage(who(), { prompt: '小猫' })
  config.speech.enabled = true; config.speech.endpoint = 'https://speech.invalid'
  client.setSpeechSettings(who(), { mode: 'voice' })
  const sent = []
  await client.chat(who({ text: '让它转头做成视频' }), { send: result => { sent.push(result); return true } })
  assert.equal(rounds, 1)
  assert.equal(syntheses, 0)
  assert.equal(sent[0].contents.filter(part => part.type === 'video').length, 1)
  const state = client.storage.state(client.userKey(who()))
  const history = client.storage.history(state.current.conversationId, 100, state.current.messageId)
  assert.doesNotMatch(JSON.stringify(history), new RegExp(video.data))
  assert.match(JSON.stringify(history), /已生成并发送视频/)
})

test('a failed generation is not automatically resubmitted by later model tool rounds', async t => {
  let submissions = 0, rounds = 0
  const { client } = await fixture(t, { config: { channels: [{ id: 'test', type: 'openai', models: ['test'] }], presets: [{ ...defaults.presets[0], model: 'test', tools: ['generate_image'] }] }, generationService: { image: async () => { submissions++; throw new Error('生成服务暂时不可用') } }, client: { provider: async () => ++rounds <= 2 ? { contents: [], toolCalls: [{ id: 'try-' + rounds, name: 'generate_image', arguments: { prompt: '猫' } }], usage: {} } : { contents: [{ type: 'text', text: '暂时没生成成功，请稍后再试。' }], toolCalls: [], usage: {} } } })
  const result = await client.chat(who({ text: '画猫' }))
  assert.equal(submissions, 1)
  assert.equal(rounds, 3)
  assert.match(result.text, /没生成成功/)
})
