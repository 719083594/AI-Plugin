import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { AIClient } from '../src/core/client.mjs';
import { ImageStore } from '../src/media/index.mjs';
import { Storage } from '../src/core/storage.mjs';
import { defaults, merge, writeJson } from '../src/core/config.mjs';
import { startManagement } from '../src/management/server.mjs';
import { withBudget, closeHttpServer } from './helpers/resources.mjs';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const ownerToken = 'owner-test-token';
const reply = text => ({ contents: [{ type: 'text', text }], toolCalls: [], usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 } });
const makeConfig = extra => merge(defaults, merge({
  channels: [{ id: 'model-a', type: 'openai', baseUrl: 'https://model.invalid/v1', apiKey: 'model-test-secret', models: ['fake-model'], enabled: true }],
  presets: [{ ...structuredClone(defaults.presets[0]), model: 'fake-model', tools: [], systemPrompt: '测试助手的系统规则' }],
  management: { apiToken: ownerToken }, tools: { searchToken: 'search-test-secret' }
}, extra || {}));

async function fixture(t, { config = makeConfig(), provider = async () => reply('模拟回答'), options = {} } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-management-test-'));
  let client, management, storage;
  t.after(async () => {
    try { if (management) await closeHttpServer(management.server, () => management.close()); }
    finally {
      try { if (client) client.close(); else storage?.close(); }
      finally {
        const resolved = path.resolve(root);
        assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
        assert.ok(path.basename(resolved).startsWith('ai-plugin-management-test-'));
        await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    }
  });
  for (const file of ['capabilities.json', 'orangejuice.plugin.json', 'web/index.html', 'web/app.js', 'web/app.css']) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.copyFile(path.join(sourceRoot, file), path.join(root, file));
  }
  const configFile = path.join(root, 'config', 'local.json');
  writeJson(configFile, config);
  storage = new Storage(path.join(root, 'data', 'ai.db'));
  client = new AIClient({ root, configFile, storage, provider, imageStore: new ImageStore({ directory: path.join(root, 'data/images') }) });
  management = startManagement(client, { host: '127.0.0.1', port: 0, ...options });
  const address = await withBudget(management.ready, 5000, 'HTTP fixture startup'), base = `http://127.0.0.1:${address.port}`;
  management.settings.publicUrl = base;
  const call = async (route, { method = 'GET', cookie, csrf, token, origin, headers = {}, value, raw } = {}) => {
    const requestHeaders = { ...headers };
    if (cookie) requestHeaders.cookie = cookie;
    if (csrf) requestHeaders['x-ai-csrf'] = csrf;
    if (token !== undefined) requestHeaders.authorization = 'Bearer ' + token;
    if (origin) requestHeaders.origin = origin;
    if (value !== undefined) requestHeaders['content-type'] = 'application/json';
    const response = await fetch(new URL(route, base), { method, headers: requestHeaders, body: raw ?? (value !== undefined ? JSON.stringify(value) : undefined), redirect: 'manual', signal: AbortSignal.timeout(5000) });
    const text = await withBudget(response.text(), 5000, 'HTTP fixture response');
    const data = text && response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null;
    return { response, status: response.status, text, data };
  };
  const login = async () => {
    const link = new URL(management.ticket());
    const result = await call(link.pathname + link.search);
    assert.equal(result.status, 302);
    const setCookie = result.response.headers.get('set-cookie'), cookie = setCookie.split(';')[0];
    const session = await call('/api/session', { cookie });
    assert.equal(session.status, 200);
    return { cookie, csrf: session.data.csrf, setCookie };
  };
  return { root, configFile, client, storage, management, base, call, login };
}

test('private APIs require authentication while public health and UI disclose no credentials', async t => {
  const { call } = await fixture(t);
  for (const route of ['/api/config', '/api/users', '/api/logs', '/v1/models', '/api/ai-plugin/config']) {
    const result = await call(route);
    assert.equal(result.status, 401, route); assert.match(result.data.error, /主人|登录/);
  }
  assert.equal((await call('/api/config', { token: 'wrong-token' })).status, 401);
  assert.equal((await call('/api/config', { token: 'é'.repeat(ownerToken.length) })).status, 401);
  const health = await call('/health');
  assert.equal(health.status, 200); assert.equal(health.data.name, 'AI-Plugin');
  assert.doesNotMatch(health.text, /model-test-secret|search-test-secret|owner-test-token/);
  const page = await call('/');
  assert.equal(page.status, 200); assert.match(page.text, /AI|管理/);
  assert.doesNotMatch(page.text, /model-test-secret|search-test-secret|owner-test-token/);
  assert.equal(page.response.headers.get('x-frame-options'), 'DENY');
  assert.equal(page.response.headers.get('referrer-policy'), 'no-referrer');
  assert.match(page.response.headers.get('content-security-policy'), /frame-ancestors 'none'/);
});

