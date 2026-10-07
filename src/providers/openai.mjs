import { ProviderError, endpoint, ensureResponse, imageUrl, parseEvent, parts, plannedCapability, post, readJson, readSse, requestSignal, textContent, toolCall, usage, validateRequest } from './common.mjs';

export function openaiMessages(messages) {
  return messages.map(message => {
    if (message.role === 'tool') return { role: 'tool', tool_call_id: message.toolCallId, content: textContent(message) };
    const content = [];
    for (const part of parts(message)) {
      if (part.type === 'text') content.push({ type: 'text', text: String(part.text ?? '') });
      else if (part.type === 'image') {
        // Chat Completions assistant messages cannot contain image_url blocks.
        if (message.role === 'assistant') content.push({ type: 'text', text: `[此前生成的图片${part.ref ? ` ref:${part.ref}` : ''}]` });
        else content.push({ type: 'image_url', image_url: { url: imageUrl(part) } });
      }
      else if (part.type !== 'reasoning') throw plannedCapability(part.type === 'audio' ? '语音输入' : '该多模态输入');
    }
    // Some compatible gateways silently discard text-only content arrays.
    // Keep structured arrays only when actual image blocks are present.
    const serialized = content.some(part => part.type === 'image_url') ? content : content.map(part => part.text).join('\n');
    const result = { role: message.role, content: content.length ? serialized : null };
    if (message.toolCalls?.length) result.tool_calls = message.toolCalls.map(call => ({
      id: call.id, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments ?? {}) }
    }));
    return result;
  });
}

function normalize(body, model) {
  if (body.error) throw new ProviderError('模型服务返回错误。', { code: 'API_ERROR' });
  const message = body.choices?.[0]?.message;
  if (!message) throw new ProviderError('模型响应缺少消息。', { code: 'INVALID_RESPONSE' });
  const contents = [];
  if (typeof message.content === 'string' && message.content) contents.push({ type: 'text', text: message.content });
  else if (Array.isArray(message.content)) for (const part of message.content) {
    if (part.type === 'text' && part.text) contents.push({ type: 'text', text: part.text });
    else if (part.type === 'image_url') contents.push({ type: 'image', url: part.image_url?.url });
    else if (part.type === 'image' && (part.data || part.url)) contents.push({ type: 'image', data: part.data, url: part.url, mime: part.mime_type });
  }
  if (message.refusal) contents.push({ type: 'text', text: message.refusal });
  const reasoning = message.reasoning_content ?? message.reasoning ?? message.thinking_content;
  if (reasoning) contents.push({ type: 'reasoning', text: reasoning });
  const toolCalls = (message.tool_calls ?? []).map(call => toolCall(call.id, call.function?.name, call.function?.arguments));
  return ensureResponse({ contents, toolCalls, model: body.model || model, provider: 'openai',
    usage: usage(body.usage?.prompt_tokens, body.usage?.completion_tokens, body.usage?.total_tokens) });
}

async function streamed(response, request) {
  let text = '';
  let reasoning = '';
  let model = request.model;
  let tokenUsage;
  let finished = false;
  const calls = new Map();
  for await (const event of readSse(response)) {
    if (event.data === '[DONE]') { finished = true; break; }
    const chunk = parseEvent(event.data);
    if (chunk.error) throw new ProviderError('模型流式请求返回错误。', { code: 'API_ERROR' });
    model = chunk.model || model;
    if (chunk.usage) tokenUsage = chunk.usage;
    const choice = chunk.choices?.[0];
    if (choice?.finish_reason) finished = true;
    const delta = choice?.delta ?? {};
    if (delta.content) {
      text += delta.content;
      await request.onDelta?.({ type: 'text', text: delta.content });
    }
    const thought = delta.reasoning_content ?? delta.reasoning ?? delta.thinking_content;
    if (thought) { reasoning += thought; await request.onDelta?.({ type: 'reasoning', text: thought }); }
    for (const call of delta.tool_calls ?? []) {
      const current = calls.get(call.index ?? 0) ?? { id: '', name: '', arguments: '' };
      if (call.id) current.id = call.id;
      if (call.function?.name) current.name += call.function.name;
      if (call.function?.arguments) current.arguments += call.function.arguments;
      calls.set(call.index ?? 0, current);
    }
  }
  if (!finished) throw new ProviderError('模型流式响应中断。', { code: 'INCOMPLETE_STREAM' });
  return normalize({ model, usage: tokenUsage, choices: [{ message: { content: text, reasoning_content: reasoning,
    tool_calls: [...calls.values()].map(call => ({ id: call.id, function: { name: call.name, arguments: call.arguments } })) } }] }, model);
}

export async function completeOpenAI(request, { fetchImpl = fetch } = {}) {
  validateRequest(request);
  const { channel, model, messages, options = {}, tools = [] } = request;
  const signal = requestSignal(request.signal, options.timeoutMs ?? channel.timeoutMs ?? 25000);
  const body = { model, messages: openaiMessages(messages), stream: Boolean(options.stream) };
  if (options.temperature !== undefined) body.temperature = options.temperature;
  if (options.maxTokens !== undefined) {
    const tokenParameter = options.maxTokensParameter || (/^(?:o[1-9](?:[-.]|$)|gpt-[5-9](?:[-.]|$))/i.test(model) ? 'max_completion_tokens' : 'max_tokens');
    if (!['max_tokens', 'max_completion_tokens'].includes(tokenParameter)) throw new ProviderError('最大 token 参数名无效。', { code: 'INVALID_OPTIONS' });
    body[tokenParameter] = options.maxTokens;
  }
  if (options.reasoningEffort) body.reasoning_effort = options.reasoningEffort;
  if (tools.length) body.tools = tools.map(tool => ({ type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.inputSchema } }));
  if (tools.length && options.toolChoice) body.tool_choice = options.toolChoice;
  if (options.stream) body.stream_options = { include_usage: true };
  const response = await post(endpoint(channel.baseUrl, '/chat/completions', 'https://api.openai.com/v1'), body, {
    provider: 'OpenAI', signal, fetchImpl, headers: channel.apiKey ? { authorization: `Bearer ${channel.apiKey}` } : {}
  });
  if ((response.headers.get('content-type') || '').includes('text/event-stream')) return streamed(response, { ...request, signal });
  return normalize(await readJson(response), model);
}
