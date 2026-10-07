import test from 'node:test';
import assert from 'node:assert/strict';
import { complete, createProvider } from '../src/providers/index.mjs';
import { geminiMessages } from '../src/providers/gemini.mjs';
import { claudeMessages } from '../src/providers/claude.mjs';

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6S2sAAAAASUVORK5CYII=';
const input = type => ({ channel: { type, baseUrl: 'https://example.invalid/v1', apiKey: 'test-key' }, model: 'test-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: '你好' }] }], signal: new AbortController().signal });
const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const openaiAnswer = text => ({ choices: [{ message: { content: text } }], usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 } });
function sse(events) {
  const buffer = Buffer.from(events.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\r\n\r\n`).join(''));
  return new Response(new ReadableStream({ start(controller) { for (let i = 0; i < buffer.length; i += 3) controller.enqueue(buffer.subarray(i, i + 3)); controller.close(); } }), { headers: { 'content-type': 'text/event-stream' } });
}
async function within(promise, milliseconds = 1000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('test operation did not settle within its budget')), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
function hungFetch() {
  const cleanup = new AbortController();
  return {
    fetchImpl: async (_url, { signal }) => {
      const combined = AbortSignal.any([signal, cleanup.signal]);
      return new Promise((_resolve, reject) => {
        if (combined.aborted) reject(combined.reason);
        else combined.addEventListener('abort', () => reject(combined.reason), { once: true });
      });
    },
    abort: () => cleanup.abort(new Error('test fetch cleanup'))
  };
}

test('OpenAI sends normalized image/system/tool history and returns usage', async () => {
  let request;
  const result = await complete({ ...input('openai'), messages: [
    { role: 'system', content: [{ type: 'text', text: '规则' }] },
    { role: 'user', content: [{ type: 'text', text: '识图' }, { type: 'image', data: png, mime: 'image/png' }] },
    { role: 'assistant', content: [], toolCalls: [{ id: 'call1', name: 'web_search', arguments: { query: '猫的品种' } }] },
    { role: 'tool', toolCallId: 'call1', content: [{ type: 'text', text: '{"ok":true}' }] }
  ], options: { maxTokens: 40 }, tools: [{ name: 'web_search', description: '搜索', inputSchema: { type: 'object' } }] }, {
    fetchImpl: async (url, init) => { request = { url: String(url), ...init, body: JSON.parse(init.body) }; return json(openaiAnswer('结果')); }
  });
  assert.equal(request.url, 'https://example.invalid/v1/chat/completions');
  assert.equal(request.headers.authorization, 'Bearer test-key');
  assert.equal(request.redirect, 'error');
  assert.equal(request.body.messages[0].content, '规则');
  assert.equal(request.body.messages[1].content[1].image_url.url, `data:image/png;base64,${png}`);
  assert.equal(request.body.messages[2].tool_calls[0].function.arguments, '{"query":"猫的品种"}');
  assert.equal(request.body.messages[3].tool_call_id, 'call1');
  assert.equal(request.body.max_tokens, 40);
  assert.deepEqual(result.usage, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
});

test('OpenAI malformed model arguments are reported instead of executing invented defaults', async () => {
  await assert.rejects(complete(input('openai'), { fetchImpl: async () => json({ choices: [{ message: { tool_calls: [{ id: 'c', function: { name: 'web_search', arguments: '{broken' } }] } }] }) }), { code: 'INVALID_TOOL_ARGUMENTS' });
});

test('OpenAI SSE assembles split Chinese/tool arguments and reasoning', async () => {
  const deltas = [];
  const response = await complete({ ...input('openai'), options: { stream: true }, onDelta: part => deltas.push(part) }, {
    fetchImpl: async () => sse([
      { choices: [{ delta: { content: '你好', reasoning_content: '思考', tool_calls: [{ index: 0, id: 'c1', function: { name: 'web_search', arguments: '{"query":' } }] } }] },
      { choices: [{ delta: { content: '世界', tool_calls: [{ index: 0, function: { arguments: '"完整中文"}' } }] }, finish_reason: 'tool_calls' }] },
      { choices: [], usage: { prompt_tokens: 5, completion_tokens: 9, total_tokens: 14 } }, '[DONE]'
    ])
  });
  assert.equal(response.contents[0].text, '你好世界');
  assert.equal(response.contents[1].text, '思考');
  assert.deepEqual(response.toolCalls[0], { id: 'c1', name: 'web_search', arguments: { query: '完整中文' } });
  assert.equal(response.usage.totalTokens, 14);
  assert.equal(deltas[0].text, '你好');
});

test('truncated SSE fails clearly instead of returning partial successful answer', async () => {
  await assert.rejects(complete({ ...input('openai'), options: { stream: true } }, { fetchImpl: async () => sse([{ choices: [{ delta: { content: '部分' } }] }]) }), { code: 'INCOMPLETE_STREAM' });
});

test('HTTP errors omit upstream private text and classify retryability', async () => {
  await assert.rejects(complete(input('openai'), { fetchImpl: async () => new Response('upstream echoed a private-key', { status: 429 }) }), error => {
    assert.equal(error.status, 429); assert.equal(error.retryable, true); assert.doesNotMatch(error.message, /private-key/); return true;
  });
});

test('provider abort uses the host cancellation signal', async () => {
  const controller = new AbortController(), fetch = hungFetch();
  try {
    const pending = complete({ ...input('openai'), signal: controller.signal }, { fetchImpl: fetch.fetchImpl });
    controller.abort(new Error('host cancelled'));
    await assert.rejects(within(pending), /host cancelled/);
  } finally { controller.abort(); fetch.abort(); }
});

test('request deadline applies to a hung provider', async () => {
  const controller = new AbortController(), fetch = hungFetch();
  try {
    const pending = complete({ ...input('openai'), signal: controller.signal, options: { timeoutMs: 20 } }, { fetchImpl: fetch.fetchImpl });
    await assert.rejects(within(pending), { name: 'TimeoutError' });
  } finally { controller.abort(); fetch.abort(); }
});

test('Gemini preserves actual image mime and signed function call follow-up', async () => {
  let request;
  const result = await complete({ ...input('gemini'), options: { responseModalities: ['TEXT', 'IMAGE'] } }, {
    fetchImpl: async (url, init) => { request = { url: String(url), headers: init.headers, body: JSON.parse(init.body) }; return json({ modelVersion: 'gemini-test', candidates: [{ content: { parts: [
      { text: '分析', thought: true, thoughtSignature: 'thought-signature' },
      { inlineData: { mimeType: 'image/png', data: png } },
      { functionCall: { id: 'f1', name: 'lookup', args: { x: 1 } }, thoughtSignature: 'call-signature' }
    ] } }], usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, thoughtsTokenCount: 1, totalTokenCount: 6 } }); }
  });
  assert.equal(request.url, 'https://example.invalid/v1/models/test-model:generateContent');
  assert.equal(request.headers['x-goog-api-key'], 'test-key');
  assert.ok(!request.url.includes('test-key'));
  assert.equal(result.contents[1].mime, 'image/png');
  const followup = await geminiMessages([{ role: 'assistant', content: result.contents, toolCalls: result.toolCalls },
    { role: 'tool', toolCallId: 'f1', content: [{ type: 'text', text: '{"value":2}' }] }], {});
  assert.equal(followup.contents[0].parts.at(-1).thoughtSignature, 'call-signature');
  assert.equal(followup.contents[1].parts[0].functionResponse.name, 'lookup');
  assert.deepEqual(result.usage, { inputTokens: 2, outputTokens: 4, totalTokens: 6 });
});

test('Gemini URL images are downloaded without model credentials; unsupported audio is explicit', async () => {
  let downloaded;
  await complete({ ...input('gemini'), messages: [{ role: 'user', content: [{ type: 'image', url: 'https://images.invalid/picture.png' }] }] }, {
    lookup: async () => [{ address: '93.184.216.34', family: 4 }],
    fetchImpl: async (url, init) => {
      if (String(url).includes('images.invalid')) { downloaded = init; return new Response(Buffer.from(png, 'base64'), { headers: { 'content-type': 'image/png' } }); }
      return json({ candidates: [{ content: { parts: [{ text: '看到了' }] } }] });
    }
  });
  assert.equal(downloaded.headers, undefined);
  await assert.rejects(complete(input('gemini'), { fetchImpl: async () => json({ candidates: [{ content: { parts: [{ inlineData: { mimeType: 'audio/wav', data: 'AAAA' } }] } }] }) }), { code: 'CAPABILITY_PLANNED' });
});

test('Claude maps system and parallel tool results and preserves thinking signatures', async () => {
  let request;
  const result = await complete({ ...input('claude'), options: { maxTokens: 2048, thinkingBudget: 1024 }, messages: [
    { role: 'system', content: [{ type: 'text', text: '规则' }] },
    { role: 'user', content: [{ type: 'image', data: png, mime: 'image/png' }] }
  ] }, {
    fetchImpl: async (url, init) => { request = { url: String(url), body: JSON.parse(init.body), headers: init.headers }; return json({ model: 'claude-test', content: [
      { type: 'thinking', thinking: '核对', signature: 'sig' }, { type: 'tool_use', id: 'one', name: 'lookup', input: { value: 1 } }, { type: 'tool_use', id: 'two', name: 'lookup', input: { value: 2 } }
    ], usage: { input_tokens: 10, output_tokens: 20 } }); }
  });
  assert.equal(request.url, 'https://example.invalid/v1/messages');
  assert.equal(request.body.system, '规则');
  assert.equal(request.headers['anthropic-version'], '2023-06-01');
  const history = claudeMessages([{ role: 'assistant', content: result.contents, toolCalls: result.toolCalls },
    { role: 'tool', toolCallId: 'one', content: [{ type: 'text', text: '1' }] },
    { role: 'tool', toolCallId: 'two', content: [{ type: 'text', text: '2' }] }]);
  assert.equal(history.messages[0].content[0].signature, 'sig');
  assert.equal(history.messages[1].content.length, 2);
});

test('Claude streaming combines input JSON fragments and final token usage', async () => {
  const result = await complete({ ...input('claude'), options: { stream: true } }, { fetchImpl: async () => sse([
    { type: 'message_start', message: { model: 'claude-test', usage: { input_tokens: 2 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'lookup', input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"中文":' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '"内容"}' } },
    { type: 'message_delta', usage: { output_tokens: 4 } }, { type: 'message_stop' }
  ]) });
  assert.deepEqual(result.toolCalls[0].arguments, { 中文: '内容' });
  assert.equal(result.usage.totalTokens, 6);
});

test('framework-free provider import and planned media failures require no globals', async () => {
  assert.equal(typeof createProvider().complete, 'function');
  await assert.rejects(complete({ ...input('openai'), messages: [{ role: 'user', content: [{ type: 'audio', data: 'audio' }] }] }, { fetchImpl: async () => { throw new Error('must not call'); } }), { code: 'CAPABILITY_PLANNED' });
  await assert.rejects(complete({ ...input('openai'), channel: { type: 'unknown' } }), { code: 'UNSUPPORTED_PROVIDER' });
  await assert.rejects(complete({ ...input('openai'), channel: { type: 'openai', enabled: false } }), { code: 'CHANNEL_DISABLED' });
});

test('modern OpenAI reasoning models use max_completion_tokens with explicit override available', async () => {
  const bodies = [];
  const fetchImpl = async (_url, init) => { bodies.push(JSON.parse(init.body)); return json(openaiAnswer('结果')); };
  await complete({ ...input('openai'), model: 'gpt-6-test', options: { maxTokens: 30 } }, { fetchImpl });
  await complete({ ...input('openai'), model: 'gpt-6-test', options: { maxTokens: 30, maxTokensParameter: 'max_tokens' } }, { fetchImpl });
  assert.equal(bodies[0].max_completion_tokens, 30);
  assert.equal(bodies[1].max_tokens, 30);
});

test('Gemini SSE preserves whole answer instead of inserting breaks between token chunks', async () => {
  const result = await complete({ ...input('gemini'), options: { stream: true } }, { fetchImpl: async () => sse([
    { candidates: [{ content: { parts: [{ text: '中华' }] } }] },
    { candidates: [{ content: { parts: [{ text: '田园猫' }] }, finishReason: 'STOP' }], usageMetadata: { totalTokenCount: 4 } }
  ]) });
  assert.deepEqual(result.contents, [{ type: 'text', text: '中华田园猫' }]);
});

test('invalid tool names and blocked/empty answers are explicit failures', async () => {
  await assert.rejects(complete(input('openai'), { fetchImpl: async () => json({ choices: [{ message: { tool_calls: [{ id: 'c', function: { arguments: '{}' } }] } }] }) }), { code: 'INVALID_TOOL_CALL' });
  await assert.rejects(complete(input('gemini'), { fetchImpl: async () => json({ promptFeedback: { blockReason: 'SAFETY' } }) }), { code: 'EMPTY_RESPONSE' });
  await assert.rejects(complete(input('claude'), { fetchImpl: async () => json({ content: [] }) }), { code: 'EMPTY_RESPONSE' });
});

test('OpenAI assistant image history is compatible text and user private URLs are denied', async () => {
  let body;
  await complete({ ...input('openai'), messages: [{ role: 'assistant', content: [{ type: 'image', data: png, mime: 'image/png', ref: 'image-ref' }] },
    { role: 'user', content: [{ type: 'text', text: '继续' }] }] }, { fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json(openaiAnswer('继续回答')); } });
  assert.equal(body.messages[0].content, '[此前生成的图片 ref:image-ref]');
  assert.equal(body.messages[1].content, '继续');
  await assert.rejects(complete({ ...input('openai'), messages: [{ role: 'user', content: [{ type: 'image', url: 'http://169.254.169.254/private' }] }] }), { code: 'PRIVATE_IMAGE_URL' });
});

test('OpenAI text-only turns preserve full questions and history as gateway-compatible strings', async () => {
  let body;
  const question = '下班后只想刷手机，越刷越空虚，给出三个具体办法。';
  await complete({ ...input('openai'), messages: [
    { role: 'system', content: [{ type: 'text', text: '角色规则' }] },
    { role: 'user', content: '上一轮的问题' },
    { role: 'assistant', content: [{ type: 'text', text: '先前回答' }] },
    { role: 'user', content: [{ type: 'text', text: question }, { type: 'text', text: '别只说早点睡。' }] }
  ] }, { fetchImpl: async (_url, options) => { body = JSON.parse(options.body); return json(openaiAnswer('三个办法')); } });
  assert.deepEqual(body.messages.map(row => row.content), ['角色规则', '上一轮的问题', '先前回答', question + '\n别只说早点睡。']);
});