test('login tickets are single-use and create a protected owner session', async t => {
  const { management, call } = await fixture(t);
  const link = new URL(management.ticket()), route = link.pathname + link.search;
  const first = await call(route);
  assert.equal(first.status, 302); assert.equal(first.response.headers.get('location'), '/');
  const cookie = first.response.headers.get('set-cookie');
  assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/);
  assert.equal((await call(route)).status, 401);
  const session = await call('/api/session', { cookie: cookie.split(';')[0] });
  assert.equal(session.status, 200); assert.equal(session.data.role, 'owner');
  assert.match(session.data.csrf, /^[\w-]{20,}$/);
  assert.doesNotMatch(JSON.stringify(session.data), /owner-test-token/);
});

test('expired login tickets and expired sessions cannot authenticate', async t => {
  const { management, call } = await fixture(t, { options: { ticketSeconds: 0.02, sessionSeconds: 0.03 } });
  const expired = new URL(management.ticket());
  await delay(35);
  assert.equal((await call(expired.pathname + expired.search)).status, 401);
  const fresh = new URL(management.ticket()), logged = await call(fresh.pathname + fresh.search);
  assert.equal(logged.status, 302);
  const cookie = logged.response.headers.get('set-cookie').split(';')[0];
  await delay(45);
  assert.equal((await call('/api/session', { cookie })).status, 401);
});

test('cookie writes require CSRF and allowed Origin, including a forged Host/Origin pair', async t => {
  const { call, login, base } = await fixture(t), session = await login();
  const value = { userId: 'web-owner' };
  assert.equal((await call('/api/reset', { method: 'POST', cookie: session.cookie, value })).status, 403);
  assert.equal((await call('/api/reset', { method: 'POST', cookie: session.cookie, csrf: 'invalid', value })).status, 403);
  assert.equal((await call('/api/reset', { method: 'POST', ...session, origin: 'https://evil.invalid', value })).status, 403);
  assert.equal((await call('/api/reset', { method: 'POST', ...session, origin: 'http://evil.invalid', headers: { host: 'evil.invalid' }, value })).status, 403);
  assert.equal((await call('/api/reset', { method: 'POST', ...session, origin: base, value })).status, 200);
  assert.equal((await call('/api/ticket', { method: 'POST', ...session, origin: base, value: {} })).status, 403);
});

test('configured owner API token can use APIs and mint tickets without a browser session', async t => {
  const { call } = await fixture(t);
  const authenticated = await call('/api/session', { token: ownerToken });
  assert.equal(authenticated.status, 200); assert.deepEqual(authenticated.data, { role: 'owner', csrf: null });
  const ticket = await call('/api/ai-plugin/ticket', { token: ownerToken, method: 'POST', value: {} });
  assert.equal(ticket.status, 200); assert.match(new URL(ticket.data.url).pathname, /^\/login$/);
  const config = await call('/api/config', { token: ownerToken });
  assert.equal(config.status, 200); assert.doesNotMatch(config.text, /model-test-secret|search-test-secret|owner-test-token/);
  assert.equal((await call('/api/reset', { token: ownerToken, method: 'POST', value: { userId: 'web-owner' } })).status, 200);
});

test('configuration saves reject stale revisions and preserve array secrets by stable IDs', async t => {
  const config = makeConfig({ channels: [
    { id: 'a', type: 'openai', apiKey: 'private-a-secret', models: ['fake-model'] },
    { id: 'b', type: 'claude', apiKey: 'private-b-secret', models: ['fake-model'] }
  ] });
  const { call, client } = await fixture(t, { config });
  const before = await call('/api/config', { token: ownerToken });
  const edited = structuredClone(before.data.value); edited.channels.reverse(); edited.channels[0].name = '第二渠道改名';
  const saved = await call('/api/config', { token: ownerToken, method: 'PUT', value: { revision: before.data.revision, value: edited } });
  assert.equal(saved.status, 200); assert.notEqual(saved.data.revision, before.data.revision);
  assert.equal(client.config().channels[0].id, 'b'); assert.equal(client.config().channels[0].apiKey, 'private-b-secret');
  assert.equal(client.config().channels[1].apiKey, 'private-a-secret');
  assert.equal(client.config().tools.searchToken, 'search-test-secret');
  assert.doesNotMatch(saved.text, /private-a-secret|private-b-secret|search-test-secret|owner-test-token/);
  const stale = await call('/api/config', { token: ownerToken, method: 'PUT', value: { revision: before.data.revision, value: before.data.value } });
  assert.equal(stale.status, 409); assert.match(stale.data.error, /修改|重新加载/);
  assert.equal(client.config().channels[0].name, '第二渠道改名');
});

