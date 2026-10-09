import test from 'node:test';
import assert from 'node:assert/strict';
import { createWorker, routeFor, sanitizeJson } from '../src/worker.mjs';

const RELAY = 'relay_test_secret_0123456789_abcdefghijklmnopqrstuvwxyz';
const GOOGLE = 'google_test_secret_abcdefghijklmnopqrstuvwxyz';
const env = { RELAY_API_KEY: RELAY, GEMINI_API_KEY: GOOGLE };
const BASE = 'https://relay.example.test';
const PATH = '/v1beta/models/gemini-test:generateContent';
const json = (value, init = {}) => new Response(JSON.stringify(value), { ...init, headers: { 'content-type': 'application/json', ...init.headers } });
function req(path = PATH, options = {}) {
  const { method = 'POST', headers = {}, body = { contents: [{ parts: [{ text: 'hello' }] }] } } = options;
  return new Request(BASE + path, { method, headers: { authorization: `Bearer ${RELAY}`, ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers }, ...(method === 'POST' ? { body: typeof body === 'string' ? body : JSON.stringify(body) } : {}) });
}
function fixture(responder = () => json({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })) {
  const calls = [];
  const worker = createWorker(async (url, options) => { calls.push({ url, options }); return responder(url, options); });
  return { calls, worker };
}

test('health contains no keys or setup details and does not call upstream', async () => {
  const { worker, calls } = fixture();
  const response = await worker.fetch(new Request(BASE + '/health'), {});
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true });
  assert.equal(calls.length, 0);
});

test('fails closed without independent secrets', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req(), {})).status, 503);
  assert.equal((await worker.fetch(req(), { ...env, GEMINI_API_KEY: RELAY })).status, 503);
  assert.equal(calls.length, 0);
});

test('unauthenticated, invalid and conflicting authentication never reaches upstream', async () => {
  const { worker, calls } = fixture();
  const inputs = [
    new Request(BASE + '/v1beta/models'),
    req(PATH, { headers: { authorization: 'Bearer wrong' } }),
    req(PATH, { headers: { 'x-goog-api-key': GOOGLE } }),
    req(PATH + '?key=' + GOOGLE),
    req(PATH, { headers: { authorization: `Bearer ${RELAY}, Bearer ${RELAY}` } }),
  ];
  for (const request of inputs) assert.equal((await worker.fetch(request, env)).status, 401);
  assert.equal(calls.length, 0);
});

test('header and query authentication supported; client key is removed completely', async () => {
  for (const type of ['bearer', 'header', 'query']) {
    const { worker, calls } = fixture();
    const request = type === 'bearer' ? req() : new Request(BASE + PATH + (type === 'query' ? '?key=' + RELAY : ''), {
      method: 'POST', headers: { 'content-type': 'application/json', ...(type === 'header' ? { 'x-goog-api-key': RELAY } : {}), cookie: 'session=private', 'x-forwarded-host': 'evil.test', 'cf-access-client-secret': 'private' }, body: '{}',
    });
    assert.equal((await worker.fetch(request, env)).status, 200);
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com' + PATH);
    assert.equal(calls[0].options.headers.get('x-goog-api-key'), GOOGLE);
    assert.equal(calls[0].options.headers.get('authorization'), null);
    assert.equal(calls[0].options.headers.get('cookie'), null);
    assert.equal(calls[0].options.headers.get('x-forwarded-host'), null);
    assert.equal(calls[0].options.headers.get('cf-access-client-secret'), null);
    assert.equal(calls[0].options.redirect, 'manual');
    assert(!calls[0].url.includes(RELAY));
  }
});

test('only intended path and method allowlist accepted', () => {
  const allowed = [
    ['/v1beta/models', 'GET'], ['/v1/models/gemini-2.5-flash', 'GET'],
    [PATH, 'POST'], ['/v1beta/models/gemini-test:streamGenerateContent', 'POST'],
    ['/v1beta/models/gemini-test:countTokens', 'POST'], ['/v1beta/models/imagen-test:predict', 'POST'],
    ['/v1beta/models/veo-test:predictLongRunning', 'POST'],
    ['/v1beta/models/veo-test/operations/job_1', 'GET'], ['/v1beta/operations/job-2', 'GET'],
    ['/v1beta/files/video_1:download', 'GET'], ['/v1beta/files/video_1', 'GET'],
    ['/v1beta/openai/chat/completions', 'POST'], ['/v1beta/openai/images/generations', 'POST'],
  ];
  for (const [path, method] of allowed) assert(routeFor(path, method), path);
  const blocked = [
    ['/v1beta/files', 'GET'], ['/upload/v1beta/files', 'POST'], ['/v1beta/files/a', 'DELETE'],
    ['/v1beta/models', 'POST'], ['/v1beta/models/a:batchGenerateContent', 'POST'],
    ['/v1beta/models/gemini%2ftest:generateContent', 'POST'],
    ['/v1beta/models//a:generateContent', 'POST'], ['/v1beta/models/a\\b:generateContent', 'POST'],
    ['/https://evil.test/path', 'GET'], ['//evil.test/path', 'GET'], ['/v1beta/models/a?evil', 'POST'],
    ['/v1beta/models/a:createTunedModel', 'POST'], ['/v1beta/models/a:generateContent', 'DELETE'],
  ];
  for (const [path, method] of blocked) assert.equal(routeFor(path, method), null, path);
});

