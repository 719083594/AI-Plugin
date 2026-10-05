import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AIClient, accessAllowed, selectChannel } from '../src/core/client.mjs';
import { defaults, merge, mask, restoreSecrets, readConfig, writeJson } from '../src/core/config.mjs';
import { Storage } from '../src/core/storage.mjs';
import { Queue } from '../src/core/queue.mjs';
import { ToolRegistry } from '../src/tools/index.mjs';
import { ImageStore } from '../src/media/index.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII=';
const input = extra => ({ userId: '10001', botId: '20001', text: '你好', ...extra });
const answer = (text = '回复', extra = {}) => ({ contents: [{ type: 'text', text }], toolCalls: [], usage: { inputTokens: 2, outputTokens: 3, totalTokens: 5 }, ...extra });
const toolCall = (name, args, id = 'call-1') => ({ id, name, arguments: args });
const clone = value => structuredClone(value);
const makeConfig = extra => merge(defaults, merge({
  channels: [{ id: 'test', type: 'openai', baseUrl: 'https://provider.invalid/v1', apiKey: 'test-model-secret', models: ['fake-model'], enabled: true }],
  presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', systemPrompt: '测试系统规则', tools: [] }],
  management: { enabled: false }
}, extra || {}));

function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function abortableWait(signal) {
  return new Promise((_resolve, reject) => {
    if (signal.aborted) reject(signal.reason);
    else signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}
async function within(promise, milliseconds = 500) {
  const stop = new AbortController();
  try {
    return await Promise.race([promise, delay(milliseconds, undefined, { signal: stop.signal }).then(() => { throw new Error('test operation did not settle within its budget'); })]);
  } finally { stop.abort(); }
}
async function temporaryRoot(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-core-test-'));
  t.after(async () => {
    const resolved = path.resolve(root);
    assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
    assert.ok(path.basename(resolved).startsWith('ai-plugin-core-test-'));
    await fs.rm(resolved, { recursive: true, force: true });
  });
  return root;
}
function fixture(t, { config = makeConfig(), provider = async () => answer(), storage = new Storage(), imageStore = { cleanup: async () => 0 }, ...options } = {}) {
  const client = new AIClient({ config: () => config, provider, storage, imageStore, ...options });
  t.after(() => client.close());
  return { client, config, storage };
}
const history = (client, storage, who = input()) => {
  const state = storage.state(client.userKey(who));
  return storage.history(state.current.conversationId, 100, state.current.messageId);
};

test('successful turns persist across restart and preserve model history order', async t => {
  const root = await temporaryRoot(t), filename = path.join(root, 'data', 'conversation.db');
  const config = makeConfig();
  const firstStorage = new Storage(filename);
  const first = new AIClient({ root, config: () => config, storage: firstStorage, imageStore: {}, provider: async () => answer('第一条回复') });
  let sent = 0;
  try {
    await first.chat(input({ text: '第一条问题' }), { send: async () => { sent++; return { delivered: true }; } });
    assert.equal(sent, 1);
  } finally { first.close(); }
  const captured = [], storage = new Storage(filename);
  const client = new AIClient({ root, config: () => config, storage, imageStore: {}, provider: async request => { captured.push(clone(request.messages)); return answer('第二条回复'); } });
  try {
    await client.chat(input({ text: '第二条问题' }));
    assert.deepEqual(captured[0].map(row => row.role), ['system', 'user', 'assistant', 'user']);
    assert.equal(captured[0][1].content[0].text, '第一条问题');
    assert.equal(captured[0][2].content[0].text, '第一条回复');
    assert.deepEqual(history(client, storage).map(row => row.content[0].text), ['第一条问题', '第一条回复', '第二条问题', '第二条回复']);
    assert.equal(storage.logs().filter(row => row.success === true).length, 2);
  } finally { client.close(); }
});

test('failed delivery never advances current history or stores an unsent answer', async t => {
  const { client, storage } = fixture(t, { config: makeConfig({ security: { maxRequestsPerWindow: 100 } }) });
  await client.chat(input({ text: '已发送问题' }), { send: async () => true });
  const before = clone(storage.state(client.userKey(input())));
  const receipts = [false, { discarded: true }, { delivered: false }, { error: 'send failed' }, { retcode: 1200 }, { status: 'failed' }];
  for (const receipt of receipts) {
    await assert.rejects(client.chat(input({ text: '未发送问题' }), { send: async () => receipt }), /发送|回复/);
    assert.deepEqual(storage.state(client.userKey(input())).current, before.current);
    assert.equal(history(client, storage).length, 2);
  }
  await assert.rejects(client.chat(input(), { send: async () => { throw new Error('host send failed'); } }), /host send failed|发送/);
  assert.equal(history(client, storage).length, 2);
});

test('role switching cancels old work, starts a fresh persistent conversation, and keeps prior history', async t => {
  const config = makeConfig({ presets: [
    { ...clone(defaults.presets[0]), model: 'fake-model', tools: [] },
    { ...clone(defaults.presets[0]), id: 'writer', name: '写作助手', aliases: ['写作'], model: 'fake-model', tools: [] }
  ] });
  const started = deferred(), old = deferred(); let calls = 0, sends = 0, oldSignal;
  const { client, storage } = fixture(t, { config, provider: async ({ signal }) => {
    calls++;
    if (calls === 2) { oldSignal = signal; started.resolve(); return old.promise; }
    return answer('已完成');
  } });
  await client.chat(input());
  const prior = clone(storage.state(client.userKey(input())));
  const pending = client.chat(input({ text: '切换之前的慢请求' }), { send: async () => { sends++; return true; } });
  const checked = assert.rejects(pending, /变更|取消|角色/);
  await started.promise;
  assert.equal(client.switchPreset(input(), '写作').id, 'writer');
  assert.equal(oldSignal.aborted, true);
  old.resolve(answer('过期回复'));
  await within(checked);
  const current = storage.state(client.userKey(input()));
  assert.notEqual(current.current.conversationId, prior.current.conversationId);
  assert.equal(current.settings.preset, 'writer');
  assert.equal(current.current.messageId, null);
  assert.equal(sends, 0);
  assert.equal(storage.history(prior.current.conversationId).length, 2);
  await client.chat(input({ text: '新角色问题' }));
  assert.equal(history(client, storage).length, 2);
  assert.equal(client.preset(input()).id, 'writer');
});

test('ending a session cancels in-flight output without deleting the previous conversation', async t => {
  const wait = deferred(), started = deferred(); let calls = 0, sends = 0;
  const { client, storage } = fixture(t, { provider: async () => {
    if (++calls === 1) return answer('保留历史');
    started.resolve(); return wait.promise;
  } });
  await client.chat(input());
  const old = storage.state(client.userKey(input()));
  const running = client.chat(input(), { send: async () => { sends++; return true; } });
  const checked = assert.rejects(running, /变更|取消|会话/);
  await started.promise; client.end(input()); wait.resolve(answer('过期'));
  await within(checked);
  assert.equal(sends, 0);
  assert.equal(storage.history(old.current.conversationId).length, 2);
  assert.equal(history(client, storage).length, 0);
});

test('old role cleanup cannot unregister a newer request from cancellation tracking', async t => {
  const old = deferred(), fresh = deferred(), oldStarted = deferred(), freshStarted = deferred();
  let calls = 0, freshSignal;
  const { client } = fixture(t, { provider: async ({ signal }) => {
    if (++calls === 1) { oldStarted.resolve(); return old.promise; }
    freshSignal = signal; freshStarted.resolve(); return fresh.promise;
  } });
  const oldWork = client.chat(input()); const oldCheck = assert.rejects(oldWork, /变更|取消|角色/);
  await oldStarted.promise; client.switchPreset(input(), 'default');
  const freshWork = client.chat(input({ text: '新会话慢请求' })); const freshCheck = assert.rejects(freshWork, /变更|取消|会话/);
  try {
    old.resolve(answer('旧回答')); await within(oldCheck); await within(freshStarted.promise);
    client.end(input()); assert.equal(freshSignal.aborted, true, 'new request must remain registered after the old finally block');
    fresh.resolve(answer('新但已取消')); await within(freshCheck);
  } finally {
    old.resolve(answer()); fresh.resolve(answer());
    await within(Promise.allSettled([oldCheck, freshCheck]));
  }
});

test('queue cancellation removes parked work and never calls its provider', async t => {
  const started = deferred(), blocker = deferred(); const calls = [];
  const { client } = fixture(t, { provider: async ({ messages }) => {
    const text = messages.at(-1).content[0].text; calls.push(text);
    if (text === '占用') { started.resolve(); await blocker.promise; }
    return answer();
  } });
  const active = client.chat(input({ text: '占用' })); await started.promise;
  const cancel = new AbortController();
  const parked = client.chat(input({ userId: '10002', text: '取消的排队' }), { signal: cancel.signal });
  const checked = assert.rejects(parked, /用户取消/);
  assert.equal(client.queue.pending.length, 1);
  cancel.abort(new Error('用户取消')); await within(checked);
  assert.equal(client.queue.pending.length, 0);
  blocker.resolve(); await active;
  assert.deepEqual(calls, ['占用']);
  assert.equal(client.queue.active, 0);
});

test('ordinary deadline includes time spent waiting in the queue', async t => {
  const config = makeConfig({ chat: { timeoutMs: 1000 } }), started = deferred(), release = deferred();
  const calls = [];
  const { client } = fixture(t, { config, provider: async ({ messages, signal }) => {
    const text = messages.at(-1).content[0].text; calls.push(text);
    if (text === '占用') { started.resolve(); return Promise.race([release.promise.then(() => answer()), abortableWait(signal)]); }
    return answer();
  } });
  const active = client.chat(input({ text: '占用' }));
  await started.promise;
  config.chat.timeoutMs = 30;
  const parked = client.chat(input({ userId: '10002', text: '排队期限' })); const parkedCheck = assert.rejects(parked, /超时/);
  await within(parkedCheck);
  release.resolve(); await active;
  assert.deepEqual(calls, ['占用']);
  assert.equal(client.queue.active, 0);
  assert.equal(client.queue.pending.length, 0);
});

test('queue limit rejects overload and cancelled work releases the next slot', async () => {
  const queue = new Queue({ maxConcurrent: 1, maxQueue: 1 }), active = deferred(), queuedSignal = new AbortController();
  const first = queue.run(() => active.promise);
  let ran = false;
  const second = queue.run(async () => { ran = true; return 'next'; }, queuedSignal.signal);
  await assert.rejects(queue.run(async () => 'excess'), /请求较多|排队|队列/);
  const secondCheck = assert.rejects(second, /cancel parked/);
  queuedSignal.abort(new Error('cancel parked')); await secondCheck;
  active.resolve('first'); assert.equal(await first, 'first');
  assert.equal(ran, false); assert.equal(queue.active, 0);
  assert.equal(await queue.run(async () => 'fresh'), 'fresh');
});

test('a timed-out provider cannot retain the slot or send a late reply when it ignores cancellation', async t => {
  const config = makeConfig({ chat: { timeoutMs: 30 } }), unresolved = deferred(); let calls = 0, sends = 0;
  const { client, storage } = fixture(t, { config, provider: async () => ++calls === 1 ? unresolved.promise : answer('下一条') });
  try {
    const late = client.chat(input(), { send: async () => { sends++; return true; } });
    await within(assert.rejects(late, /超时/), 300);
    assert.equal(client.queue.active, 0);
    await within(client.chat(input({ userId: '10002' })), 200);
    unresolved.resolve(answer('迟到的回答')); await delay(5);
    assert.equal(sends, 0);
    assert.equal(storage.stats().history, 2);
  } finally { unresolved.resolve(answer('释放测试任务')); }
});

test('a hung custom tool that ignores cancellation cannot keep the queue past the tool deadline', async t => {
  const config = makeConfig({ chat: { timeoutMs: 100, toolTimeoutMs: 30 }, presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['slow_tool'] }] });
  const unresolved = deferred(); let calls = 0, sent = 0;
  const tools = new ToolRegistry([{ name: 'slow_tool', description: '测试不响应取消的工具', inputSchema: { type: 'object', properties: {} }, execute: () => unresolved.promise }]);
  const { client, storage } = fixture(t, { config, tools, provider: async () => ++calls === 1 ? answer('', { toolCalls: [toolCall('slow_tool', {})] }) : answer() });
  const timed = client.chat(input(), { send: async () => { sent++; return true; } });
  const checked = assert.rejects(timed, /超时/);
  try {
    await within(checked, 300);
    assert.equal(client.queue.active, 0);
    assert.equal(sent, 0); assert.equal(storage.stats().history, 0);
    await within(client.chat(input({ userId: '10002' })), 200);
  } finally {
    unresolved.resolve({ ok: true });
    await within(Promise.allSettled([checked]));
  }
});