test('new masked channel credentials are rejected without saving or creating a backup', async t => {
  const { call, client, root } = await fixture(t);
  const before = await call('/api/config', { token: ownerToken });
  const value = structuredClone(before.data.value);
  value.channels.push({ id: 'new', type: 'openai', models: [], apiKey: '••••••••' });
  const refused = await call('/api/config', { token: ownerToken, method: 'PUT', value: { revision: before.data.revision, value } });
  assert.equal(refused.status, 400); assert.match(refused.data.error, /重新填写/);
  assert.equal(client.config().channels.length, 1);
  await assert.rejects(fs.stat(path.join(root, 'backups')), { code: 'ENOENT' });
});

test('config save automatically creates a valid consistent SQLite backup of the previous data and config', async t => {
  const { call, root, storage } = await fixture(t);
  const chat = await call('/api/chat', { token: ownerToken, method: 'POST', value: { text: '备份前的聊天' } });
  assert.equal(chat.status, 200); assert.equal(storage.stats().history, 2);
  const before = await call('/api/config', { token: ownerToken });
  const value = structuredClone(before.data.value); value.basic.debug = true;
  const saved = await call('/api/config', { token: ownerToken, method: 'PUT', value: { revision: before.data.revision, value } });
  assert.equal(saved.status, 200);
  const dirs = await fs.readdir(path.join(root, 'backups')); assert.equal(dirs.length, 1);
  const directory = path.join(root, 'backups', dirs[0]), file = path.join(directory, 'ai.db');
  const bytes = await fs.readFile(file); assert.equal(bytes.subarray(0, 16).toString(), 'SQLite format 3\u0000');
  const backup = new Storage(file);
  try {
    assert.equal(backup.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
    assert.equal(backup.stats().history, 2);
    const user = backup.state('web-owner'); assert.equal(backup.history(user.current.conversationId).length, 2);
  } finally { backup.close(); }
  const oldConfig = JSON.parse(await fs.readFile(path.join(directory, 'config.json'), 'utf8'));
  assert.equal(oldConfig.basic.debug, false); assert.equal(oldConfig.channels[0].apiKey, 'model-test-secret');
});

test('OpenAI compatibility accepts complete client history and keeps transient API sessions separate', async t => {
  const captured = [];
  const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII=';
  const config = makeConfig({ channels: [{ id: 'model-a', type: 'openai', models: [{ name: 'fake-model', features: ['chat', 'vision'] }] }] });
  const { call, storage } = await fixture(t, { config, provider: async request => { captured.push(structuredClone(request.messages)); return reply('模拟结果'); } });
  await call('/api/chat', { token: ownerToken, method: 'POST', value: { text: '网页个人聊天' } });
  const original = structuredClone(storage.state('web-owner'));
  const messages = [
    { role: 'system', content: '客户端自己的规则' },
    { role: 'user', content: '客户端第一问' },
    { role: 'assistant', content: '客户端先前回答' },
    { role: 'user', content: [{ type: 'text', text: '客户端第二问' }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + png } }] }
  ];
  const first = await call('/v1/chat/completions', { token: ownerToken, method: 'POST', value: { model: 'fake-model', messages, stream: false } });
  assert.equal(first.status, 200); assert.equal(first.data.object, 'chat.completion');
  assert.equal(first.data.choices[0].message.content, '模拟结果');
  assert.deepEqual(first.data.usage, { prompt_tokens: 2, completion_tokens: 3, total_tokens: 5 });
  const normalized = captured[1].slice(-4);
  assert.deepEqual(normalized.map(row => row.role), ['system', 'user', 'assistant', 'user']);
  assert.equal(normalized[0].content[0].text, '客户端自己的规则');
  assert.equal(normalized[2].content[0].text, '客户端先前回答');
  assert.equal(normalized[3].content[1].type, 'image');
  assert.equal(normalized[3].content[1].data, png);
  const second = await call('/v1/chat/completions', { token: ownerToken, method: 'POST', value: { model: 'default', messages: [{ role: 'user', content: '另一个客户端的新问题' }] } });
  assert.equal(second.status, 200); assert.doesNotMatch(JSON.stringify(captured[2]), /客户端第一问|客户端先前回答|网页个人聊天/);
  assert.deepEqual(storage.state('web-owner'), original);
  assert.equal(storage.stats().history, 2);
  assert.equal(storage.users().some(row => row.id === 'api-owner'), false);
  assert.equal((await call('/v1/chat/completions', { token: ownerToken, method: 'POST', value: { model: 'fake-model', messages, stream: true } })).status, 400);
});

