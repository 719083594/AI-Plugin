import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { parseMediaCommand, handleMediaCommand, MEDIA_HELP } from '../integrations/yunzai/media-commands.mjs'
import { helpTopics } from '../src/rendering/help-content.mjs'

function fixture() {
  const replies = [], sent = [], requests = []
  const config = { basic: { enabled: true }, chat: { privateEnabled: true, groupEnabled: true }, security: { userWhitelist: [], userBlacklist: [], groupWhitelist: [], groupBlacklist: [] } }
  const input = { userId: 'a', botId: 'bot', groupId: 'g', isPrivate: false, images: [] }
  const client = {
    config: () => config,
    generationConfigured: () => true,
    async generateImage(who, options) { requests.push({ kind: 'image', who, options }); return { contents: [{ type: 'image', data: 'SYNTHETIC' }] } },
    async generateVideo(who, options) { requests.push({ kind: 'video', who, options }); return { contents: [{ type: 'video', data: 'SYNTHETIC' }] } }
  }
  const run = (text, who = input) => handleMediaCommand({ client, input: who, text, reply: value => replies.push(value), send: result => sent.push(result) })
  return { run, client, config, input, replies, sent, requests }
}

test('media commands parse model choice and labelled video options without erasing ordinary pipes', () => {
  assert.deepEqual(parseMediaCommand('画图 森林 | 远处小屋'), { kind: 'image', options: { prompt: '森林 | 远处小屋', model: 'flux' } })
  assert.equal(parseMediaCommand('二次元 少女').options.model, 'anima')
  assert.deepEqual(parseMediaCommand('视频 小猫转头 | 留在画面里 | 配音：你好 | 音效: 森林鸟鸣 | 时长：5秒 | 字幕：关闭'), { kind: 'video', options: { prompt: '小猫转头 | 留在画面里', script: '你好', effectsEnabled: true, effectsPrompt: '森林鸟鸣', duration: 5, subtitles: false } })
  assert.deepEqual(parseMediaCommand('视频 转头 | 音效：关闭'), { kind: 'video', options: { prompt: '转头', effectsEnabled: false, effectsPrompt: '' } })
  for (const text of ['视频 转头 | 时长：30秒', '视频 转头 | 字幕：随便', '视频 转头 | 配音：a | 配音：b']) assert.throws(() => parseMediaCommand(text), /时长|字幕|重复/)
  for (const text of ['转语音 文字', '音效 鸟鸣', '声音 鸟鸣', '预设列表']) assert.equal(parseMediaCommand(text), null)
})

test('media commands delegate validated pictures and options to core without changing voice preferences', async () => {
  const f = fixture(), image = { type: 'image', data: 'SYNTHETIC' }
  f.input.images.push(image)
  await f.run('画图 雨后的森林')
  await f.run('二次元 少女')
  await f.run('视频 小猫转头 | 配音：你好 | 音效：关闭 | 时长：3秒')
  assert.equal(f.requests.length, 3)
  assert.equal(f.requests[0].who, f.input)
  assert.deepEqual(f.requests[0].options, { prompt: '雨后的森林', model: 'flux' })
  assert.equal(f.requests[1].options.model, 'anima')
  assert.deepEqual(f.requests[2].options, { prompt: '小猫转头', script: '你好', effectsEnabled: false, effectsPrompt: '', duration: 3 })
  assert.equal(f.requests[2].who.images[0], image)
  assert.equal(f.sent.at(-1).contents[0].type, 'video')
  assert.equal(await f.run('音效 鸟鸣'), false)
})

test('core resolves scoped cached images for video; empty prompts do not consume generation', async () => {
  const f = fixture()
  await f.run('视频 小猫转头')
  assert.equal(f.requests.at(-1).kind, 'video')
  assert.equal(f.requests.at(-1).who.images.length, 0)
  await f.run('视频')
  await f.run('画图')
  assert.equal(f.requests.length, 1)
  f.input.images.push({ type: 'image', url: 'https://example.test/synthetic.png' })
  f.client.generationConfigured = () => false
  await assert.rejects(f.run('视频 小猫转头'), /尚未配置/)
  assert.equal(f.requests.length, 1)
  f.client.generationConfigured = () => true
  f.client.generateVideo = async () => { throw new Error('生成视频需要一张图片，请附图、引用图片，或先生成图片。') }
  await assert.rejects(f.run('视频 小猫转头'), /需要一张图片/)
})

test('generation follows existing AI access lists and chat switches while media help is public', async () => {
  for (const deny of [f => f.config.basic.enabled = false, f => f.config.security.userBlacklist.push('a'), f => f.config.security.groupBlacklist.push('g'), f => f.config.security.userWhitelist.push('other'), f => f.config.chat.groupEnabled = false]) {
    const f = fixture(); deny(f)
    await assert.rejects(f.run('画图 森林'), /停用|权限|关闭/)
    assert.equal(f.requests.length, 0)
  }
  const f = fixture(); f.config.chat.privateEnabled = false
  await assert.rejects(f.run('画图 森林', { ...f.input, isPrivate: true, groupId: '' }), /私聊已关闭/)
  f.config.security.userBlacklist.push('a')
  assert.equal(await f.run('媒体帮助'), true)
  assert.equal(f.replies.at(-1), MEDIA_HELP)
  assert.equal(f.requests.length, 0)
})

