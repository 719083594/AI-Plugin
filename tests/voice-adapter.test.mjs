import test from 'node:test'
import assert from 'node:assert/strict'
import { handleVoiceCommand } from '../integrations/yunzai/voice-commands.mjs'

const games = [{ id: 'genshin', name: '原神' }, { id: 'honkai3', name: '崩坏3' }, { id: 'umamusume', name: '赛马娘' }, { id: 'other', name: '其他' }]
const voices = [
  { id: 0, label: '纳西妲', name: '纳西妲', game: 'genshin', language: 'zh' },
  { id: 1, label: '琪亚娜', name: '琪亚娜', game: 'honkai3', language: 'zh' },
  ...Array.from({ length: 40 }, (_, index) => ({ id: index + 2, label: '原神角色' + index, name: '原神角色' + index, game: 'genshin', language: 'zh' }))
]
function fixture() {
  const replies = [], sent = [], requests = [], states = new Map()
  const config = { basic: { enabled: true }, chat: { privateEnabled: true, groupEnabled: true }, security: { userWhitelist: [], userBlacklist: [], groupWhitelist: [], groupBlacklist: [] } }
  const input = { userId: 'a', botId: 'bot', groupId: 'g', isPrivate: false }
  const client = {
    config: () => config,
    speechSettings: () => states.get('global') || { mode: 'text', voice: '纳西妲', game: 'genshin', language: 'zh' },
    setSpeechSettings(who, patch) { const next = { ...this.speechSettings(who), ...patch }; states.set('global', next); return next },
    async speak(who, text) { requests.push({ who, text }); return { text, speechMode: 'voice', contents: [{ type: 'audio', data: 'UklGRg==' }] } }
  }
  const catalog = {
    games,
    normalizeGame(name) { return games.find(row => row.id === name || row.name === name)?.id || null },
    resolveVoice(name, { game } = {}) { return voices.find(row => row.label === name && (!game || row.game === game)) || null },
    listVoices({ game, search, page = 1, pageSize = 30 } = {}) {
      const rows = voices.filter(row => (!game || row.game === game) && (!search || row.name.includes(search)))
      return { voices: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length, page, pageSize, pages: Math.ceil(rows.length / pageSize), games }
    }
  }
  const run = (text, who = input) => handleVoiceCommand({ client, input: who, text, catalog, reply: message => replies.push(message), send: result => sent.push(result) })
  return { run, client, config, input, replies, sent, requests, states }
}

test('all users share voice preferences and can switch the global mode and voice; text remains default', async () => {
  const f = fixture()
  assert.equal(f.client.speechSettings(f.input).mode, 'text')
  assert.equal(await f.run('语音模式'), true)
  assert.equal(f.client.speechSettings(f.input).mode, 'voice')
  assert.equal(f.client.speechSettings({ ...f.input, userId: 'b' }).mode, 'voice')
  assert.equal(f.client.speechSettings({ ...f.input, botId: 'other' }).mode, 'voice')
  assert.match(f.replies.at(-1), /全局|所有人共用/)
  await f.run('语音琪亚娜', { ...f.input, userId: 'b' })
  assert.equal(f.client.speechSettings(f.input).voice, '琪亚娜')
  await f.run('语音游戏 原神', { ...f.input, userId: 'b' })
  assert.equal(f.client.speechSettings(f.input).game, 'genshin')
  await f.run('文字模式', { ...f.input, userId: 'b' })
  assert.equal(f.client.speechSettings(f.input).mode, 'text')
  assert.match(f.replies.at(-1), /全局文字模式/)
  assert.equal(f.requests.length, 0)
  assert.equal(await f.run('预设列表'), false)
  await f.run('语音帮助')
  assert.match(f.replies.at(-1), /所有人共用/)
  assert.doesNotMatch(f.replies.at(-1), /自己|本人|个人/)
})

test('manual text to speech never changes mode or calls a language model', async () => {
  const f = fixture()
  await f.run('文字转语音 你好，今天吃什么。')
  assert.equal(f.requests[0].text, '你好，今天吃什么。')
  assert.equal(f.sent[0].contents[0].type, 'audio')
  assert.equal(f.client.speechSettings(f.input).mode, 'text')
  await f.run('转语音')
  assert.equal(f.requests.length, 1)
  assert.match(f.replies.at(-1), /用法/)
})

test('voice commands obey access lists, enabled state and group/private switches', async () => {
  const cases = [
    f => f.config.security.userBlacklist.push('a'),
    f => f.config.security.groupBlacklist.push('g'),
    f => f.config.security.userWhitelist.push('somebody'),
    f => f.config.chat.groupEnabled = false,
    f => f.config.basic.enabled = false
  ]
  for (const deny of cases) {
    const f = fixture(); deny(f)
    await assert.rejects(f.run('转语音 不允许发送'), /权限|关闭|停用/)
    assert.equal(f.requests.length, 0)
    assert.equal(f.states.size, 0)
  }
  const f = fixture(); f.config.chat.privateEnabled = false
  await assert.rejects(f.run('语音模式', { ...f.input, isPrivate: true, groupId: '' }), /私聊已关闭/)
})