test('access controls and rate limits are scoped per bot/user and owner remains exempt', async t => {
  const config = makeConfig({ security: { userWhitelist: ['10001'], userBlacklist: ['blocked'], groupWhitelist: ['group-1'], groupBlacklist: ['blocked-group'], maxRequestsPerWindow: 1 } });
  assert.equal(accessAllowed(config, input()), true);
  assert.equal(accessAllowed(config, input({ userId: 'other' })), false);
  assert.equal(accessAllowed(config, input({ groupId: 'other-group' })), false);
  assert.equal(accessAllowed(config, input({ userId: 'blocked', isMaster: true })), true);
  const { client, storage } = fixture(t, { config });
  await client.chat(input());
  await assert.rejects(client.chat(input()), /频繁/);
  await client.chat(input({ botId: 'another-bot' }));
  await assert.rejects(client.chat(input({ userId: 'other' })), /权限/);
  await client.chat(input({ userId: 'blocked', isMaster: true }));
  await client.chat(input({ userId: 'blocked', isMaster: true }));
  assert.equal(storage.stats().history, 8);
});

test('role whitelist/blacklist cannot be bypassed by an alias while owner can select it', async t => {
  const config = makeConfig({ chat: { userRoleWhitelist: ['allowed'], userRoleBlacklist: ['10001'] } });
  const { client } = fixture(t, { config });
  await assert.rejects(async () => client.switchPreset(input(), '默认助手'), /权限/);
  assert.equal(client.switchPreset(input({ userId: 'allowed' }), 'default').id, 'default');
  assert.equal(client.switchPreset(input({ isMaster: true }), 'default').id, 'default');
});

