import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto'
import { mask, restoreSecrets, merge, validateConfig, writeJson } from '../core/config.mjs'
import { redactError } from '../core/client.mjs'

const equal = (a, b) => { if (typeof a !== 'string' || typeof b !== 'string') return false; const left = Buffer.from(a), right = Buffer.from(b); return left.length === right.length && timingSafeEqual(left, right) }
const revision = value => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)) }
async function body(req) {
  let content = ''
  for await (const chunk of req) { content += chunk; if (Buffer.byteLength(content) > 1048576) throw new Error('请求内容过大') }
  return content ? JSON.parse(content) : {}
}
export function startManagement(client, options = {}) {
  const settings = { ...client.config().management, ...options }, tickets = new Map(), sessions = new Map()
  const capabilityFile = path.join(client.root, 'capabilities.json')
  const capabilities = () => JSON.parse(fs.readFileSync(capabilityFile, 'utf8'))
  const ticket = () => { const value = randomBytes(32).toString('base64url'); tickets.set(value, Date.now() + settings.ticketSeconds * 1000); return `${settings.publicUrl.replace(/\/$/, '')}/login?ticket=${value}` }
  const backup = () => {
    const directory = path.join(client.root, 'backups', new Date().toISOString().replace(/[:.]/g, '-'))
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 }); client.storage.backup(path.join(directory, 'ai.db')); writeJson(path.join(directory, 'config.json'), client.config())
    const dirs = fs.readdirSync(path.join(client.root, 'backups')).sort().reverse()
    for (const old of dirs.slice(client.config().retention.backupCount)) if (/^\d{4}-\d\d-\d\dT[\dTZ-]+$/.test(old)) fs.rmSync(path.join(client.root, 'backups', old), { recursive: true })
    return { id: path.basename(directory), message: '已创建一致性数据库和配置备份' }
  }
  const server = http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff'); res.setHeader('Referrer-Policy', 'no-referrer'); res.setHeader('X-Frame-Options', 'DENY')
    res.setHeader('Content-Security-Policy', "default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'")
    try {
      const url = new URL(req.url, 'http://localhost')
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, client.health())
      if (url.pathname === '/login' && req.method === 'GET') {
        const key = url.searchParams.get('ticket'), expires = tickets.get(key); tickets.delete(key)
        if (!expires || expires < Date.now()) return json(res, 401, { error: '登录链接已过期或已经使用，请重新获取' })
        const sid = randomBytes(32).toString('base64url'), csrf = randomBytes(24).toString('base64url')
        sessions.set(sid, { csrf, expires: Date.now() + settings.sessionSeconds * 1000 })
        res.writeHead(302, { Location: '/', 'Set-Cookie': `ai_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${settings.sessionSeconds}` }); return res.end()
      }
      if (['/', '/app.js', '/app.css'].includes(url.pathname) && req.method === 'GET') {
        const file = path.join(client.root, 'web', url.pathname === '/' ? 'index.html' : url.pathname.slice(1))
        res.writeHead(200, { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript; charset=utf-8' : url.pathname.endsWith('.css') ? 'text/css; charset=utf-8' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(fs.readFileSync(file))
      }
      const cookie = String(req.headers.cookie || '').match(/(?:^|;\s*)ai_session=([\w-]+)/)?.[1], session = sessions.get(cookie)
      if (session && session.expires < Date.now()) sessions.delete(cookie)
      const bearer = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '')
      const tokenAuth = Boolean(settings.apiToken && equal(bearer, settings.apiToken)), sessionAuth = Boolean(session && session.expires >= Date.now())
      if (!tokenAuth && !sessionAuth) return json(res, 401, { error: '请由主人私聊发送 #AI登录 获取管理入口' })
      if (req.headers.origin && ![new URL(settings.publicUrl).origin, 'http://' + req.headers.host].includes(req.headers.origin)) return json(res, 403, { error: '请求来源不允许' })
      if (!['GET', 'HEAD'].includes(req.method) && !tokenAuth && !equal(req.headers['x-ai-csrf'], session.csrf)) return json(res, 403, { error: '请求校验失败，请刷新页面' })
      const route = url.pathname.replace(/^\/api\/ai-plugin/, '/api')
      if (route === '/api/session' && req.method === 'GET') return json(res, 200, { role: 'owner', csrf: sessionAuth ? session.csrf : null })
      if (route === '/api/ticket' && req.method === 'POST') { if (!tokenAuth) return json(res, 403, { error: '生成临时入口仅允许认证的本机管理服务' }); return json(res, 200, { url: ticket() }) }
      if (route === '/api/health' && req.method === 'GET') return json(res, 200, client.health())
      if (route === '/api/capabilities' && req.method === 'GET') return json(res, 200, capabilities())
      if (route === '/api/config' && req.method === 'GET') { const config = client.config(); return json(res, 200, { value: mask(config), revision: revision(config), schema: JSON.parse(fs.readFileSync(path.join(client.root, 'orangejuice.plugin.json'), 'utf8')).configs[0].fields }) }
      if (route === '/api/config' && req.method === 'PUT') {
        const value = await body(req), previous = client.config()
        if (value.revision !== revision(previous)) return json(res, 409, { error: '配置已被其他页面修改，请重新加载' })
        const next = validateConfig(merge(previous, restoreSecrets(value.value, previous)))
        backup(); writeJson(client.configFile, next); return json(res, 200, { message: '配置已保存；地址、端口、并发数等运行参数需重启后生效', revision: revision(next), value: mask(next) })
      }
      if (route === '/api/chat' && req.method === 'POST') {
        if (!client.config().management.webChatEnabled) return json(res, 403, { error: '网页聊天已关闭' })
        const value = await body(req); const result = await client.chat({ userId: 'web-owner', text: String(value.text || ''), presetId: value.presetId, isMaster: true }); return json(res, 200, result)
      }
      if (route === '/api/logs' && req.method === 'GET') return json(res, 200, { records: client.storage.logs(url.searchParams.get('limit')), stats: client.storage.stats(), usage: client.storage.usageStats() })
      if (route === '/api/users' && req.method === 'GET') return json(res, 200, client.storage.users())
      if (route === '/api/history' && req.method === 'GET') return json(res, 200, client.storage.history(String(url.searchParams.get('conversationId')), 100))
      if (route === '/api/memories' && req.method === 'GET') return json(res, 200, client.storage.memories(url.searchParams.get('scope') || 'user', url.searchParams.get('ownerId') || 'web-owner', 100))
      if (route === '/api/memories' && req.method === 'POST') { const value = await body(req); return json(res, 200, { id: client.storage.addMemory(value.scope, value.ownerId, value.text) }) }
      if (route === '/api/memories' && req.method === 'DELETE') { const value = await body(req); return json(res, 200, { deleted: client.storage.deleteMemory(value.id, value.scope, value.ownerId) }) }
      if (route === '/api/knowledge' && req.method === 'POST') { const value = await body(req); return json(res, 200, { id: client.storage.addKnowledge(value.title, value.text) }) }
      if (route === '/api/cleanup' && req.method === 'POST') return json(res, 200, client.storage.cleanup(client.config().retention))
      if (route === '/api/history/clear' && req.method === 'POST') return json(res, 200, client.clearHistory())
      if (route === '/api/backup' && req.method === 'POST') return json(res, 200, backup())
      if (route === '/api/reset' && req.method === 'POST') { const value = await body(req); client.end({ userId: value.userId || 'web-owner', botId: value.botId }); return json(res, 200, { message: '已开始新会话，原历史保留' }) }
      if (route === '/v1/models' && req.method === 'GET') return json(res, 200, { object: 'list', data: [...new Set(client.config().presets.filter(row => row.enabled !== false).map(row => row.model))].map(id => ({ id, object: 'model', owned_by: 'AI-Plugin' })) })
      if (route === '/v1/chat/completions' && req.method === 'POST') {
        const value = await body(req); if (value.stream) return json(res, 400, { error: '兼容 API 的 SSE 输出尚待实现，请使用 stream:false' })
        if (!Array.isArray(value.messages) || !value.messages.length || value.messages.length > 100) throw new Error('消息数组为空或过长')
        const preset = client.config().presets.find(row => row.enabled !== false && (row.model === value.model || row.id === value.model))
        if (!preset) throw new Error('模型未配置对应可用预设')
        const messages = value.messages.map(row => {
          if (!['system', 'user', 'assistant', 'tool'].includes(row.role)) throw new Error('消息角色无效')
          const content = typeof row.content === 'string' ? [{ type: 'text', text: row.content }] : (row.content || []).map(part => part.type === 'image_url' ? { type: 'image', url: part.image_url?.url } : part)
          return { role: row.role, content, toolCallId: row.tool_call_id, ...(row.tool_calls ? { toolCalls: row.tool_calls.map(call => ({ id: call.id, name: call.function?.name, arguments: JSON.parse(call.function?.arguments || '{}') })) } : {}) }
        })
        const text = messages.filter(row => row.role === 'user').flatMap(row => row.content.filter(part => part.type === 'text').map(part => part.text)).join('\n')
        const result = await client.chat({ userId: 'api-owner', text, messages, presetId: preset.id, isMaster: true, transient: true })
        return json(res, 200, { id: 'chatcmpl-' + randomBytes(12).toString('hex'), object: 'chat.completion', created: Math.floor(Date.now() / 1000), model: result.model, choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }], usage: { prompt_tokens: result.usage.inputTokens || 0, completion_tokens: result.usage.outputTokens || 0, total_tokens: result.usage.totalTokens || 0 } })
      }
      return json(res, 404, { error: '接口不存在或该能力尚待实现' })
    } catch (error) { if (!res.headersSent) return json(res, 400, { error: redactError(error, client.config()) }); res.end() }
  })
  const ready = new Promise((resolve, reject) => { server.once('error', reject); server.listen(settings.port, settings.host, () => resolve(server.address())) })
  const expire = setInterval(() => { for (const collection of [tickets, sessions]) for (const [key, value] of collection) if ((typeof value === 'number' ? value : value.expires) < Date.now()) collection.delete(key) }, 60000); expire.unref()
  server.on('close', () => clearInterval(expire))
  return { server, ready, ticket, backup, settings, close: () => new Promise(resolve => server.close(resolve)) }
}