test('voice catalog is grouped and paginated; voice selection accepts no-space form and another game', async () => {
  const f = fixture()
  await f.run('音色列表')
  assert.match(f.replies.at(-1), /原神：41/)
  assert.doesNotMatch(f.replies.at(-1), /原神角色39/)
  await f.run('音色列表 原神 2')
  assert.match(f.replies.at(-1), /第 2\/2 页/)
  assert.match(f.replies.at(-1), /原神角色39/)
  assert.doesNotMatch(f.replies.at(-1), /原神角色0\n/)
  await f.run('语音琪亚娜')
  assert.equal(f.client.speechSettings(f.input).voice, '琪亚娜')
  assert.equal(f.client.speechSettings(f.input).game, 'honkai3')
  assert.equal(f.client.speechSettings(f.input).mode, 'voice')
  await f.run('语音游戏 原神')
  assert.equal(f.client.speechSettings(f.input).game, 'genshin')
  assert.equal(f.client.speechSettings(f.input).voice, '琪亚娜')
  await f.run('音色 原神角色')
  assert.match(f.replies.at(-1), /完整音色名/)
  assert.equal(f.client.speechSettings(f.input).voice, '琪亚娜')
})

let adapter
async function sendResult() {
  if (!adapter) {
    const prior = globalThis.plugin
    try { globalThis.plugin = class {}; adapter = await import('../integrations/yunzai/index.js') }
    finally { if (prior === undefined) delete globalThis.plugin; else globalThis.plugin = prior }
  }
  return adapter.sendResult
}
test('QQ voice sends use standalone unquoted records and retain images and sources separately', async () => {
  const send = await sendResult(), deliveries = []
  const prior = globalThis.segment
  try {
    globalThis.segment = { record: file => ({ type: 'record', file }), image: file => ({ type: 'image', file }) }
    await send({ isGroup: true, reply: async (parts, quote) => { deliveries.push({ parts, quote }); return { message_id: 1 } } }, {
      text: '这是正文', speechMode: 'voice', contents: [{ type: 'text', text: '这是正文' }, { type: 'audio', data: 'UklGRg==' }, { type: 'image', url: 'https://example.test/a.png' }], sources: [{ title: '资料', url: 'https://example.test/page' }]
    })
  } finally { if (prior === undefined) delete globalThis.segment; else globalThis.segment = prior }
  assert.deepEqual(deliveries[0], { parts: [{ type: 'record', file: 'base64://UklGRg==' }], quote: false })
  assert.equal(deliveries[1].parts.some(row => row.type === 'image'), true)
  assert.equal(deliveries[1].parts.includes('这是正文'), false)
  assert.match(deliveries[1].parts.filter(row => typeof row === 'string').join('\n'), /https:\/\/example.test\/page/)
})

test('QQ rejected or thrown audio sends fall back to original text with a successful receipt', async () => {
  const send = await sendResult()
  for (const failure of [false, { retcode: 1200 }, { status: 'failed' }, { delivered: false }, new Error('internal/upstream/private.wav')]) {
    const deliveries = []
    const receipt = await send({ reply: async parts => { deliveries.push(parts); if (deliveries.length === 1) { if (failure instanceof Error) throw failure; return failure } return { message_id: 2 } } }, {
      text: '保留回答', speechMode: 'voice', contents: [{ type: 'text', text: '保留回答' }, { type: 'audio', data: 'UklGRg==' }]
    })
    assert.equal(receipt.message_id, 2)
    assert.deepEqual(deliveries[1], ['保留回答', '语音发送失败，已改为文字。'])
    assert.doesNotMatch(JSON.stringify(deliveries[1]), /base64|upstream|private.wav/)
  }
})

test('a delivered voice remains successful when a supplemental image or source cannot be sent', async () => {
  const send = await sendResult()
  for (const supplemental of [false, new Error('transport details')]) {
    let calls = 0
    const receipt = await send({ reply: async () => {
      if (++calls === 1) return { message_id: 4 }
      if (supplemental instanceof Error) throw supplemental
      return supplemental
    } }, { text: '已经听到的回答', speechMode: 'voice', contents: [{ type: 'audio', data: 'UklGRg==' }], sources: [{ title: '来源', url: 'https://example.test/page' }] })
    assert.equal(receipt.message_id, 4)
    assert.equal(calls, 2)
  }
})

test('a synthesis failure sends safe text and the default text result needs no audio', async () => {
  const send = await sendResult(), deliveries = []
  const e = { reply: async parts => { deliveries.push(parts); return true } }
  await send(e, { text: '答案', speechMode: 'voice', speechError: 'hidden upstream details', contents: [{ type: 'text', text: '答案' }] })
  assert.deepEqual(deliveries[0], ['答案', '语音合成暂不可用，已改为文字。'])
  await send(e, { text: '普通答案', contents: [{ type: 'text', text: '普通答案' }] })
  assert.deepEqual(deliveries[1], ['普通答案'])
})

test('a record segment construction error also falls back without leaking adapter internals', async () => {
  const send = await sendResult(), deliveries = [], prior = globalThis.segment
  try {
    globalThis.segment = { record: () => { throw new Error('private/transport/path') } }
    const receipt = await send({ reply: async parts => { deliveries.push(parts); return { message_id: 3 } } }, { text: '还能看到的文字', speechMode: 'voice', contents: [{ type: 'audio', data: 'UklGRg==' }] })
    assert.equal(receipt.message_id, 3)
    assert.deepEqual(deliveries, [['还能看到的文字', '语音发送失败，已改为文字。']])
  } finally { if (prior === undefined) delete globalThis.segment; else globalThis.segment = prior }
})
