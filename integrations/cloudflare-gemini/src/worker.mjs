const UPSTREAM = 'https://generativelanguage.googleapis.com';
const ID = '[A-Za-z0-9_-]{1,160}';
const MODEL = '[A-Za-z0-9._-]{1,160}';
const ENCODER = new TextEncoder();
const SAFE_RESPONSE_HEADERS = ['content-type', 'retry-after', 'content-disposition', 'accept-ranges', 'content-range'];

class RelayError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}

function integer(value, fallback, low, high) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= low && number <= high ? number : fallback;
}

function responseError(status, code) {
  return new Response(JSON.stringify({ error: { code, message: code } }), {
    status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
  });
}

async function safeEqual(left, right) {
  // Fixed-size digest comparison avoids a first-mismatch timing comparison of credentials.
  const digests = await Promise.all([left, right].map(value => crypto.subtle.digest('SHA-256', ENCODER.encode(value))));
  const a = new Uint8Array(digests[0]);
  const b = new Uint8Array(digests[1]);
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a[i] ^ b[i];
  return difference === 0;
}

async function authenticate(request, url, expected) {
  const credentials = [];
  const authorization = request.headers.get('authorization');
  if (authorization !== null) {
    const match = /^Bearer ([^\s,]{16,512})$/i.exec(authorization);
    if (!match) throw new RelayError(401, 'unauthorized');
    credentials.push(match[1]);
  }
  const header = request.headers.get('x-goog-api-key');
  if (header !== null) credentials.push(header);
  const query = url.searchParams.getAll('key');
  if (query.length > 1) throw new RelayError(400, 'duplicate_query_parameter');
  credentials.push(...query);
  if (!credentials.length) throw new RelayError(401, 'unauthorized');
  for (const credential of credentials) {
    if (credential.length < 16 || credential.length > 512 || !(await safeEqual(credential, expected))) {
      throw new RelayError(401, 'unauthorized');
    }
  }
}

export function routeFor(path, method) {
  // No percent escapes, backslashes, empty path segments, hostnames, uploads or administrative methods.
  if (path.includes('%') || path.includes('\\') || path.includes('//')) return null;
  const version = '(?:v1|v1beta)';
  if (method === 'GET' && new RegExp(`^/${version}/models(?:/${MODEL})?$`).test(path)) return 'models';
  if (method === 'POST' && new RegExp(`^/${version}/models/${MODEL}:(?:generateContent|streamGenerateContent|countTokens|embedContent|predict|predictLongRunning)$`).test(path)) return 'generate';
  if (method === 'GET' && new RegExp(`^/v1beta/(?:models/${MODEL}/)?operations/${ID}$`).test(path)) return 'operation';
  if (method === 'GET' && new RegExp(`^/v1beta/files/${ID}(?::download)?$`).test(path)) return path.endsWith(':download') ? 'download' : 'file';
  if (method === 'POST' && /^\/v1beta\/openai\/(?:chat\/completions|images\/generations|embeddings)$/.test(path)) return 'openai';
  if (method === 'GET' && /^\/v1beta\/openai\/models$/.test(path)) return 'models';
  return null;
}

function upstreamUrl(url, route) {
  const target = new URL(url.pathname, UPSTREAM);
  const allowed = route === 'models' ? new Set(['pageSize', 'pageToken']) : new Set(['alt']);
  for (const [name, value] of url.searchParams) {
    if (name === 'key') continue;
    if (!allowed.has(name) || url.searchParams.getAll(name).length !== 1 || value.length > 1024) {
      throw new RelayError(400, 'unsupported_query_parameter');
    }
    if (name === 'alt' && !['sse', 'json', 'media'].includes(value)) throw new RelayError(400, 'unsupported_alt');
    if (name === 'alt' && value === 'media' && !['download', 'file'].includes(route)) throw new RelayError(400, 'unsupported_alt');
    if (name === 'alt' && value === 'sse' && !url.pathname.endsWith(':streamGenerateContent')) throw new RelayError(400, 'unsupported_alt');
    if (name === 'pageSize' && !/^\d{1,4}$/.test(value)) throw new RelayError(400, 'unsupported_page_size');
    target.searchParams.set(name, value);
  }
  return target;
}

async function readLimited(stream, limit, signal) {
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  const onAbort = () => { reader.cancel().catch(() => {}); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) throw new RelayError(504, 'upstream_timeout');
      const { value, done } = await reader.read();
      if (signal?.aborted) throw new RelayError(504, 'upstream_timeout');
      if (done) break;
      size += value.byteLength;
      if (size > limit) { await reader.cancel(); throw new RelayError(413, 'payload_too_large'); }
      chunks.push(value);
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
    return result;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    reader.releaseLock();
  }
}