test('authenticated statistics, users, history and backup APIs reflect actual stored records', async t => {
  const { call, storage } = await fixture(t);
  await call('/api/chat', { token: ownerToken, method: 'POST', value: { text: '统计测试' } });
  const health = await call('/api/ai-plugin/health', { token: ownerToken });
  assert.equal(health.status, 200); assert.equal(health.data.storage.history, 2); assert.equal(health.data.queued, 0);
  const logs = await call('/api/logs?limit=5', { token: ownerToken });
  assert.equal(logs.data.records.length, 1); assert.equal(logs.data.records[0].success, true);
  assert.equal(logs.data.stats.history, 2);
  const users = await call('/api/users', { token: ownerToken });
  assert.equal(users.data.length, 1); assert.equal(users.data[0].id, 'web-owner');
  const state = storage.state('web-owner'), history = await call('/api/history?conversationId=' + state.current.conversationId, { token: ownerToken });
  assert.deepEqual(history.data.map(row => row.role), ['user', 'assistant']);
  const backup = await call('/api/backup', { token: ownerToken, method: 'POST', value: {} });
  assert.equal(backup.status, 200); assert.match(backup.data.message, /备份/);
  assert.doesNotMatch(JSON.stringify([health.data, logs.data, users.data]), /model-test-secret|search-test-secret|owner-test-token/);
});

test('capability API serves the real Chinese catalog and distinguishes planned functions from implemented ones', async t => {
  const { call } = await fixture(t);
  const source = JSON.parse(await fs.readFile(path.join(sourceRoot, 'capabilities.json'), 'utf8'));
  const capabilities = await call('/api/capabilities', { token: ownerToken });
  assert.equal(capabilities.status, 200); assert.deepEqual(capabilities.data, source);
  assert.ok(Array.isArray(source.capabilities));
  const ids = new Set(source.capabilities.map(item => item.id)); assert.equal(ids.size, source.capabilities.length);
  for (const item of source.capabilities) {
    assert.match(item.title || item.name, /[\u4e00-\u9fff]/);
    assert.ok(['implemented', 'planned'].includes(item.status), item.id);
    assert.ok(item.description); assert.ok(item.reason);
  }
  assert.ok(source.capabilities.some(item => item.status === 'planned'));
  assert.ok(source.capabilities.some(item => item.status === 'implemented'));
  const config = await call('/api/config', { token: ownerToken });
  assert.ok(config.data.schema.length > 0);
  for (const field of config.data.schema) assert.match(field.label, /[\u4e00-\u9fff]/, field.key);
  for (const field of config.data.schema.filter(item => item.status === 'planned')) assert.equal(field.readonly, true);
});

test('malformed authenticated requests return bounded errors without echoing credentials', async t => {
  const { call } = await fixture(t);
  const malformed = await call('/api/config', { token: ownerToken, method: 'PUT', headers: { 'content-type': 'application/json' }, raw: '{"secret":"model-test-secret search-test-secret owner-test-token" invalid' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(malformed.text, /model-test-secret|search-test-secret|owner-test-token/);
  assert.ok(malformed.text.length < 1000);
  assert.equal((await call('/api/does-not-exist', { token: ownerToken })).status, 404);
});

test('owner-only immediate history cleanup clears turns and group context while preserving role and memory', async t => {
  const { call, storage } = await fixture(t);
  await call('/api/chat', { token: ownerToken, method: 'POST', value: { text: '要清理的对话' } });
  storage.addMemory('user', 'web-owner', '保留这条手工记忆');
  storage.appendGroup('group', {id:'m',text:'清理群上下文'});
  assert.equal((await call('/api/history/clear', { method: 'POST', value: {} })).status,401);
  assert.equal(storage.stats().history,2);
  const result=await call('/api/history/clear', { token: ownerToken, method: 'POST', value: {} });
  assert.equal(result.status,200);assert.equal(result.data.history,2);assert.equal(result.data.groups,1);
  assert.equal(storage.stats().history,0);assert.equal(storage.stats().memories,1);
});