test('group background is bounded, deduplicated and never copied across groups', async t => {
  const config = makeConfig({ group: { contextLength: 2 } }), captured = [];
  const { client, storage } = fixture(t, { config, provider: async request => { captured.push(clone(request.messages)); return answer(); } });
  for (const [id, text] of [['1', '第一条'], ['2', '第二条'], ['3', '第三条'], ['3', '重复内容']]) client.observeGroup(input({ groupId: 'g1', messageId: id, text }));
  client.observeGroup(input({ groupId: 'g2', messageId: 'x', text: '另一群秘密' }));
  assert.deepEqual(storage.group(client.groupKey(input({ groupId: 'g1' }))).map(row => row.text), ['第二条', '第三条']);
  await client.chat(input({ groupId: 'g1' }));
  const system = captured[0][0].content[0].text;
  assert.match(system, /仅作为对话资料|不是系统指令/);
  assert.match(system, /第二条/); assert.match(system, /第三条/);
  assert.doesNotMatch(system, /第一条|另一群秘密|重复内容/);
});

test('proactive triggers obey probability, keywords, command exclusions, cooldown and busy state', async t => {
  const config = makeConfig({ group: { proactiveEnabled: true, probability: 0.03, keywords: ['猫'], keywordPresets: [{ keyword: '写作', presetId: 'writer' }], cooldownMs: 100 } });
  const { client } = fixture(t, { config });
  assert.equal(client.proactivePreset(input(), () => 0), null);
  assert.equal(client.proactivePreset(input({ groupId: 'g1', atBot: true }), () => 0), null);
  assert.equal(client.proactivePreset(input({ groupId: 'g1', isCommand: true }), () => 0), null);
  assert.equal(client.proactivePreset(input({ groupId: 'g1' }), () => 0.04), null);
  assert.equal(client.proactivePreset(input({ groupId: 'g1' }), () => 0.02), 'default');
  assert.equal(client.proactivePreset(input({ groupId: 'g1', text: '猫' }), () => 1), null);
  assert.equal(client.proactivePreset(input({ groupId: 'g2', text: '写作' }), () => 1), 'writer');
  client.queue.active = 1;
  assert.equal(client.proactivePreset(input({ groupId: 'g3', text: '猫' }), () => 0), null);
  client.queue.active = 0;
  assert.equal(client.proactivePreset(input({ groupId: 'g3', text: '猫' }), () => 1), 'default');
});