function redact(text, secrets) {
  for (const secret of secrets) if (secret) text = text.split(secret).join('[redacted]');
  return text;
}

export function sanitizeJson(value, relayOrigin, secrets, field = '') {
  if (Array.isArray(value)) return value.map(item => sanitizeJson(item, relayOrigin, secrets, field));
  if (value && typeof value === 'object') {
    const result = {};
    for (const [name, child] of Object.entries(value)) {
      if (/^(?:key|apiKey|api_key|authorization|x-goog-api-key)$/i.test(name)) result[name] = '[redacted]';
      else Object.defineProperty(result, name, { value: sanitizeJson(child, relayOrigin, secrets, name), enumerable: true });
    }
    return result;
  }
  if (typeof value !== 'string') return value;
  if (/^(?:uri|url|downloadUri|download_uri|fileUri|file_uri)$/i.test(field) && /^https?:\/\//i.test(value)) {
    try {
      const parsed = new URL(value);
      if (parsed.origin === UPSTREAM && ['download', 'file'].includes(routeFor(parsed.pathname, 'GET'))) {
        const rewritten = new URL(parsed.pathname, relayOrigin);
        if (parsed.searchParams.get('alt') === 'media') rewritten.searchParams.set('alt', 'media');
        return rewritten.href;
      }
      // Strip credential query parameters from any URL returned in metadata.
      for (const name of [...parsed.searchParams.keys()]) {
        if (/^(?:key|api_key|apikey|access_token)$/i.test(name)) parsed.searchParams.delete(name);
      }
      return redact(parsed.href, secrets);
    } catch { /* Non-URL model text is handled by exact secret redaction. */ }
  }
  return redact(value, secrets);
}

function responseHeaders(upstream, secrets) {
  const headers = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  for (const name of SAFE_RESPONSE_HEADERS) {
    const value = upstream.headers.get(name);
    if (value !== null) headers.set(name, redact(value, secrets));
  }
  return headers;
}

function streamResponse(upstream, headers, { controller, cleanup, secrets, limit, text }) {
  const reader = upstream.body?.getReader();
  const decoder = text ? new TextDecoder() : null;
  const reserve = Math.max(...secrets.map(secret => secret.length), 1) - 1;
  let pending = '';
  let size = 0;
  let closed = false;
  const stop = () => { if (!closed) { closed = true; cleanup(); } };
  const stream = new ReadableStream({
    async pull(output) {
      try {
        while (true) {
          if (controller.signal.aborted) throw new Error('upstream_timeout');
          const result = reader ? await reader.read() : { done: true };
          if (controller.signal.aborted) throw new Error('upstream_timeout');
          if (result.done) {
            if (text) { pending += decoder.decode(); if (pending) output.enqueue(ENCODER.encode(redact(pending, secrets))); }
            output.close(); stop(); return;
          }
          size += result.value.byteLength;
          if (size > limit) throw new Error('response_too_large');
          if (!text) { output.enqueue(result.value); return; }
          pending += decoder.decode(result.value, { stream: true });
          // Keep enough tail to detect a secret split over arbitrary network chunks.
          let end = Math.max(0, pending.length - reserve);
          for (const secret of secrets) {
            const start = pending.lastIndexOf(secret, end - 1);
            if (start >= 0 && start < end && start + secret.length > end) end = start;
          }
          if (end) { output.enqueue(ENCODER.encode(redact(pending.slice(0, end), secrets))); pending = pending.slice(end); return; }
        }
      } catch {
        controller.abort(); await reader?.cancel().catch(() => {}); stop();
        output.error(new Error('relay_stream_closed'));
      }
    },
    async cancel() { controller.abort(); await reader?.cancel().catch(() => {}); stop(); },
  });
  return new Response(stream, { status: upstream.status, headers });
}

