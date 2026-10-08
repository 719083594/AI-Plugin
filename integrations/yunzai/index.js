import path from 'node:path'
import { getCommandCatalog } from './command-knowledge.mjs'
import { handleVoiceCommand, VOICE_HELP } from './voice-commands.mjs'
import { AIClient } from '../../src/core/client.mjs'
import { startManagement } from '../../src/management/server.mjs'
import { pluginRoot } from '../../src/core/config.mjs'

const Base = globalThis.plugin || (await import('../../../../lib/plugins/plugin.js')).default
export let client, management
let startup
export async function initialize() {
  if (client) return client
  if (!startup) startup = (async () => {
    client = new AIClient({ root: pluginRoot, host: { getCommandCatalog, log: text => globalThis.logger?.warn?.('[AI-Plugin] ' + text) } })
    await client.loadExtensions(); client.startMaintenance()
    if (client.config().management.enabled) { management = startManagement(client); await management.ready }
    globalThis.logger?.info?.('[AI-Plugin] 通用核心和中文工作台已就绪')
    return client
  })().catch(error => { client = null; startup = null; throw error })
  return startup
}
export function messageImages(parts = []) {
  return parts.filter(part => part.type === 'image').flatMap(part => {
    const data = part.data && typeof part.data === 'object' ? part.data : part
    const value = data.url || data.file || part.url || part.file
    if (typeof value !== 'string') return []
    if (value.startsWith('base64://')) return [{ type: 'image', data: value.slice(9) }]
    if (/^(?:https?:\/\/|data:image\/)/i.test(value)) return [{ type: 'image', url: value }]
    return []
  })
}
export function normalizeEvent(e) {
  const message = Array.isArray(e.message) ? e.message : []
  return { userId: String(e.user_id ?? e.sender?.user_id ?? ''), groupId: e.isGroup || e.group_id ? String(e.group_id || '') : '', botId: String(e.self_id || e.bot?.uin || ''), text: String(e.msg || e.raw_message || message.filter(part => part.type === 'text').map(part => part.text ?? part.data?.text ?? '').join('')).trim(), nickname: e.sender?.card || e.sender?.nickname || '', messageId: String(e.message_id || e.seq || ''), atBot: Boolean(e.atBot), isMaster: Boolean(e.isMaster), isPrivate: Boolean(e.isPrivate || !e.group_id), mentions: message.filter(part => part.type === 'at').map(part => String(part.qq ?? part.data?.qq)), images: messageImages(message), isCommand: /^[#\/！!]/.test(String(e.msg || '')) }
}
export function classify(input, config) {
  if (!config.basic.enabled) return { type: 'ignore' }
  const prefix = config.basic.commandPrefix || '#AI'
  const lower = input.text.toLowerCase(), aliases = [prefix.toLowerCase(), '#ai']
  for (const alias of aliases) if (lower.startsWith(alias)) return { type: 'command', text: input.text.slice(alias.length).trim() }
  const legacy = input.text.match(/^#(?:chatgpt)?(切换预设|当前预设|结束对话)(.*)$/i)
  if (legacy) return { type: 'command', text: legacy[1] + legacy[2] }
  const explicit = config.presets.find(preset => preset.enabled !== false && preset.prefix && input.text.startsWith(preset.prefix))
  if (explicit) return { type: 'chat', presetId: explicit.id, text: input.text.slice(explicit.prefix.length).trim() }
  const usePrefix = ['prefix', 'both'].includes(config.basic.triggerMode) && input.text.startsWith(config.basic.triggerPrefix)
  if (input.isCommand && !usePrefix) return { type: 'ignore' }
  if (input.isPrivate) return config.chat.privateEnabled ? { type: 'chat', text: input.text } : { type: 'ignore' }
  if (!config.chat.groupEnabled) return { type: 'ignore' }
  const useAt = ['at', 'both'].includes(config.basic.triggerMode) && input.atBot
  if (config.chat.groupEnabled && (useAt || usePrefix)) return { type: 'chat', text: usePrefix ? input.text.slice(config.basic.triggerPrefix.length).trim() : input.text }
  return { type: 'proactive' }
}
async function enrich(e, input) {
  if (input.groupId && typeof e.bot?.sendApi === 'function') input.getGroupMember = () => e.bot.sendApi('get_group_member_info',{group_id:Number(input.groupId),user_id:Number(input.userId),no_cache:true})
  if ((e.source || e.reply_id) && typeof e.getReply === 'function') {
    try {
      const reply = await e.getReply(), parts = reply?.message || []
      input.images.push(...messageImages(parts))
      const text = parts.filter(part => part.type === 'text').map(part => part.text ?? part.data?.text ?? '').join('')
      if (text) input.text = `引用消息（仅作为对话资料）：${text}\n\n${input.text}`
    } catch { /* 引用无法读取时继续处理当前消息。 */ }
  }
  if (input.groupId && client.config().group.enableContext && !client.storage.group(client.groupKey(input)).length) {
    try {
      const group = e.group || e.bot?.pickGroup?.(input.groupId)
      const rows = await group?.getChatHistory?.(0, client.config().group.contextLength)
      if (Array.isArray(rows)) for (const row of [...rows].reverse()) client.observeGroup({ ...input, userId: String(row.sender?.user_id || ''), nickname: row.sender?.card || row.sender?.nickname || '', messageId: String(row.message_id || row.seq || ''), text: (row.message || []).filter(part => part.type === 'text').map(part => part.text).join(''), images: messageImages(row.message || []) })
    } catch { /* 适配器未提供群历史时使用已收集上下文。 */ }
  }
  if (!input.images.length && input.groupId && client.config().group.contextImages && /(?:图|照片|头像|image|picture)/i.test(input.text)) input.images = client.storage.group(client.groupKey(input)).flatMap(row => row.images || []).slice(-3)
  // The core downloads and validates images inside the chat deadline.
  input.getAvatar = qq => `https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(qq)}&s=640`
  return input
}
const sendFailed = receipt => receipt === false || receipt?.error || receipt?.discarded || receipt?.delivered === false || receipt?.status === 'failed' || (receipt?.retcode !== undefined && Number(receipt.retcode) !== 0)
const sourceText = result => (result.sources || []).filter(row => /^https?:\/\//i.test(row.url || '')).map((row, index) => `${index + 1}. ${row.title || '来源'}\n${row.url}`).join('\n')
export async function sendResult(e, result, proactive = false) {
  const parts = [], audioFiles = []
  const audio = (result.contents || []).filter(part => part.type === 'audio' && typeof part.data === 'string' && part.data.length)
  const voice = result.speechMode === 'voice' && audio.length > 0 && !result.speechError
  for (const part of result.contents || []) {
    if (part.type === 'text' && part.text && (!voice || part.keepInVoice)) parts.push(part.text)
    if (part.type === 'reasoning' && part.text) parts.push('模型返回的思考内容：\n' + part.text)
    if (part.type === 'image') {
      const image = part.data ? 'base64://' + part.data : part.url
      if (image) parts.push(globalThis.segment?.image ? globalThis.segment.image(image) : { type: 'image', file: image })
    }
    if (part.type === 'audio' && audio.includes(part) && !result.speechError) {
      audioFiles.push('base64://' + part.data)
    }
  }
  if (voice) { const sources = sourceText(result); if (sources) parts.push('来源：\n' + sources) }
  if (result.speechError) parts.push('语音合成暂不可用，已改为文字。')
  if (!parts.length && !audioFiles.length) return false
  const options = proactive ? { recallMsg: client.config().group.recallSeconds } : {}
  const deliver = async (message, quote = Boolean(e.isGroup)) => { const receipt = await e.reply(message, quote, options); return sendFailed(receipt) ? false : receipt || { delivered: true } }
  if (!audioFiles.length) return deliver(parts)
  try {
    // NapCat/QQ voice messages must not contain quoted replies, text or images.
    const records = audioFiles.map(file => globalThis.segment?.record ? globalThis.segment.record(file) : { type: 'record', file, data: { file } })
    const receipt = await deliver(records, false)
    if (receipt !== false) {
      if (parts.length) {
        try { if (await deliver(parts) === false) globalThis.logger?.warn?.('[AI-Plugin] 语音已送达，附加来源或图片发送失败') }
        catch { globalThis.logger?.warn?.('[AI-Plugin] 语音已送达，附加来源或图片发送失败') }
      }
      return receipt
    }
  } catch { /* Transport/segment errors use the same safe text fallback. */ }
  // QQ transports can reject audio even when synthesis succeeds. Keep the answer
  // visible and let the core commit the delivered text, without exposing audio data.
  const text = result.text || (result.contents || []).filter(part => part.type === 'text').map(part => part.text || '').join('\n')
  return deliver([text || '语音内容未能发送。', '语音发送失败，已改为文字。'].filter(Boolean))
}
export class AIChat extends Base {
  constructor() { super({ name: 'AI-Plugin', dsc: '通用AI聊天、工具与中文管理', event: 'message', priority: 1200, rule: [{ reg: '.*', fnc: 'handle', log: false }] }) }
  async init() { await initialize() }
  async handle(e) {
    try {
      await initialize(); const input = normalizeEvent(e), config = client.config(), mode = classify(input, config)
      if (mode.type === 'command') return this.command(e, input, mode.text)
      if (mode.type === 'ignore') return false
      client.observeGroup(input)
      let proactive = false
      if (mode.type === 'proactive') {
        const presetId = client.proactivePreset(input)
        if (!presetId) return false
        input.presetId = presetId; input.proactive = true; proactive = true
      } else { input.text = mode.text; input.presetId = mode.presetId }
      await enrich(e, input)
      if (!input.text && !input.images.length) return false
      const result = await client.chat(input, { send: output => sendResult(e, output, proactive) })
      return proactive ? false : !result.skipped
    } catch (error) {
      if (e.isPrivate || e.atBot || /^#(?:AI|ai|切换预设|当前预设|chatgpt)/.test(e.msg || '')) await e.reply('AI：' + error.message, Boolean(e.isGroup))
      else globalThis.logger?.warn?.('[AI-Plugin] 主动接话未发送：' + error.message)
      return Boolean(e.isPrivate || e.atBot)
    }
  }
  async command(e, input, text) {
    if (await handleVoiceCommand({ client, input, text, reply: message => e.reply(message, Boolean(e.isGroup)), send: result => sendResult(e, result) })) return true
    if (/^(?:帮助|help)?$/i.test(text)) { await e.reply('AI-Plugin\n私聊或群聊 @ 提问\n#AI预设列表 / #AI切换预设 名称 / #AI当前预设\n#AI结束对话 / #AI记忆 列表 / #AI记忆 添加 内容\n' + VOICE_HELP + '\n主人：#AI登录 / #AI状态 / #AI备份 / #AI清理\n主人：#AI主动接话 开或关 / #AI结束全部对话\n复杂扩展的进度见工作台“功能状态”。', Boolean(e.isGroup)); return true }
    if (/^(?:预设列表|角色列表)$/.test(text)) { await e.reply(client.config().presets.filter(row => row.enabled !== false).map(row => `${row.name}（${row.id}）`).join('\n'), Boolean(e.isGroup)); return true }
    if (/^(?:切换预设|切换角色)/.test(text)) { const name = text.replace(/^(?:切换预设|切换角色)\s*/, ''); const preset = client.switchPreset(input, name); await e.reply(`已切换为「${preset.name}」，开始新会话；原历史保留。`, Boolean(e.isGroup)); return true }
    if (/^(?:当前预设|当前角色)$/.test(text)) { await e.reply('当前角色：' + client.preset(input).name, Boolean(e.isGroup)); return true }
    if (/^(?:结束对话|重置会话)$/.test(text)) { client.end(input); await e.reply('已开始新会话，原历史保留。', Boolean(e.isGroup)); return true }
    if (/^记忆\s*列表$/.test(text)) { await e.reply(client.storage.memories('user', input.userId, 50).map(row => `${row.id}: ${row.text}`).join('\n') || '暂无个人记忆。', Boolean(e.isGroup)); return true }
    if (/^记忆\s*添加\s+/.test(text)) { client.storage.addMemory('user', input.userId, text.replace(/^记忆\s*添加\s+/, '')); await e.reply('已添加个人记忆；启用长期记忆后用于回答。', Boolean(e.isGroup)); return true }
    if (/^记忆\s*删除\s+/.test(text)) { const id = text.replace(/^记忆\s*删除\s+/, '').trim(); await e.reply(client.storage.deleteMemory(id, 'user', input.userId) ? '已删除记忆。' : '记忆不存在或不属于你。', Boolean(e.isGroup)); return true }
    if (/^(?:登录|后台|状态|备份|清理|清空聊天历史|结束全部对话|主动接话)/.test(text)) {
      if (!input.isMaster) { await e.reply('此操作仅主人可用。', Boolean(e.isGroup)); return true }
      if (/^(?:登录|后台)$/.test(text)) { if (!e.isPrivate) { await e.reply('请私聊发送 #AI登录 获取管理入口。', true); return true } await e.reply(management ? management.ticket() : '管理服务已关闭。', false); return true }
      if (text === '状态') { const health = client.health(); await e.reply(`AI-Plugin ${health.version}\n渠道 ${health.channelsEnabled} · 预设 ${health.presets} · 工具 ${health.tools.length}\n历史 ${health.storage.history} · 排队 ${health.queued}`, Boolean(e.isGroup)); return true }
      if (text === '备份') { await e.reply(management ? management.backup().message : '管理服务未启用，请使用CLI备份。', Boolean(e.isGroup)); return true }
      if (text === '清理') { await e.reply('清理完成：' + JSON.stringify(client.storage.cleanup(client.config().retention)), Boolean(e.isGroup)); return true }
      if (text === '清空聊天历史') { const result = client.clearHistory(); await e.reply(`已清空 ${result.history} 条聊天历史与 ${result.groups} 份群上下文，角色选择和手工记忆保留。`, Boolean(e.isGroup)); return true }
      if (text === '结束全部对话') { for (const controllers of client.inflight.values()) for (const controller of controllers) controller.abort(); client.storage.resetAll(); await e.reply('已结束全部会话，历史保留。', Boolean(e.isGroup)); return true }
      if (/^主动接话\s*(?:开|关)$/.test(text)) { const { writeJson } = await import('../../src/core/config.mjs'); const config = client.config(); config.group.proactiveEnabled = /开$/.test(text); writeJson(client.configFile, config); await e.reply(config.group.proactiveEnabled ? '主动接话已开启。' : '主动接话已关闭。', Boolean(e.isGroup)); return true }
    }
    await e.reply('未知 AI 管理命令，请发送 #AI帮助。', Boolean(e.isGroup)); return true
  }
}
export const apps = { AIChat }