test('proactive skip does not send or advance the personal conversation', async t => {
  let sent = 0;
  const { client, storage } = fixture(t, { provider: async () => answer('[不回复]') });
  const result = await client.chat(input({ groupId: 'g1', proactive: true }), { send: async () => { sent++; return true; } });
  assert.equal(result.skipped, true); assert.equal(sent, 0); assert.equal(storage.stats().history, 0);
});

test('search tool loop preserves complete query, actual sources and usage, sends exactly once', async t => {
  const config = makeConfig({ presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['web_search'] }] });
  const captured = [], searches = [], sent = [];
  const { client, storage } = fixture(t, { config, search: async request => {
    searches.push(request);
    return { ok: true, query: request.query, engine: '360', searchedAt: '2026-10-06T00:00:00Z', searchUrl: 'https://www.so.com/s?q=猫', provenance: { requestedQuery: request.query, queryVerified: true }, results: [{ title: '可靠资料', url: 'https://source.invalid/article' }] };
  }, provider: async request => {
    captured.push(clone(request.messages));
    if (captured.length === 1) return answer('我会搜索', { toolCalls: [toolCall('web_search', { query: '中国有哪些种类的猫' })] });
    return answer('根据资料整理的回答');
  } });
  const result = await client.chat(input(), { send: async output => { sent.push(output); return { delivered: true }; } });
  assert.equal(searches.length, 1); assert.equal(searches[0].query, '中国有哪些种类的猫');
  assert.equal(searches[0].signal.aborted, false);
  const toolResult = captured[1].find(row => row.role === 'tool');
  assert.equal(toolResult.toolCallId, 'call-1');
  const metadata = JSON.parse(toolResult.content[0].text);
  assert.equal(metadata.engine, '360'); assert.equal(metadata.provenance.queryVerified, true);
  assert.match(result.text, /https:\/\/source\.invalid\/article/);
  assert.doesNotMatch(result.text, /我会搜索/);
  assert.deepEqual(result.usage, { inputTokens: 4, outputTokens: 6, totalTokens: 10 });
  assert.equal(result.usedTools, true); assert.equal(sent.length, 1);
  assert.deepEqual(history(client, storage).map(row => row.role), ['user', 'assistant', 'tool', 'assistant']);
});

