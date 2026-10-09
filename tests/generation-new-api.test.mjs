import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { GenerationService } from '../src/generation/service.mjs'
import { generationModels, newApiTarget, newApiDefaults } from '../src/generation/new-api.mjs'
import { defaults, merge, validateConfig } from '../src/core/config.mjs'
import { AIClient } from '../src/core/client.mjs'
import { Storage } from '../src/core/storage.mjs'
import { parseMediaCommand, handleMediaCommand } from '../integrations/yunzai/media-commands.mjs'
import { createStaticHelpReader } from '../src/rendering/index.mjs'

const imageModel = 'gemini-tested-image', videoModel = 'veo-tested-video'
const channel = { id: 'local-new-api', type: 'openai', baseUrl: 'http://new-api:3000/v1', apiKey: 'fixture-new-api-token', enabled: true }
const settings = { enabled: true, endpoint: 'https://hf.example', token: 'fixture-hf-token', timeoutMs: 2000, newApi: { ...newApiDefaults, enabled: true, channelId: channel.id, imageModels: [imageModel], videoModels: [videoModel], pollIntervalMs: 250 } }
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aS2kAAAAASUVORK5CYII=', 'base64')
const image = { data: png.toString('base64'), mime: 'image/png' }
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } })
const imageResponse = () => ({ candidates: [{ finishReason: 'STOP', content: { parts: [{ text: '生成完成' }, { inlineData: { mimeType: 'image/png', data: image.data } }] } }] })
function box(kind, payload) { const bytes = Buffer.alloc(payload.length + 8); bytes.writeUInt32BE(bytes.length); bytes.write(kind, 4); payload.copy(bytes, 8); return bytes }
const mp4 = Buffer.concat([box('ftyp', Buffer.from('isom\x00\x00\x02\x00isomiso2')), box('moov', box('trak', Buffer.from('fixture'))), box('mdat', Buffer.from([0, 0, 0, 1, 0x65, 1, 2, 3]))])
function fixture(handler, overrides = {}) {
  const calls = []
  const service = new GenerationService({ config: () => ({ ...settings, ...overrides }), channels: () => [channel], fetchImpl: async (url, options) => {
    calls.push({ url: String(url), options })
    const custom = await handler?.(url, options, calls)
    if (custom) return custom
    if (url.pathname.startsWith('/v1beta/models/')) return json(imageResponse())
    if (url.pathname === '/v1/videos') return json({ id: 'task-1', status: 'queued', url: 'https://untrusted.example/video.mp4' })
    if (url.pathname === '/v1/videos/task-1') return json({ id: 'task-1', status: 'completed', url: 'https://untrusted.example/video.mp4' })
    if (url.pathname === '/v1/videos/task-1/content') return new Response(mp4, { headers: { 'content-type': 'video/mp4' } })
    throw new Error('unexpected endpoint')
  } })
  return { calls, service }
}

test('New API generation is opt-in, keeps HF defaults and accepts only existing authenticated channels', () => {
  assert.equal(defaults.generation.newApi.enabled, false)
  assert.deepEqual(generationModels({ ...settings, newApi: { ...settings.newApi, enabled: false } }, [channel]), { image: ['flux', 'anima'], video: ['hf-story'] })
  assert.deepEqual(generationModels(settings, [channel]), { image: ['flux', 'anima', imageModel], video: ['hf-story', videoModel] })
  for (const baseUrl of ['http://new-api:3000', 'http://new-api:3000/v1/', 'http://192.168.1.2:3000/v1', 'https://newapi.example/v1']) assert.equal(newApiTarget(settings, [{ ...channel, baseUrl }]).base.pathname, '/')
  for (const baseUrl of ['http://public.example/v1', 'http://192.168.attacker.example/v1', 'https://x:y@newapi.example/v1', 'https://newapi.example/v1?secret=x', 'https://newapi.example/admin', 'https://newapi.example/v1#x']) assert.throws(() => newApiTarget(settings, [{ ...channel, baseUrl }]))
  for (const channels of [[], [{ ...channel, enabled: false }], [{ ...channel, type: 'gemini' }], [{ ...channel, apiKey: '' }]]) {
    assert.throws(() => newApiTarget(settings, channels))
    assert.deepEqual(generationModels({ ...settings, endpoint: '' }, channels), { image: [], video: [] })
  }
  const config = merge(defaults, { channels: [channel], generation: settings })
  assert.equal(validateConfig(config), config)
  for (const patch of [{ imageModels: ['../bad'] }, { videoModels: ['https://evil.example'] }, { imageModels: [imageModel, imageModel] }, { imageModels: ['flux'] }, { pollIntervalMs: 0 }, { channelId: 'missing' }]) assert.throws(() => validateConfig(merge(config, { generation: { newApi: patch } })))
})

