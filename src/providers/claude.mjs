import { ProviderError, endpoint, ensureResponse, imageData, parseArguments, parseEvent, parts, plannedCapability, post, readJson, readSse, requestSignal, textContent, toolCall, usage, validateRequest } from './common.mjs';
import { publicImageUrl } from '../media/remote.mjs';

export function claudeMessages(messages) {
  const system = [];
  const result = [];
  for (const message of messages) {
    if (['system', 'developer'].includes(message.role)) { system.push(textContent(message)); continue; }
    const content = [];
    if (message.role === 'tool') content.push({ type: 'tool_result', tool_use_id: message.toolCallId, content: textContent(message), ...(message.isError ? { is_error: true } : {}) });
    else {
      for (const part of parts(message)) {
        if (part.type === 'text') { if (part.text) content.push({ type: 'text', text: String(part.text) }); }
        else if (part.type === 'image') {
          const embedded = imageData(part);
          content.push({ type: 'image', source: embedded
            ? { type: 'base64', media_type: embedded.mime, data: embedded.data }
            : { type: 'url', url: publicImageUrl(part.url).href } });
        } else if (part.type === 'reasoning') {
          if (part.signature) content.push({ type: 'thinking', thinking: part.text, signature: part.signature });
          else if (part.redactedData) content.push({ type: 'redacted_thinking', data: part.redactedData });
        } else throw plannedCapability(part.type === 'audio' ? '语音输入' : '该多模态输入');
      }
      for (const call of message.toolCalls ?? []) content.push({ type: 'tool_use', id: call.id, name: call.name, input: call.arguments ?? {} });
    }
    if (!content.length) continue;
    const role = message.role === 'assistant' ? 'assistant' : 'user';
    if (result.at(-1)?.role === role) result.at(-1).content.push(...content);
    else result.push({ role, content });
  }
  return { messages: result, ...(system.filter(Boolean).length ? { system: system.filter(Boolean).join('\n\n') } : {}) };
}

function normalize(body, model) {
  if (body.error) throw new ProviderError('Claude 服务返回错误。', { code: 'API_ERROR' });
  const contents = [];
  const toolCalls = [];
  for (const part of body.content ?? []) {
    if (part.type === 'text' && part.text) contents.push({ type: 'text', text: part.text });
    else if (part.type === 'thinking') contents.push({ type: 'reasoning', text: part.thinking || '', signature: part.signature });
    else if (part.type === 'redacted_thinking') contents.push({ type: 'reasoning', text: '', redactedData: part.data });
    else if (part.type === 'tool_use') toolCalls.push(toolCall(part.id, part.name, part.input ?? {}));
  }
  return ensureResponse({ contents, toolCalls, provider: 'claude', model: body.model || model,
    usage: usage((body.usage?.input_tokens ?? 0) + (body.usage?.cache_creation_input_tokens ?? 0) + (body.usage?.cache_read_input_tokens ?? 0), body.usage?.output_tokens ?? 0) });
}

async function streamed(response, request) {
  const aggregate = { content: [], usage: {} };
  const blocks = new Map();
  let finished = false;
  for await (const event of readSse(response)) {
    const chunk = parseEvent(event.data);
    if (chunk.type === 'error') throw new ProviderError('Claude 流式服务返回错误。', { code: 'API_ERROR' });
    if (chunk.type === 'message_start') Object.assign(aggregate, chunk.message, { content: [] });
    else if (chunk.type === 'content_block_start') blocks.set(chunk.index, { ...chunk.content_block });
    else if (chunk.type === 'content_block_delta') {
      const block = blocks.get(chunk.index);
      if (!block) throw new ProviderError('Claude 流式内容缺少起始事件。', { code: 'INVALID_RESPONSE' });
      const delta = chunk.delta;
      if (delta.type === 'text_delta') { block.text = (block.text || '') + delta.text; await request.onDelta?.({ type: 'text', text: delta.text }); }
      else if (delta.type === 'thinking_delta') { block.thinking = (block.thinking || '') + delta.thinking; await request.onDelta?.({ type: 'reasoning', text: delta.thinking }); }
      else if (delta.type === 'signature_delta') block.signature = (block.signature || '') + delta.signature;
      else if (delta.type === 'input_json_delta') block.partial = (block.partial || '') + delta.partial_json;
    } else if (chunk.type === 'message_delta') Object.assign(aggregate.usage, chunk.usage ?? {});
    else if (chunk.type === 'message_stop') finished = true;
  }
  if (!finished) throw new ProviderError('Claude 流式响应中断。', { code: 'INCOMPLETE_STREAM' });
  aggregate.content = [...blocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => {
    if (block.type === 'tool_use' && block.partial !== undefined) block.input = parseArguments(block.partial);
    delete block.partial;
    return block;
  });
  return normalize(aggregate, request.model);
}

export async function completeClaude(request, { fetchImpl = fetch } = {}) {
  validateRequest(request);
  const { channel, model, messages, options = {}, tools = [] } = request;
  const signal = requestSignal(request.signal, options.timeoutMs ?? channel.timeoutMs ?? 25000);
  const body = { ...claudeMessages(messages), model, max_tokens: options.maxTokens ?? 4096, stream: Boolean(options.stream) };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.thinkingBudget !== undefined) {
    if (options.thinkingBudget < 1024 || options.thinkingBudget >= body.max_tokens) throw new ProviderError('Claude 推理预算须至少 1024 且小于最大输出 token。', { code: 'INVALID_OPTIONS' });
    body.thinking = { type: 'enabled', budget_tokens: options.thinkingBudget };
    delete body.temperature;
  }
  if (tools.length) body.tools = tools.map(tool => ({ name: tool.name, description: tool.description, input_schema: tool.inputSchema }));
  const response = await post(endpoint(channel.baseUrl?.replace(/\/+$/, '').endsWith('/v1') ? channel.baseUrl : `${channel.baseUrl || 'https://api.anthropic.com'}/v1`, '/messages'), body, {
    provider: 'Claude', signal, fetchImpl, headers: { 'anthropic-version': '2023-06-01', ...(channel.apiKey ? { 'x-api-key': channel.apiKey } : {}) }
  });
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) return streamed(response, request);
  return normalize(await readJson(response), model);
}