test('SSRF query parameters and duplicate/invalid query cannot trigger an upstream request', async () => {
  const { worker, calls } = fixture();
  for (const query of [
    '?url=https://evil.test', '?target=https://evil.test', '?alt=media', '?alt=sse',
    '?alt=json&alt=json', '?key=' + RELAY + '&key=' + RELAY,
    '?%6bey=' + RELAY + '&key=' + RELAY, '?api_key=' + GOOGLE,
  ]) assert.equal((await worker.fetch(req(PATH + query), env)).status, 400, query);
  assert.equal(calls.length, 0);
});

test('valid model list pagination and SSE query forwarded without auth query', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req('/v1beta/models?pageSize=50&pageToken=abc%2Bdef', { method: 'GET' }), env)).status, 200);
  assert.equal(new URL(calls[0].url).searchParams.get('pageToken'), 'abc+def');
  assert.equal((await worker.fetch(req('/v1beta/models/gemini-test:streamGenerateContent?alt=sse'), env)).status, 200);
  assert.equal(new URL(calls[1].url).searchParams.get('alt'), 'sse');
});

test('OpenAI compatibility sends a new upstream bearer credential', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req('/v1beta/openai/images/generations'), env)).status, 200);
  assert.equal(calls[0].options.headers.get('authorization'), `Bearer ${GOOGLE}`);
});

test('cross-origin browser calls and preflights are rejected without wildcard CORS', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req(PATH, { headers: { origin: 'https://evil.test' } }), env)).status, 403);
  const preflight = await worker.fetch(req(PATH, { method: 'OPTIONS' }), env);
  assert.equal(preflight.status, 404);
  assert.equal(preflight.headers.get('access-control-allow-origin'), null);
  assert.equal(calls.length, 0);
});

test('invalid body, non JSON and oversized declared/chunked body fail before upstream', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req(PATH, { body: 'no json' }), env)).status, 400);
  assert.equal((await worker.fetch(req(PATH, { headers: { 'content-type': 'text/plain' } }), env)).status, 415);
  assert.equal((await worker.fetch(req(PATH, { headers: { 'content-length': '99999' } }), { ...env, MAX_BODY_BYTES: '1024' })).status, 413);
  assert.equal((await worker.fetch(req(PATH, { body: { data: 'x'.repeat(1024) } }), { ...env, MAX_BODY_BYTES: '1024' })).status, 413);
  assert.equal(calls.length, 0);
});

test('upstream redirect denied and does not disclose location', async () => {
  const { worker, calls } = fixture(() => new Response(null, { status: 302, headers: { location: 'https://evil.test/?key=' + GOOGLE } }));
  const response = await worker.fetch(req(), env);
  assert.equal(response.status, 502);
  assert.equal(response.headers.get('location'), null);
  assert(!JSON.stringify(await response.json()).includes(GOOGLE));
  assert.equal(calls.length, 1);
});