test('successful real search falls back to its links when later model summarization fails', async t => {
  const config = makeConfig({ presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['web_search'] }] });
  let rounds = 0;
  const { client } = fixture(t, { config, search: async () => ({ ok: true, results: [{ title: '官方资料', url: 'https://source.invalid/official' }, { title: '不应作链接', url: 'javascript:alert(1)' }] }), provider: async () => {
    if (++rounds === 1) return answer('', { toolCalls: [toolCall('web_search', { query: '核查问题' })] });
    throw new Error('fake gateway failed');
  } });
  const sent = [], result = await client.chat(input(), { send: async value => { sent.push(value); return true; } });
  assert.match(result.text, /搜索已完成/); assert.match(result.text, /https:\/\/source\.invalid\/official/);
  assert.doesNotMatch(result.text, /javascript|fake gateway failed/); assert.equal(sent.length, 1);
});

test('search failure never fabricates successful sources and follows a tool error into the model', async t => {
  const config = makeConfig({ presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['web_search'] }] });
  let rounds = 0, toolResult;
  const { client } = fixture(t, { config, search: async () => ({ ok: false, results: [] }), provider: async ({ messages }) => {
    if (++rounds === 1) return answer('', { toolCalls: [toolCall('web_search', { query: '完整问题' })] });
    toolResult = JSON.parse(messages.at(-1).content[0].text); return answer('搜索失败，暂时不能核实。');
  } });
  const result = await client.chat(input());
  assert.match(toolResult.error, /失败/); assert.deepEqual(result.sources, []);
  assert.doesNotMatch(result.text, /https?:\/\//);
});

test('unapproved model tools are denied without executing their implementations', async t => {
  let executed = 0, rounds = 0, captured;
  const tools = new ToolRegistry([{ name: 'custom_admin', description: '仅允许显式授权', inputSchema: { type: 'object', properties: {} }, execute: async () => { executed++; return { ok: true }; } }]);
  const { client } = fixture(t, { tools, provider: async ({ messages }) => {
    if (++rounds === 1) return answer('', { toolCalls: [toolCall('custom_admin', {})] });
    captured = JSON.parse(messages.at(-1).content[0].text); return answer('工具未被授权。');
  } });
  await client.chat(input());
  assert.equal(executed, 0); assert.match(captured.error, /未允许|权限/);
});

