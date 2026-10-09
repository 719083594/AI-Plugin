const CATEGORY = /^[a-z][a-z0-9-]{0,63}(?:\/[a-z][a-z0-9-]{0,63})?$/
const FORBIDDEN = new Set(['__proto__', 'constructor', 'prototype'])

export const inputModerationDefaults = {
  enabled: true, channelId: '', model: 'cf-content-safety', timeoutMs: 4000, failurePolicy: 'block',
  blockedCategories: ['sexual', 'sexual/minors', 'hate', 'hate/threatening', 'harassment/threatening', 'illicit', 'illicit/violent', 'self-harm', 'self-harm/instructions', 'violence', 'violence/graphic', 'privacy/doxxing']
}

export class InputModerationError extends Error {
  constructor(code, message) { super(message); this.name = 'InputModerationError'; this.code = code }
}
const unavailable = () => new InputModerationError('MODERATION_UNAVAILABLE', '内容审查暂不可用，本次请求已停止，请稍后重试或联系机器人主人。')
const cancelled = signal => signal?.reason?.name === 'TimeoutError'
  ? new InputModerationError('MODERATION_TIMEOUT', '内容审查等待超时，本次请求已停止，请稍后重试。')
  : new InputModerationError('MODERATION_ABORTED', '内容审查已取消。')

export function validateInputModeration(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.enabled !== 'boolean' || typeof value.channelId !== 'string' || typeof value.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value.model)) throw new Error('内容审查配置无效')
  if (!Number.isInteger(value.timeoutMs) || value.timeoutMs < 1000 || value.timeoutMs > 10000 || !['block', 'allow'].includes(value.failurePolicy)) throw new Error('内容审查等待上限或故障策略无效')
  if (!Array.isArray(value.blockedCategories) || !value.blockedCategories.length || value.blockedCategories.length > 40 || new Set(value.blockedCategories).size !== value.blockedCategories.length || value.blockedCategories.some(key => typeof key !== 'string' || !CATEGORY.test(key) || FORBIDDEN.has(key))) throw new Error('内容审查拦截分类无效')
  if (value.channelId && !/^[\w.-]{1,80}$/.test(value.channelId)) throw new Error('内容审查渠道标识无效')
  return value
}

export function inputModerationTarget(config, channels = []) {
  validateInputModeration(config)
  const channel = channels.find(item => item.id === config.channelId && item.enabled !== false && item.type === 'openai')
  if (!channel || typeof channel.apiKey !== 'string' || !channel.apiKey.trim()) throw new InputModerationError('MODERATION_UNCONFIGURED', '内容审查已开启，请先配置可用的审查渠道和模型；机器人主人可用 #AI关闭审查 临时关闭。')
  let base
  try { base = new URL(channel.baseUrl) } catch { throw unavailable() }
  const host = base.hostname.toLowerCase(), octets = /^\d+\.\d+\.\d+\.\d+$/.test(host) ? host.split('.').map(Number) : []
  const privateIp = octets.length === 4 && octets.every(value => value >= 0 && value <= 255) && (octets[0] === 10 || octets[0] === 192 && octets[1] === 168 || octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31)
  const internal = ['new-api', 'localhost', '127.0.0.1', '[::1]'].includes(host) || privateIp
  if (base.username || base.password || base.search || base.hash || !/^\/(?:v1\/?)?$/.test(base.pathname) || !(base.protocol === 'https:' || base.protocol === 'http:' && internal)) throw unavailable()
  base.pathname = '/v1/moderations'
  return { url: base, token: channel.apiKey }
}

async function abortable(work, signal) {
  if (signal.aborted) throw cancelled(signal)
  let abort
  const interrupted = new Promise((_, reject) => { abort = () => reject(cancelled(signal)); signal.addEventListener('abort', abort, { once: true }) })
  try { return await Promise.race([Promise.resolve().then(work), interrupted]) }
  finally { signal.removeEventListener('abort', abort) }
}
function cancelBody(body) { try { void body?.cancel().catch(() => {}) } catch {} }
async function boundedJson(response, signal) {
  if (Number(response.headers.get('content-length')) > 65536 || !response.body) { cancelBody(response.body); throw unavailable() }
  const reader = response.body.getReader(), chunks = []; let length = 0
  try {
    while (true) {
      const { done, value } = await abortable(() => reader.read(), signal)
      if (done) break
      length += value.byteLength
      if (length > 65536) throw unavailable()
      chunks.push(Buffer.from(value))
    }
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'))
  } finally { void reader.cancel().catch(() => {}); try { reader.releaseLock() } catch {} }
}

/** Sends only the current request's text, never conversation history or images. */
export class InputModerationService {
  constructor({ config = () => inputModerationDefaults, channels = () => [], fetchImpl = fetch } = {}) { this.config = config; this.channels = channels; this.fetchImpl = fetchImpl; this.closed = new AbortController() }
  close() { this.closed.abort() }
  async check(value, { signal: externalSignal } = {}) {
    const config = { ...inputModerationDefaults, ...this.config() }
    if (!config.enabled) return { status: 'disabled' }
    const text = (Array.isArray(value) ? value : [value]).filter(item => typeof item === 'string' && item.trim()).join('\n')
    if (text.length > 4000) throw new InputModerationError('MODERATION_INPUT_TOO_LONG', '待审查文字最多 4000 字符，请缩短后重试。')
    let target
    try { target = inputModerationTarget(config, this.channels()) } catch (error) { if (error instanceof InputModerationError) throw error; throw unavailable() }
    if (!text.trim()) return { status: 'no_text' }
    const timeout = new AbortController(), timer = setTimeout(() => timeout.abort(new DOMException('Timed out', 'TimeoutError')), config.timeoutMs)
    const signal = AbortSignal.any([timeout.signal, this.closed.signal, ...(externalSignal ? [externalSignal] : [])])
    try {
      const response = await abortable(() => this.fetchImpl(target.url, { method: 'POST', redirect: 'manual', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${target.token}` }, body: JSON.stringify({ model: config.model, input: text }) }), signal)
      if (!response.ok) { cancelBody(response.body); throw unavailable() }
      const value = await boundedJson(response, signal), result = value?.results?.[0]
      if (value?.error || !Array.isArray(value?.results) || value.results.length !== 1 || typeof result?.flagged !== 'boolean' || !result.categories || typeof result.categories !== 'object' || Array.isArray(result.categories)) throw unavailable()
      const categories = Object.entries(result.categories)
      if (!categories.length || categories.some(([key, flag]) => !CATEGORY.test(key) || FORBIDDEN.has(key) || typeof flag !== 'boolean') || config.blockedCategories.some(key => !Object.hasOwn(result.categories, key)) || result.flagged !== categories.some(([, flag]) => flag)) throw unavailable()
      if (signal.aborted) throw cancelled(signal)
      if (config.blockedCategories.some(key => result.categories[key])) throw new InputModerationError('MODERATION_BLOCKED', '这条内容未通过审查，请调整表达后再试。')
      return { status: 'passed' }
    } catch (error) {
      if (signal.aborted) {
        if (timeout.signal.aborted && !externalSignal?.aborted && !this.closed.signal.aborted && config.failurePolicy === 'allow') return { status: 'unavailable', failurePolicy: 'allow' }
        throw cancelled(signal)
      }
      if (error?.code === 'MODERATION_BLOCKED') throw error
      if (config.failurePolicy === 'allow') return { status: 'unavailable', failurePolicy: 'allow' }
      throw error instanceof InputModerationError ? error : unavailable()
    } finally { clearTimeout(timer) }
  }
}