export function createWorker(fetchImpl = fetch) {
  return {
    async fetch(request, env = {}) {
      let cleanup = () => {};
      try {
        const url = new URL(request.url);
        if (url.pathname === '/health' && request.method === 'GET' && !url.search) {
          return new Response('{"ok":true}', { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
        }
        // Fail closed until both independent secrets have been provisioned.
        if (typeof env.RELAY_API_KEY !== 'string' || env.RELAY_API_KEY.length < 32 ||
            typeof env.GEMINI_API_KEY !== 'string' || env.GEMINI_API_KEY.length < 16 ||
            env.RELAY_API_KEY === env.GEMINI_API_KEY) return responseError(503, 'relay_not_ready');
        await authenticate(request, url, env.RELAY_API_KEY);
        const origin = request.headers.get('origin');
        if (origin && origin !== url.origin) throw new RelayError(403, 'cross_origin_denied');
        const route = routeFor(url.pathname, request.method);
        if (!route) throw new RelayError(404, 'unsupported_endpoint');
        const target = upstreamUrl(url, route);
        if (env.RELAY_RATE_LIMITER) {
          try {
            const rate = await env.RELAY_RATE_LIMITER.limit({ key: 'authenticated-relay-client' });
            if (!rate.success) return new Response('{"error":{"code":"relay_rate_limited"}}', {
              status: 429, headers: { 'content-type': 'application/json', 'retry-after': '60', 'cache-control': 'no-store' },
            });
          } catch { throw new RelayError(503, 'rate_limiter_unavailable'); }
        }
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), integer(env.REQUEST_TIMEOUT_MS, 180000, 1000, 300000));
        const onAbort = () => controller.abort();
        request.signal.addEventListener('abort', onAbort, { once: true });
        if (request.signal.aborted) controller.abort();
        cleanup = () => { clearTimeout(timeout); request.signal.removeEventListener('abort', onAbort); };
        const headers = new Headers({ 'x-goog-api-key': env.GEMINI_API_KEY, accept: request.headers.get('accept') === 'text/event-stream' ? 'text/event-stream' : '*/*' });
        if (url.pathname.startsWith('/v1beta/openai/')) headers.set('authorization', `Bearer ${env.GEMINI_API_KEY}`);
        let body;
        if (request.method === 'POST') {
          const type = request.headers.get('content-type') || '';
          if (!/^application\/json(?:\s*;|$)/i.test(type)) throw new RelayError(415, 'json_required');
          const maximum = integer(env.MAX_BODY_BYTES, 8388608, 1024, 16777216);
          const declared = request.headers.get('content-length');
          if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > maximum)) throw new RelayError(413, 'payload_too_large');
          body = await readLimited(request.body, maximum, controller.signal);
          try { JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body)); }
          catch { throw new RelayError(400, 'invalid_json'); }
          headers.set('content-type', 'application/json');
        }
        if (route === 'download' || (route === 'file' && target.searchParams.get('alt') === 'media')) {
          const range = request.headers.get('range');
          if (range) {
            if (!/^bytes=\d+-\d*$/.test(range)) throw new RelayError(400, 'unsupported_range');
            headers.set('range', range);
          }
        }
        let upstream;
        try { upstream = await fetchImpl(target.href, { method: request.method, headers, body, redirect: 'manual', signal: controller.signal }); }
        catch { throw new RelayError(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'upstream_timeout' : 'upstream_unavailable'); }
        if (upstream.status >= 300 && upstream.status < 400) {
          await upstream.body?.cancel(); throw new RelayError(502, 'upstream_redirect_denied');
        }
        const secrets = [env.GEMINI_API_KEY, env.RELAY_API_KEY];
        const returnedHeaders = responseHeaders(upstream, secrets);
        const contentType = upstream.headers.get('content-type') || '';
        if (contentType.toLowerCase().includes('text/event-stream')) {
          return streamResponse(upstream, returnedHeaders, { controller, cleanup, secrets, limit: 33554432, text: true });
        }
        const isMedia = (route === 'download' || (route === 'file' && target.searchParams.get('alt') === 'media')) && upstream.ok && /^(?:video\/|audio\/|image\/|application\/octet-stream\b)/i.test(contentType);
        if (isMedia) {
          const maximum = integer(env.MAX_DOWNLOAD_BYTES, 67108864, 1024, 268435456);
          const length = Number(upstream.headers.get('content-length'));
          if (Number.isFinite(length) && length > maximum) { await upstream.body?.cancel(); throw new RelayError(502, 'response_too_large'); }
          return streamResponse(upstream, returnedHeaders, { controller, cleanup, secrets, limit: maximum, text: false });
        }
        const maximum = integer(env.MAX_JSON_BYTES, 16777216, 1024, 33554432);
        let bytes;
        try { bytes = await readLimited(upstream.body, maximum, controller.signal); }
        catch (error) { throw new RelayError(error.status === 413 ? 502 : (error.status || 502), error.status === 413 ? 'response_too_large' : 'upstream_timeout'); }
        cleanup();
        let json;
        try { json = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
        catch { throw new RelayError(502, 'invalid_upstream_response'); }
        returnedHeaders.set('content-type', 'application/json; charset=utf-8');
        return new Response(JSON.stringify(sanitizeJson(json, url.origin, secrets)), { status: upstream.status, headers: returnedHeaders });
      } catch (error) {
        cleanup();
        return responseError(error instanceof RelayError ? error.status : 502, error instanceof RelayError ? error.code : 'relay_failure');
      }
    },
  };
}

export default createWorker();
