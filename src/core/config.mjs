import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const pluginRoot = fileURLToPath(new URL('../../', import.meta.url))
export const defaults = {
  basic: { enabled: true, debug: false, commandPrefix: '#AI', defaultPresetId: 'default', triggerMode: 'at', triggerPrefix: '#chat' },
  channels: [],
  presets: [{ id: 'default', name: '默认助手', prefix: '', model: '', channelId: '', systemPrompt: '你是一个可靠的中文助手。需要时使用工具；搜索答案附真实来源链接，不编造事实。', temperature: 0.7, maxTokens: 2048, historyLength: 20, tools: ['web_search', 'ask_about_image', 'look_at_image', 'resolve_image_ref', 'GetQQAvatar'], showReasoning: false, stream: false, enabled: true }],
  chat: { privateEnabled: true, groupEnabled: true, enableRoleSwitch: true, userRoleWhitelist: [], userRoleBlacklist: [], maxConcurrent: 1, maxQueue: 3, timeoutMs: 10000, toolTimeoutMs: 30000, maxToolRounds: 4, maxReplyLength: 12000 },
  group: { enableContext: true, contextLength: 20, contextImages: true, proactiveEnabled: false, probability: 0.03, keywords: [], keywordPresets: [], defaultPresetId: '', prompt: '结合最近的群聊，自然简短地接话。没有必要时返回 [不回复]，不要重复他人或打断指令。', maxTokens: 256, cooldownMs: 60000, recallSeconds: 0 },
  memory: { userEnabled: false, groupEnabled: false, maxItems: 5, autoExtract: false, knowledgeEnabled: false, knowledgeLimit: 3 },
  tools: { searchEnabled: true, searchEndpoint: '', searchToken: '', searchModule: '', searchConfigFile: '', searchTimeoutMs: 26000, maxSearchResults: 5, customDirectory: './data/tools', skillsDirectory: './data/skills' },
  media: { imagesEnabled: true, maxImageBytes: 10485760, visionChannelId: '', visionModel: '', imageRetentionHours: 0 },
  security: { userWhitelist: [], userBlacklist: [], groupWhitelist: [], groupBlacklist: [], inputBlockedWords: [], outputBlockedWords: [], blockStrategy: 'full', replacement: '***', rateWindowMs: 60000, maxRequestsPerWindow: 6 },
  management: { enabled: true, host: '127.0.0.1', port: 48371, publicUrl: 'http://127.0.0.1:48371', apiToken: '', ticketSeconds: 180, sessionSeconds: 3600, webChatEnabled: true },
  retention: { historyDays: 30, proactiveHistoryDays: 30, logLimit: 5000, cleanupIntervalHours: 1, backupCount: 5 },
  extensions: { mcp: [], schedules: [], workflows: [], processors: [], pricing: [] }
}
export function merge(base, value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return structuredClone(value ?? base)
  const result = structuredClone(base)
  for (const [key, item] of Object.entries(value)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new Error('配置包含不允许的字段')
    result[key] = item && typeof item === 'object' && !Array.isArray(item) && base?.[key] && typeof base[key] === 'object' ? merge(base[key], item) : structuredClone(item)
  }
  return result
}
export function validateConfig(config) {
  const int = (value, min, max, label) => { if (!Number.isInteger(value) || value < min || value > max) throw new Error(label + '超出允许范围') }
  int(config.management.port, 1, 65535, '管理端口')
  int(config.chat.maxConcurrent, 1, 20, '并发数')
  int(config.chat.maxQueue, 0, 100, '排队数')
  int(config.chat.timeoutMs, 1000, 300000, '普通请求等待上限')
  int(config.chat.toolTimeoutMs, 1000, 600000, '工具请求等待上限')
  int(config.chat.maxToolRounds, 0, 12, '工具轮数')
  int(config.group.contextLength, 0, 100, '群上下文条数')
  int(config.security.maxRequestsPerWindow, 1, 10000, '频率限制')
  if (!Number.isFinite(config.group.probability) || config.group.probability < 0 || config.group.probability > 1) throw new Error('主动接话概率必须在 0 与 1 之间')
  if (!['at', 'prefix', 'both'].includes(config.basic.triggerMode)) throw new Error('群聊触发方式无效')
  for (const category of ['channels', 'presets']) {
    if (!Array.isArray(config[category])) throw new Error(category === 'channels' ? '渠道必须为数组' : '预设必须为数组')
    const ids = new Set()
    for (const entry of config[category]) {
      if (!entry || !/^[\w.-]{1,80}$/.test(entry.id) || ids.has(entry.id)) throw new Error('渠道或预设标识为空、重复或格式无效')
      ids.add(entry.id)
      if (category === 'channels' && !['openai', 'gemini', 'claude'].includes(entry.type)) throw new Error('不支持的模型接口类型')
    }
  }
  return config
}
export function readConfig(filename = path.join(pluginRoot, 'config/local.json')) {
  let value = {}
  try { value = JSON.parse(fs.readFileSync(filename, 'utf8').replace(/^\uFEFF/, '')) } catch (error) { if (error.code !== 'ENOENT') throw new Error('配置读取失败：' + error.message) }
  return validateConfig(merge(defaults, value))
}
export function writeJson(filename, value) {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  const temp = filename + '.tmp'
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
  fs.renameSync(temp, filename)
}
export function mask(value, key = '') {
  if (!/^(?:maxTokens?|minTokens?|tokenLimit|tokenCount|totalTokens|inputTokens|outputTokens)$/i.test(key) && /api.?key|token|secret|password|authKey/i.test(key)) return value ? '••••••••' : ''
  if (Array.isArray(value)) return value.map(item => mask(item))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, mask(item, name)]))
  return value
}
export function restoreSecrets(value, previous, key = '') {
  if (value === '••••••••' && /api.?key|token|secret|password|authKey/i.test(key)) {
    if (previous === undefined) throw new Error('新增项目的密钥必须重新填写')
    return previous
  }
  if (Array.isArray(value)) return value.map((item, index) => restoreSecrets(item, item && typeof item === 'object' && item.id ? (previous || []).find(old => old.id === item.id) : previous?.[index]))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, restoreSecrets(item, previous?.[name], name)]))
  return value
}
