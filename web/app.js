const $ = id => document.getElementById(id)
let csrf = ''
async function api(route, method = 'GET', value) {
  const response = await fetch('/api/' + route, { method, headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-AI-CSRF': csrf } : {}) }, ...(value ? { body: JSON.stringify(value) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error || '请求失败')
  return result
}
function node(tag, text, cls) { const value = document.createElement(tag); value.textContent = text; if (cls) value.className = cls; return value }
function show(page) { for (const id of ['chat', 'capabilities', 'logs', 'settings']) $(id).hidden = id !== page }
function error(value) { $('error').textContent = value?.message || String(value || '') }
for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => show(button.dataset.page))
async function logs() { const result = await api('logs'); $('log-list').replaceChildren(...result.records.map(row => node('div', `${row.createdAt} · ${row.success ? '成功' : '失败'} · ${row.model || '未调用模型'} · ${row.durationMs || 0} 毫秒`, 'log'))) }
$('chat-form').addEventListener('submit', async event => {
  event.preventDefault(); error(''); const text = $('question').value.trim(); if (!text) return
  $('send').disabled = true; $('messages').append(node('div', text, 'message user')); $('question').value = ''
  try {
    const result = await api('chat', 'POST', { text, presetId: $('preset').value }); const message = node('div', result.text, 'message')
    for (const part of result.contents || []) if (part.type === 'image') { const image = document.createElement('img'); image.alt = 'AI 返回的图片'; const src = part.url || (part.data ? `data:${part.mime || 'image/png'};base64,${part.data}` : ''); if (/^(https?:|data:image\/)/.test(src)) { image.src = src; message.append(image) } }
    $('messages').append(message)
  } catch (value) { error(value) } finally { $('send').disabled = false }
})
$('reset').addEventListener('click', async () => { try { await api('reset', 'POST', {}); $('messages').replaceChildren(); error('') } catch (value) { error(value) } })
$('refresh-logs').addEventListener('click', () => logs().catch(error))
for (const id of ['backup', 'cleanup']) $(id).addEventListener('click', async () => { try { $('maintenance-result').textContent = JSON.stringify(await api(id, 'POST', {}), null, 2) } catch (value) { error(value) } })
$('clear-history').addEventListener('click', async () => { if (!confirm('清空全部聊天历史和群聊上下文？角色选择、配置与手工记忆会保留。')) return; try { $('maintenance-result').textContent = JSON.stringify(await api('history/clear', 'POST', {}), null, 2); $('messages').replaceChildren() } catch (value) { error(value) } })
async function init() {
  try {
    const session = await api('session'); csrf = session.csrf; const health = await api('health'); $('status').textContent = `${health.version} · 服务正常`
    const config = (await api('config')).value
    for (const preset of config.presets.filter(item => item.enabled !== false)) { const option = node('option', preset.name); option.value = preset.id; $('preset').append(option) }
    $('preset').value = config.basic.defaultPresetId
    $('config-summary').textContent = `模型渠道 ${config.channels.length} 个 · 角色预设 ${config.presets.length} 个 · 历史保留 ${config.retention.historyDays || '永久'}${config.retention.historyDays ? '天' : ''}`
    const data = await api('capabilities'); const labels = { implemented: '已实现', planned: '待实现', unconfigured: '待配置' }
    $('capability-list').replaceChildren(...data.capabilities.map(item => { const entry = node('div', '', 'capability'); entry.append(node('div', item.title + ' · ' + labels[item.status]), node('div', item.description, 'tag')); return entry }))
    await logs()
  } catch (value) { $('login').hidden = false; for (const id of ['chat', 'capabilities', 'logs', 'settings']) $(id).hidden = true; $('status').textContent = '请登录'; error(value) }
}
init()