test('Gemini images use native New API routes and validated inline bytes with only the existing token', async () => {
  const f = fixture()
  const output = await f.service.image({ model: imageModel, prompt: '一只橘猫', reference: image })
  assert.deepEqual(Buffer.from(output.data, 'base64'), png)
  assert.equal(output.model, imageModel)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(f.calls.length, 1)
  const call = f.calls[0]
  assert.equal(call.url, 'http://new-api:3000/v1beta/models/gemini-tested-image:generateContent')
  assert.equal(call.options.headers.Authorization, 'Bearer fixture-new-api-token')
  assert.equal(call.options.redirect, 'manual')
  assert.deepEqual(JSON.parse(call.options.body), { contents: [{ role: 'user', parts: [{ text: '一只橘猫' }, { inlineData: { mimeType: 'image/png', data: image.data } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } })
  assert.doesNotMatch(JSON.stringify(output), /fixture-|https?:|Bearer/)
})

test('unlisted models and unsupported options fail before network access or spending generation quota', async () => {
  const f = fixture()
  for (const options of [{ model: 'unknown', prompt: '猫' }, { model: imageModel, prompt: '猫', seed: 1 }, { model: imageModel, prompt: '猫', width: 1024 }]) await assert.rejects(f.service.image(options), error => error.code.startsWith('GENERATION_'))
  for (const options of [{ image }, { script: '你好' }, { effectsPrompt: '风声' }, { effectsEnabled: true }, { subtitles: true }, { duration: 3 }]) await assert.rejects(f.service.video({ model: videoModel, prompt: '小猫转头', ...options }), { code: 'GENERATION_INPUT' })
  assert.equal(f.calls.length, 0)
  const disabled = fixture(null, { newApi: { ...settings.newApi, enabled: false } })
  await assert.rejects(disabled.service.image({ model: imageModel, prompt: '猫' }), { code: 'GENERATION_INPUT' })
  assert.equal(disabled.calls.length, 0)
})

test('image safety, malformed base64, MIME spoofing, no image and excessive output are safe failures', async () => {
  for (const [body, code] of [
    [{ promptFeedback: { blockReason: 'SAFETY' } }, 'GENERATION_BLOCKED'],
    [{ candidates: [{ finishReason: 'IMAGE_SAFETY' }] }, 'GENERATION_BLOCKED'],
    [{ candidates: [{ content: { parts: [{ text: 'text only' }] } }] }, 'GENERATION_PROTOCOL'],
    [{ candidates: [{ content: { parts: [{ inlineData: { data: '!!!!', mimeType: 'image/png' } }] } }] }, 'GENERATION_IMAGE_INVALID'],
    [{ candidates: [{ content: { parts: [{ inlineData: { data: image.data, mimeType: 'image/jpeg' } }] } }] }, 'GENERATION_IMAGE_INVALID']
  ]) {
    const f = fixture(() => json(body))
    await assert.rejects(f.service.image({ model: imageModel, prompt: '猫' }), { code })
    assert.equal(f.calls.length, 1)
  }
  const excessive = fixture(() => new Response('{}', { headers: { 'content-length': String(15 * 1024 * 1024) } }))
  await assert.rejects(excessive.service.image({ model: imageModel, prompt: '猫' }), { code: 'GENERATION_PROTOCOL' })
})

test('Veo submits exactly one task, polls its ID and downloads only same-origin authenticated content', async () => {
  const f = fixture()
  const result = await f.service.video({ model: videoModel, prompt: '橘猫缓慢转头' })
  assert.equal(result.durationSeconds, 4)
  assert.equal(result.mimeType, 'video/mp4')
  assert.deepEqual(Buffer.from(result.data, 'base64'), mp4)
  assert.deepEqual(f.calls.map(call => new URL(call.url).pathname), ['/v1/videos', '/v1/videos/task-1', '/v1/videos/task-1/content'])
  assert.deepEqual(JSON.parse(f.calls[0].options.body), { model: videoModel, prompt: '橘猫缓慢转头', duration: 4, size: '1280x720', metadata: { durationSeconds: 4, resolution: '720p', aspectRatio: '16:9' } })
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  assert.ok(f.calls.every(call => call.options.headers.Authorization === 'Bearer fixture-new-api-token' && new URL(call.url).origin === 'http://new-api:3000'))
  assert.doesNotMatch(JSON.stringify(result), /untrusted|fixture-|https?:/)
})

test('failed, mismatched, malformed and unrecognized video jobs never resubmit or fall back to HF', async () => {
  for (const task of [{ id: '../unsafe', status: 'queued' }, { id: 'task-1', status: 'failed', error: 'fixture-new-api-token' }, { id: 'task-1', status: 'unknown' }]) {
    const f = fixture(() => json(task))
    await assert.rejects(f.service.video({ model: videoModel, prompt: '猫' }), error => !/fixture-/.test(error.message))
    assert.equal(f.calls.length, 1)
  }
  const mismatch = fixture(url => url.pathname === '/v1/videos/task-1' ? json({ id: 'task-2', status: 'completed' }) : null)
  await assert.rejects(mismatch.service.video({ model: videoModel, prompt: '猫' }), { code: 'GENERATION_PROTOCOL' })
  assert.equal(mismatch.calls.filter(call => call.options.method === 'POST').length, 1)
})

test('redirects never receive New API credentials and video content is bounded and validated', async () => {
  for (const location of ['https://untrusted.example/video.mp4', 'http://new-api:3000/admin']) {
    const f = fixture(() => new Response(null, { status: 302, headers: { location } }))
    await assert.rejects(f.service.image({ model: imageModel, prompt: '猫' }), { code: 'GENERATION_PROTOCOL' })
    assert.equal(f.calls.length, 1)
  }
  for (const response of [
    () => new Response('html', { headers: { 'content-type': 'text/html' } }),
    () => new Response('truncated', { headers: { 'content-type': 'video/mp4' } }),
    () => new Response(mp4, { headers: { 'content-type': 'video/mp4', 'content-length': '99999999' } }),
    () => new Response(null, { status: 307, headers: { location: 'https://cdn.example/private.mp4' } })
  ]) {
    const f = fixture(url => url.pathname.endsWith('/content') ? response() : null)
    await assert.rejects(f.service.video({ model: videoModel, prompt: '猫' }), error => error.code.startsWith('GENERATION_'))
    assert.equal(f.calls.length, 3)
  }
})

test('local cancellation stops polling with no repeat submission and releases the shared queue', async () => {
  let submitted
  const ready = new Promise(resolve => { submitted = resolve })
  const f = fixture(url => {
    if (url.pathname === '/v1/videos') { submitted(); return json({ id: 'task-1', status: 'queued' }) }
    return null
  })
  const controller = new AbortController(), running = f.service.video({ model: videoModel, prompt: '猫', signal: controller.signal })
  await ready; controller.abort()
  await assert.rejects(running, { code: 'GENERATION_ABORTED' })
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1)
  assert.equal(f.service.active, false)
  const timed = fixture(() => new Promise(() => {}), { timeoutMs: 20 })
  await assert.rejects(timed.service.image({ model: imageModel, prompt: '猫' }), { code: 'GENERATION_TIMEOUT' })
  assert.equal(timed.calls.length, 1)
})

test('AI core allows New API text video without reusing a cached image, retaining access and explicit option checks', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-newapi-test-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  const config = merge(defaults, { channels: [channel], generation: settings, management: { enabled: false } })
  const calls = []
  const client = new AIClient({ root, config: () => config, storage: new Storage(), generationService: { async image() { return { ...image, type: 'image' } }, async video(args) { calls.push(args); return { type: 'video', data: mp4.toString('base64'), mimeType: 'video/mp4' } } } })
  t.after(() => client.close())
  const input = { userId: 'user', groupId: 'group', botId: 'bot', isPrivate: false, images: [] }
  await client.generateImage(input, { prompt: '猫' })
  await client.generateVideo(input, { model: videoModel, prompt: '猫转头' })
  assert.equal(calls[0].image, undefined)
  assert.equal(calls[0].duration, 4)
  assert.equal(calls[0].effectsEnabled, false)
  assert.equal(calls[0].subtitles, false)
  await assert.rejects(client.generateVideo({ ...input, images: [image] }, { model: videoModel, prompt: '猫' }), /只开放文生视频/)
  config.security.userBlacklist = ['user']
  await assert.rejects(client.generateVideo(input, { model: videoModel, prompt: '猫' }), /权限/)
  assert.equal(calls.length, 1)
})

test('media model commands preserve ordinary prompt pipes, label options and never reveal channel secrets', async () => {
  assert.deepEqual(parseMediaCommand('画图 小猫 | 在窗边 | 模型：' + imageModel), { kind: 'image', options: { prompt: '小猫 | 在窗边', model: imageModel } })
  assert.deepEqual(parseMediaCommand('视频 缓慢转头 | 模型：' + videoModel + ' | 时长：4秒'), { kind: 'video', options: { prompt: '缓慢转头', model: videoModel, duration: 4 } })
  for (const command of ['画图 猫 | 模型：https://evil.example', '视频 猫 | 模型：a | 模型：b']) assert.throws(() => parseMediaCommand(command))
  const replies = []
  await handleMediaCommand({ client: { generationModels: () => generationModels(settings, [channel]) }, text: '媒体模型', reply: message => replies.push(message) })
  assert.match(replies[0], new RegExp(imageModel))
  assert.match(replies[0], new RegExp(videoModel))
  assert.doesNotMatch(replies[0], /fixture-|http:|3000|local-new-api/)
})

test('published static help matches its updated source and includes the model-selection commands', async () => {
  const root = new URL('../', import.meta.url)
  const { fileURLToPath } = await import('node:url')
  const read = createStaticHelpReader({ root: fileURLToPath(root), defaultPrefix: '#AI' })
  assert.equal(read({ topic: 'ai-public', private: false, prefix: '#AI' })?.length, 1)
  const manifest = JSON.parse(await fs.readFile(new URL('orangejuice.plugin.json', root), 'utf8'))
  for (const command of ['#AI媒体模型', '#AI画图 描述 | 模型：模型编号', '#AI视频 描述 | 模型：模型编号']) assert.ok(manifest.commandTable.some(row => row.command.includes(command) && row.permission === 'all'))
})
