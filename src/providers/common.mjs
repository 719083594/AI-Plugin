import { fetchPublicImage, publicImageUrl } from '../media/remote.mjs';
/** Stateless protocol helpers. No bot framework or global SDK managers. */
export class ProviderError extends Error {
  constructor(message, { code = 'PROVIDER_ERROR', status, retryable = false } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.code = code;
    this.status = status;
    this.retryable = retryable;
  }
}

export function plannedCapability(name) {
  return new ProviderError(`${name}暂未实现，请使用已支持的文字或图片能力。`, { code: 'CAPABILITY_PLANNED' });
}

export function httpUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new ProviderError('请求地址无效。', { code: 'INVALID_URL' }); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) {
    throw new ProviderError('仅支持不含账号密码的 HTTP/HTTPS 地址。', { code: 'INVALID_URL' });
  }
  return url;
}

export function endpoint(baseUrl, suffix, fallback) {
  const url = httpUrl(baseUrl || fallback);
  if (url.search || url.hash) throw new ProviderError('渠道基础地址不能包含查询参数或片段。', { code: 'INVALID_URL' });
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith(suffix) ? path : `${path}${suffix}`;
  return url;
}

export function requestSignal(signal, timeoutMs = 25000) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new ProviderError('请求超时必须为正数。', { code: 'INVALID_OPTIONS' });
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}

export function validateRequest({ channel, model, messages }) {
  if (!channel || channel.enabled === false) throw new ProviderError('模型渠道未启用。', { code: 'CHANNEL_DISABLED' });
  if (typeof model !== 'string' || !model.trim()) throw new ProviderError('未指定模型。', { code: 'MODEL_REQUIRED' });
  if (!Array.isArray(messages) || !messages.length) throw new ProviderError('聊天消息不能为空。', { code: 'EMPTY_MESSAGES' });
  for (const message of messages) {
    if (!['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role)) {
      throw new ProviderError('消息角色不受支持。', { code: 'INVALID_MESSAGES' });
    }
    if (message.role === 'tool' && !message.toolCallId) throw new ProviderError('工具结果缺少调用 ID。', { code: 'INVALID_MESSAGES' });
  }
}

export function parts(message) {
  const content = message.content ?? [];
  return typeof content === 'string' ? [{ type: 'text', text: content }] : content;
}

export function textContent(message) {
  return parts(message).filter(part => part.type === 'text').map(part => String(part.text ?? '')).join('\n');
}

export function imageData(part) {
  const value = part.data || part.url || '';
  const match = /^data:(image\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=\s]+)$/i.exec(value);
  if (match) return { mime: match[1].toLowerCase(), data: match[2].replace(/\s/g, '') };
  if (part.data && !part.data.includes(':')) return { mime: part.mime || 'image/jpeg', data: part.data };
  return null;
}

export function imageUrl(part) {
  const embedded = imageData(part);
  if (embedded) return `data:${embedded.mime};base64,${embedded.data}`;
  return publicImageUrl(part.url).href;
}

export async function loadImageData(part, { signal, fetchImpl = fetch, lookup, maxBytes = 10 * 1024 * 1024 } = {}) {
  const inline = imageData(part);
  if (inline) {
    if (!/^image\/(jpeg|png|gif|webp)$/i.test(inline.mime) || Buffer.from(inline.data, 'base64').length > maxBytes) {
      throw new ProviderError('图片格式不支持或大小超过 10MB。', { code: 'INVALID_IMAGE' });
    }
    return inline;
  }
  const { mime, buffer } = await fetchPublicImage(part.url, { fetchImpl, lookup, signal, maxBytes });
  return { mime, data: buffer.toString('base64') };
}

export function parseArguments(value) {
  let result = value;
  if (typeof value === 'string') {
    try { result = JSON.parse(value || '{}'); } catch { throw new ProviderError('模型返回了无效的工具参数 JSON。', { code: 'INVALID_TOOL_ARGUMENTS' }); }
  }
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    throw new ProviderError('模型工具参数必须是对象。', { code: 'INVALID_TOOL_ARGUMENTS' });
  }
  return result;
}

export function toolCall(id, name, args, extra = {}) {
  if (typeof id !== 'string' || !id || typeof name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) {
    throw new ProviderError('模型工具调用缺少有效 ID 或名称。', { code: 'INVALID_TOOL_CALL' });
  }
  return { id, name, arguments: parseArguments(args), ...extra };
}

export function usage(inputTokens = 0, outputTokens = 0, totalTokens) {
  return { inputTokens, outputTokens, totalTokens: totalTokens ?? inputTokens + outputTokens };
}

export async function post(url, body, { headers = {}, signal, fetchImpl = fetch, provider } = {}) {
  signal?.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST', redirect: 'error', signal,
      headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
    });
  } catch {
    signal?.throwIfAborted();
    throw new ProviderError(`${provider || '模型'}网络请求失败。`, { code: 'NETWORK_ERROR', retryable: true });
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new ProviderError(`${provider || '模型'}请求失败（HTTP ${response.status}）。`, {
      code: 'HTTP_ERROR', status: response.status,
      retryable: response.status === 408 || response.status === 429 || response.status >= 500
    });
  }
  return response;
}

export async function readJson(response, maxBytes = 20 * 1024 * 1024) {
  let text = '';
  let size = 0;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > maxBytes) throw new ProviderError('模型响应过大。', { code: 'RESPONSE_TOO_LARGE' });
      text += decoder.decode(chunk, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    if (error instanceof ProviderError || error.name === 'AbortError' || error.name === 'TimeoutError') throw error;
    throw new ProviderError('模型返回了无效的 JSON。', { code: 'INVALID_RESPONSE' });
  }
}

/** Parse SSE by lines; handles CRLF, split UTF-8 bytes, and final unterminated events. */
export async function* readSse(response, maxBytes = 20 * 1024 * 1024) {
  let buffer = '';
  let event = { event: '', data: [] };
  let size = 0;
  const decoder = new TextDecoder();
  function line(value) {
    const normalized = value.replace(/\r$/, '');
    if (!normalized) {
      const result = event.data.length ? { event: event.event, data: event.data.join('\n') } : null;
      event = { event: '', data: [] };
      return result;
    }
    if (normalized.startsWith('data:')) event.data.push(normalized.slice(5).replace(/^ /, ''));
    else if (normalized.startsWith('event:')) event.event = normalized.slice(6).trim();
    return null;
  }
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > maxBytes) throw new ProviderError('模型流式响应过大。', { code: 'RESPONSE_TOO_LARGE' });
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const next = line(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      if (next) yield next;
    }
  }
  buffer += decoder.decode();
  if (buffer) { const next = line(buffer); if (next) yield next; }
  const last = line('');
  if (last) yield last;
}

export function parseEvent(data) {
  try { return JSON.parse(data); } catch { throw new ProviderError('模型返回了无效的流式事件。', { code: 'INVALID_RESPONSE' }); }
}

export function ensureResponse(result) {
  if (!result.toolCalls.length && !result.contents.some(part => part.type === 'image' || part.text?.trim())) {
    throw new ProviderError('模型未返回可用内容，可能被安全策略阻止。', { code: 'EMPTY_RESPONSE' });
  }
  return result;
}