test('the maximum tool round budget cannot be bypassed by repeated model tool calls', async t => {
  const config = makeConfig({ chat: { maxToolRounds: 1 }, presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['web_search'] }] });
  let searches = 0, rounds = 0;
  const { client } = fixture(t, { config, search: async () => { searches++; return { ok: true, results: [{ title: '来源', url: 'https://source.invalid/' }] }; }, provider: async () => answer('模型仍然请求工具', { toolCalls: [toolCall('web_search', { query: '问题' }, 'call-' + ++rounds)] }) });
  const result = await client.chat(input()).catch(error => error);
  assert.ok(searches <= config.chat.maxToolRounds, 'tool executions must stop at the configured round limit');
  assert.ok(rounds <= config.chat.maxToolRounds + 1);
  if (!(result instanceof Error)) assert.match(result.text, /来源|https:\/\/source\.invalid/);
});

test('search and avatar images are buffered for one final delivery and failed delivery stores no history', async t => {
  const root = await temporaryRoot(t), images = new ImageStore({ directory: path.join(root, 'images') });
  const config = makeConfig({ presets: [{ ...clone(defaults.presets[0]), model: 'fake-model', tools: ['web_search', 'GetQQAvatar'] }] });
  let rounds = 0, sends = 0;
  const { client, storage } = fixture(t, { root, config, imageStore: images, host: { getAvatar: async () => Buffer.from(png, 'base64') }, search: async () => ({ ok: true, query: '问题', format: 'image', imageType: 'png', imageBase64: png, results: [{ title: '资料', url: 'https://source.invalid/' }] }), provider: async () => {
    if (++rounds % 2 === 1) return answer('', { toolCalls: [toolCall('web_search', { query: '问题', type: 'image' }, 'search'), toolCall('GetQQAvatar', { includeBot: true, send: true }, 'avatar')] });
    return answer('图片已核实。');
  } });
  const result = await client.chat(input(), { send: async value => { sends++; assert.equal(value.contents.filter(part => part.type === 'image').length, 2); return true; } });
  assert.equal(sends, 1); assert.equal(result.contents.filter(part => part.type === 'image').length, 2);
  const saved = storage.stats().history;
  await assert.rejects(client.chat(input(), { send: async () => false }), /发送|回复/);
  assert.equal(storage.stats().history, saved);
});

test('input/output filters and hidden reasoning prevent blocked text and thinking from being delivered', async t => {
  const config = makeConfig({ security: { inputBlockedWords: ['禁入'], outputBlockedWords: ['禁出'], blockStrategy: 'replace', replacement: '[屏蔽]' } });
  const { client, storage } = fixture(t, { config, provider: async () => answer('<think>隐藏思考</think>正常禁出内容', { contents: [{ type: 'reasoning', text: '隐藏推理' }, { type: 'text', text: '<think>隐藏思考</think>正常禁出内容' }] }) });
  await assert.rejects(client.chat(input({ text: '禁入' })), /屏蔽/);
  const result = await client.chat(input());
  assert.equal(result.text, '正常[屏蔽]内容'); assert.equal(result.contents.some(row => row.type === 'reasoning'), false);
  assert.doesNotMatch(JSON.stringify(history(client, storage)), /隐藏思考|隐藏推理|禁出/);
});

test('provider failures and tool error summaries never expose configured credentials in errors/logs/history', async t => {
  const config = makeConfig({ tools: { searchToken: 'test-search-secret' } });
  const { client, storage } = fixture(t, { config, provider: async () => { throw new Error('failed Authorization Bearer test-model-secret; x-search-secret test-search-secret'); } });
  const error = await client.chat(input()).catch(value => value);
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, /test-model-secret|test-search-secret/);
  assert.doesNotMatch(JSON.stringify(storage.logs()), /test-model-secret|test-search-secret/);
  assert.equal(storage.stats().history, 0);
  config.presets[0].tools = ['sensitive_lookup'];
  client.tools.register({ name: 'sensitive_lookup', description: '异常测试工具', inputSchema: { type: 'object', properties: {} }, execute: async () => { throw new Error('search test-search-secret and test-model-secret'); } });
  let rounds = 0, captured;
  client.provider = async ({ messages }) => {
    if (++rounds === 1) return answer('', { toolCalls: [toolCall('sensitive_lookup', {})] });
    captured = JSON.stringify(messages.at(-1)); return answer('工具失败。');
  };
  await client.chat(input());
  assert.doesNotMatch(captured, /test-model-secret|test-search-secret/);
  assert.doesNotMatch(JSON.stringify(history(client, storage)), /test-model-secret|test-search-secret/);
});