let adapter
async function getAdapter() {
  if (!adapter) {
    const prior = globalThis.plugin
    try { globalThis.plugin = class {}; adapter = await import('../integrations/yunzai/index.js') }
    finally { if (prior === undefined) delete globalThis.plugin; else globalThis.plugin = prior }
  }
  return adapter
}

test('reply image enrichment preserves command text and tolerates unavailable references', async () => {
  const { normalizeEvent, enrichReferences } = await getAdapter()
  const e = { msg: '#AI视频 小猫转头', message: [], reply_id: 1, async getReply() { return { message: [{ type: 'text', text: '#AI画图 原来的提示词' }, { type: 'image', data: { file: 'base64://SYNTHETIC' } }] } } }
  const input = normalizeEvent(e)
  await enrichReferences(e, input, { includeText: false })
  assert.equal(input.text, '#AI视频 小猫转头')
  assert.deepEqual(input.images, [{ type: 'image', data: 'SYNTHETIC' }])
  await enrichReferences({ reply_id: 2, getReply: async () => { throw new Error('unavailable') } }, input, { includeText: false })
  assert.equal(input.images.length, 1)
})

test('QQ video sends are standalone and unquoted, with supplementary images or text sent separately', async () => {
  const { sendResult } = await getAdapter(), deliveries = [], prior = globalThis.segment
  try {
    globalThis.segment = { video: file => ({ type: 'video', file }), image: file => ({ type: 'image', file }) }
    const receipt = await sendResult({ isGroup: true, reply: async (parts, quote) => { deliveries.push({ parts, quote }); return { message_id: deliveries.length } } }, {
      contents: [{ type: 'text', text: '已生成' }, { type: 'image', data: 'SYNTHETIC_IMAGE' }, { type: 'video', data: 'SYNTHETIC_VIDEO', mime: 'video/mp4' }]
    })
    assert.deepEqual(deliveries[0], { parts: [{ type: 'video', file: 'base64://SYNTHETIC_VIDEO' }], quote: false })
    assert.equal(deliveries[1].quote, true)
    assert.equal(deliveries[1].parts[0], '已生成')
    assert.equal(deliveries[1].parts[1].type, 'image')
    assert.equal(receipt.message_id, 1)
  } finally { if (prior === undefined) delete globalThis.segment; else globalThis.segment = prior }
})

test('QQ video rejection, transport throw and segment error report safe failure without claiming delivery', async () => {
  const { sendResult } = await getAdapter(), prior = globalThis.segment
  try {
    for (const failure of [false, { retcode: 1200 }, { error: 'private route' }, new Error('private/upstream/path'), 'segment-error']) {
      const deliveries = []
      globalThis.segment = { video: file => { if (failure === 'segment-error') throw new Error('private segment'); return { type: 'video', file } } }
      const receipt = await sendResult({ isGroup: true, reply: async (parts, quote) => {
        deliveries.push({ parts, quote })
        if (deliveries.length === 1 && failure !== 'segment-error') { if (failure instanceof Error) throw failure; return failure }
        return { message_id: 2 }
      } }, { contents: [{ type: 'video', data: 'SYNTHETIC_VIDEO' }] })
      assert.equal(receipt, false)
      assert.deepEqual(deliveries.at(-1).parts, ['视频已生成，但 QQ 发送失败，请稍后重试。'])
      assert.doesNotMatch(JSON.stringify(deliveries.at(-1).parts), /base64|private|upstream/)
    }
  } finally { if (prior === undefined) delete globalThis.segment; else globalThis.segment = prior }
})

test('generated video remains delivered if supplementary text fails', async () => {
  const { sendResult } = await getAdapter()
  let calls = 0
  const receipt = await sendResult({ reply: async () => ++calls === 1 ? { message_id: 7 } : false }, { contents: [{ type: 'video', data: 'SYNTHETIC_VIDEO' }, { type: 'text', text: '说明' }] })
  assert.equal(receipt.message_id, 7)
  assert.equal(calls, 2)
})

test('media commands are registered in public help and the automatic command knowledge source', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../orangejuice.plugin.json', import.meta.url), 'utf8'))
  const help = JSON.stringify(helpTopics['ai-public'])
  for (const command of ['#AI画图', '#AI二次元', '#AI视频', '#AI媒体帮助', '#AI媒体模型']) {
    assert.ok(manifest.commandTable.some(row => row.command.includes(command) && row.permission === 'all'))
    assert.ok(manifest.commands.some(row => row.includes(command)))
    assert.ok(help.includes(command))
  }
  assert.doesNotMatch(JSON.stringify(manifest.commandTable), /#AI音效/)
})
