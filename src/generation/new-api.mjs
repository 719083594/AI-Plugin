const MODEL = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/

export const newApiDefaults = { enabled: false, channelId: '', imageModels: [], imageProtocols: {}, videoModels: [], pollIntervalMs: 2000 }

export function validateNewApiConfig(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || typeof value.channelId !== 'string') throw new Error('New API 生成配置无效')
  for (const key of ['imageModels', 'videoModels']) {
    if (!Array.isArray(value[key]) || value[key].length > 20 || value[key].some(model => typeof model !== 'string' || !MODEL.test(model) || ['flux', 'anima', 'hf-story'].includes(model)) || new Set(value[key]).size !== value[key].length) throw new Error('New API 生成模型名单无效')
  }
  const protocols = value.imageProtocols === undefined ? {} : value.imageProtocols
  if (!protocols || typeof protocols !== 'object' || Array.isArray(protocols) || ![Object.prototype, null].includes(Object.getPrototypeOf(protocols)) || Object.entries(protocols).some(([model, protocol]) => !value.imageModels.includes(model) || ['__proto__', 'constructor', 'prototype'].includes(model) || !['gemini', 'openai'].includes(protocol))) throw new Error('New API 图片协议须对应已启用的图片模型，且为 gemini 或 openai')
  if (!Number.isInteger(value.pollIntervalMs) || value.pollIntervalMs < 250 || value.pollIntervalMs > 10000) throw new Error('New API 视频轮询间隔无效')
  if (value.enabled && (!/^[\w.-]{1,80}$/.test(value.channelId) || !value.imageModels.length && !value.videoModels.length)) throw new Error('请为 New API 生成选择已有渠道和已验证的模型')
  return value
}

export function newApiImageProtocol(config, model) {
  return Object.hasOwn(config.imageProtocols ?? {}, model) ? config.imageProtocols[model] : 'gemini'
}

export function newApiModelEnabled(generation, kind, model) {
  const config = generation?.newApi
  return Boolean(generation?.enabled && config?.enabled && config[kind === 'image' ? 'imageModels' : 'videoModels']?.includes(model))
}

// Credentials and the endpoint always come from an existing OpenAI channel.
// In particular, model input can never introduce a URL or a Google API key.
export function newApiTarget(generation, channels = []) {
  const config = { ...newApiDefaults, ...generation?.newApi }
  validateNewApiConfig(config)
  if (!generation?.enabled || !config.enabled) return null
  const channel = channels.find(item => item.id === config.channelId && item.enabled !== false && item.type === 'openai')
  if (!channel || typeof channel.apiKey !== 'string' || !channel.apiKey.trim()) throw new Error('New API 生成需要已启用的 OpenAI 兼容渠道及访问令牌')
  let base
  try { base = new URL(channel.baseUrl) } catch { throw new Error('New API 渠道地址无效') }
  const host = base.hostname.toLowerCase(), octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : []
  const privateIp = octets.length === 4 && octets.every(value => value >= 0 && value <= 255) && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  const internal = host === 'new-api' || host === 'localhost' || host === '127.0.0.1' || host === '[::1]' || privateIp
  if (base.username || base.password || base.search || base.hash || !/^\/(?:v1\/?)?$/.test(base.pathname) || !(base.protocol === 'https:' || base.protocol === 'http:' && internal)) throw new Error('New API 渠道须为 HTTPS 根地址或已有内网 HTTP 根地址，可包含 /v1')
  base.pathname = '/'
  return { base, config: { ...generation, token: channel.apiKey, newApi: config } }
}

export function generationModels(generation, channels = []) {
  const image = generation?.enabled && generation.endpoint ? ['flux', 'anima'] : [], video = generation?.enabled && generation.endpoint ? ['hf-story'] : []
  try {
    const target = newApiTarget(generation, channels)
    if (target) { image.push(...target.config.newApi.imageModels); video.push(...target.config.newApi.videoModels) }
  } catch { /* Invalid or disabled private channels are not advertised. */ }
  return { image, video }
}