test('masked config can be edited and reordered without revealing or overwriting secret values', async t => {
  const root = await temporaryRoot(t), file = path.join(root, 'local.json');
  const config = makeConfig({ channels: [
    { id: 'a', type: 'openai', apiKey: 'secret-a', models: [] },
    { id: 'b', type: 'claude', apiKey: 'secret-b', models: [] }
  ], tools: { searchToken: 'search-token' }, management: { apiToken: 'admin-token' } });
  const masked = mask(config);
  assert.doesNotMatch(JSON.stringify(masked), /secret-a|secret-b|search-token|admin-token/);
  assert.equal(masked.presets[0].maxTokens, 2048);
  masked.channels.reverse(); masked.channels[0].name = '重命名';
  const restored = restoreSecrets(masked, config);
  assert.equal(restored.channels[0].id, 'b'); assert.equal(restored.channels[0].apiKey, 'secret-b');
  assert.equal(restored.channels[1].apiKey, 'secret-a'); assert.equal(restored.tools.searchToken, 'search-token');
  writeJson(file, restored); assert.equal(readConfig(file).channels[0].apiKey, 'secret-b');
  assert.throws(() => merge(defaults, JSON.parse('{"__proto__":{"polluted":true}}')), /不允许/);
  assert.throws(() => restoreSecrets({ channels: [{ id: 'new', apiKey: '••••••••' }] }, config), /重新填写/);
});

test('channel selection honors explicit preset and supported models before priority', () => {
  const config = makeConfig({ channels: [
    { id: 'disabled', enabled: false, priority: 100, models: ['fake-model'] },
    { id: 'other-model', priority: 99, models: ['other'] },
    { id: 'low', priority: 0, models: ['fake-model'] },
    { id: 'high', priority: 10, models: [{ name: 'fake-model' }] }
  ] });
  assert.equal(selectChannel(config, { model: 'fake-model' }).id, 'high');
  assert.equal(selectChannel(config, { channelId: 'low', model: 'fake-model' }).id, 'low');
  assert.throws(() => selectChannel(config, { channelId: 'disabled', model: 'fake-model' }), /没有可用/);
});

test('Yunzai normalization and trigger classification require no initialization or QQ sends', async () => {
  const hadPlugin = Object.hasOwn(globalThis, 'plugin'), prior = globalThis.plugin;
  let module;
  try { globalThis.plugin = class {}; module = await import('../integrations/yunzai/index.js'); }
  finally { if (hadPlugin) globalThis.plugin = prior; else delete globalThis.plugin; }
  const config = makeConfig({ basic: { triggerMode: 'both', triggerPrefix: '#chat' } });
  const normalized = module.normalizeEvent({ user_id: 10001, self_id: 20001, group_id: 30001, isGroup: true, atBot: true, msg: ' 测试 ', message: [{ type: 'at', qq: 20001 }, { type: 'image', url: 'https://images.invalid/picture.png' }] });
  assert.equal(normalized.groupId, '30001'); assert.equal(normalized.isPrivate, false); assert.equal(normalized.text, '测试');
  assert.deepEqual(normalized.mentions, ['20001']); assert.equal(normalized.images[0].type, 'image');
  assert.equal(module.classify(normalized, config).type, 'chat');
  assert.deepEqual(module.classify({ ...normalized, atBot: false, text: '#chat 完整问题', isCommand: true }, config), { type: 'chat', text: '完整问题' });
  assert.equal(module.classify({ ...normalized, atBot: false, text: '#系统', isCommand: true }, config).type, 'ignore');
  assert.equal(module.classify({ ...normalized, text: '#AI切换预设 默认助手', isCommand: true }, config).type, 'command');
  assert.equal(module.classify({ ...normalized, groupId: '', isPrivate: true, text: '私聊' }, config).type, 'chat');
  config.chat.privateEnabled = false;
  assert.equal(module.classify({ ...normalized, groupId: '', isPrivate: true, text: '私聊' }, config).type, 'ignore');
  config.chat.groupEnabled = false; config.group.proactiveEnabled = true;
  assert.equal(module.classify(normalized, config).type, 'ignore');
  config.basic.enabled = false;
  assert.equal(module.classify(normalized, config).type, 'ignore');
});