test('429 and Retry-After survive; sensitive and unnecessary upstream headers removed', async () => {
  const { worker } = fixture(() => json({ error: { message: 'quota exceeded' } }, { status: 429, headers: {
    'retry-after': '12', 'set-cookie': 'private=1', 'x-goog-api-key': GOOGLE, 'authorization': GOOGLE, location: 'https://evil.test', 'access-control-allow-origin': '*',
  } }));
  const response = await worker.fetch(req(), env);
  assert.equal(response.status, 429);
  assert.equal(response.headers.get('retry-after'), '12');
  for (const name of ['set-cookie', 'x-goog-api-key', 'authorization', 'location', 'access-control-allow-origin']) assert.equal(response.headers.get(name), null);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('upstream errors and metadata cannot echo either secret', async () => {
  const { worker } = fixture(() => json({ error: { message: `bad ${GOOGLE} and ${RELAY}`, api_key: GOOGLE }, authorization: RELAY }, { status: 403 }));
  const response = await worker.fetch(req(), env);
  assert.equal(response.status, 403);
  const text = await response.text();
  assert(!text.includes(GOOGLE)); assert(!text.includes(RELAY)); assert(text.includes('[redacted]'));
});

test('official video download URI rewritten to this relay, with only safe media query', async () => {
  const uri = 'https://generativelanguage.googleapis.com/v1beta/files/video-1:download?alt=media&key=' + GOOGLE + '&other=private';
  const { worker } = fixture(() => json({ done: true, response: { generateVideoResponse: { generatedSamples: [{ video: { uri } }] } } }));
  const response = await worker.fetch(req('/v1beta/models/veo-test/operations/job1', { method: 'GET' }), env);
  assert.equal((await response.json()).response.generateVideoResponse.generatedSamples[0].video.uri, BASE + '/v1beta/files/video-1:download?alt=media');
});

test('metadata URLs do not turn into arbitrary proxy endpoints or disclose query credentials', () => {
  const output = sanitizeJson({ url: `https://evil.test/private?key=${GOOGLE}&token=123`, uri: `https://generativelanguage.googleapis.com.evil.test/v1beta/files/a:download?key=${GOOGLE}` }, BASE, [GOOGLE, RELAY]);
  assert.equal(output.url, 'https://evil.test/private?token=123');
  assert.equal(output.uri, 'https://generativelanguage.googleapis.com.evil.test/v1beta/files/a:download');
  assert(!output.uri.startsWith(BASE));
});

test('prototype-shaped upstream JSON cannot mutate response objects', () => {
  const output = sanitizeJson(JSON.parse('{"__proto__":{"polluted":true},"good":1}'), BASE, [GOOGLE, RELAY]);
  assert.equal(Object.getPrototypeOf(output), Object.prototype);
  assert.equal({}.polluted, undefined);
  assert.equal(JSON.parse(JSON.stringify(output)).__proto__.polluted, true);
});

test('SSE streams preserve content and redact a credential split over network chunks', async () => {
  const original = `data: {"text":"hello"}\n\ndata: {"error":"${GOOGLE}"}\n\ndata: [DONE]\n\n`;
  const bytes = new TextEncoder().encode(original);
  const { worker } = fixture(() => new Response(new ReadableStream({
    start(controller) { for (let i = 0; i < bytes.length; i += 7) controller.enqueue(bytes.slice(i, i + 7)); controller.close(); },
  }), { headers: { 'content-type': 'text/event-stream' } }));
  const response = await worker.fetch(req('/v1beta/models/gemini-test:streamGenerateContent?alt=sse'), env);
  assert.equal(response.headers.get('content-type'), 'text/event-stream');
  assert.equal(await response.text(), original.replace(GOOGLE, '[redacted]'));
});

test('binary download preserves bytes and forwards only a validated single Range', async () => {
  const bytes = new Uint8Array([0, 1, 255, 16, 0, 78]);
  const { worker, calls } = fixture(() => new Response(bytes, { status: 206, headers: { 'content-type': 'video/mp4', 'content-range': 'bytes 0-5/6' } }));
  const response = await worker.fetch(req('/v1beta/files/video1:download?alt=media', { method: 'GET', headers: { range: 'bytes=0-5' } }), env);
  assert.equal(response.status, 206);
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  assert.equal(calls[0].options.headers.get('range'), 'bytes=0-5');
  assert.equal((await worker.fetch(req('/v1beta/files/video1:download', { method: 'GET', headers: { range: 'bytes=0-1,3-4' } }), env)).status, 400);
});

test('oversized upstream JSON and download are bounded', async () => {
  const first = fixture(() => json({ data: 'x'.repeat(2048) }));
  assert.equal((await first.worker.fetch(req(), { ...env, MAX_JSON_BYTES: '1024' })).status, 502);
  const second = fixture(() => new Response(new Uint8Array(2048), { headers: { 'content-type': 'video/mp4', 'content-length': '2048' } }));
  assert.equal((await second.worker.fetch(req('/v1beta/files/a:download', { method: 'GET' }), { ...env, MAX_DOWNLOAD_BYTES: '1024' })).status, 502);
});

test('invalid upstream HTML is replaced with safe generic error', async () => {
  const { worker } = fixture(() => new Response(`<html>${GOOGLE}</html>`, { status: 502, headers: { 'content-type': 'text/html' } }));
  const response = await worker.fetch(req(), env);
  assert.equal(response.status, 502);
  assert.equal((await response.json()).error.code, 'invalid_upstream_response');
});

test('network exceptions and timeouts expose no upstream diagnostic/credential', async () => {
  const errorCase = fixture(() => { throw new Error('private ' + GOOGLE); });
  assert.equal((await errorCase.worker.fetch(req(), env)).status, 502);
  const timeoutCase = fixture((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })));
  const response = await timeoutCase.worker.fetch(req(), { ...env, REQUEST_TIMEOUT_MS: '1000' });
  assert.equal(response.status, 504);
  assert.equal((await response.json()).error.code, 'upstream_timeout');
});

test('optional rate limiter rejects exhausted budget and fails closed on binding error', async () => {
  const { worker, calls } = fixture();
  assert.equal((await worker.fetch(req(), { ...env, RELAY_RATE_LIMITER: { limit: async ({ key }) => { assert.equal(key, 'authenticated-relay-client'); return { success: false }; } } })).status, 429);
  assert.equal((await worker.fetch(req(), { ...env, RELAY_RATE_LIMITER: { limit: async () => { throw new Error('unavailable'); } } })).status, 503);
  assert.equal(calls.length, 0);
});
