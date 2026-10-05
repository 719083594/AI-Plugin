import { randomUUID } from 'node:crypto';
import { ProviderError, ensureResponse, httpUrl, loadImageData, parseEvent, parts, plannedCapability, post, readJson, readSse, requestSignal, textContent, toolCall, usage, validateRequest } from './common.mjs';

export async function geminiMessages(messages, transport) {
  const system = [];
  const contents = [];
  const callNames = new Map();
  for (const message of messages) for (const call of message.toolCalls ?? []) callNames.set(call.id, call.name);
  for (const message of messages) {
    if (['system', 'developer'].includes(message.role)) { system.push(textContent(message)); continue; }
    const converted = [];
    if (message.role === 'tool') {
      const name = message.name || callNames.get(message.toolCallId);
      if (!name) throw new ProviderError('Gemini 工具结果缺少对应工具名称。', { code: 'INVALID_MESSAGES' });
      const text = textContent(message);
      let response;
      try { response = JSON.parse(text); } catch { response = { result: text }; }
      if (!response || typeof response !== 'object' || Array.isArray(response)) response = { result: response };
      converted.push({ functionResponse: { name, response, id: message.toolCallId } });
    } else {
      for (const part of parts(message)) {
        if (part.type === 'text') converted.push({ text: String(part.text ?? ''), ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
        else if (part.type === 'reasoning') {
          // Gemini thought signatures must accompany their original parts in tool follow-ups.
          if (part.thoughtSignature) converted.push({ text: part.text || '', thought: true, thoughtSignature: part.thoughtSignature });
        } else if (part.type === 'image') {
          const image = await loadImageData(part, transport);
          converted.push({ inlineData: { mimeType: image.mime, data: image.data }, ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
        } else throw plannedCapability(part.type === 'audio' ? '语音输入' : '该多模态输入');
      }
      for (const call of message.toolCalls ?? []) converted.push({
        functionCall: { id: call.id, name: call.name, args: call.arguments ?? {} },
        ...(call.thoughtSignature ? { thoughtSignature: call.thoughtSignature } : {})
      });
    }
    if (!converted.length) continue;
    const role = message.role === 'assistant' ? 'model' : 'user';
    if (contents.at(-1)?.role === role) contents.at(-1).parts.push(...converted);
    else contents.push({ role, parts: converted });
  }
  return { contents, ...(system.filter(Boolean).length ? { systemInstruction: { parts: [{ text: system.filter(Boolean).join('\n\n') }] } } : {}) };
}

function normalize(body, model) {
  if (body.error) throw new ProviderError('Gemini 服务返回错误。', { code: 'API_ERROR' });
  const candidate = body.candidates?.[0];
  if (!candidate) throw new ProviderError('Gemini 未返回候选消息，可能被安全策略阻止。', { code: 'EMPTY_RESPONSE' });
  const contents = [];
  const toolCalls = [];
  for (const part of candidate.content?.parts ?? []) {
    if (part.text) contents.push({ type: part.thought ? 'reasoning' : 'text', text: part.text,
      ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
    const inline = part.inlineData ?? part.inline_data;
    if (inline?.data) {
      const mime = inline.mimeType ?? inline.mime_type;
      if (!mime?.startsWith('image/')) throw plannedCapability('音频或视频输出');
      contents.push({ type: 'image', data: inline.data, mime,
        ...(part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}) });
    }
    if (part.functionCall) toolCalls.push(toolCall(part.functionCall.id || `gemini-${randomUUID()}`, part.functionCall.name, part.functionCall.args ?? {},
      part.thoughtSignature ? { thoughtSignature: part.thoughtSignature } : {}));
  }
  const u = body.usageMetadata ?? {};
  return ensureResponse({ contents, toolCalls, provider: 'gemini', model: body.modelVersion || model,
    usage: usage(u.promptTokenCount ?? 0, (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0), u.totalTokenCount) });
}

function geminiEndpoint(channel, model, stream) {
  const url = httpUrl(channel.baseUrl || 'https://generativelanguage.googleapis.com/v1beta');
  if (url.search || url.hash) throw new ProviderError('渠道基础地址不能包含查询参数或片段。', { code: 'INVALID_URL' });
  let path = url.pathname.replace(/\/+$/, '');
  if (!path) path = '/v1beta';
  const name = model.replace(/^models\//, '');
  url.pathname = `${path}/models/${encodeURIComponent(name)}:${stream ? 'streamGenerateContent' : 'generateContent'}`;
  if (stream) url.searchParams.set('alt', 'sse');
  return url;
}

export async function completeGemini(request, { fetchImpl = fetch, lookup } = {}) {
  validateRequest(request);
  const { channel, model, messages, options = {}, tools = [] } = request;
  const signal = requestSignal(request.signal, options.timeoutMs ?? channel.timeoutMs ?? 25000);
  const body = await geminiMessages(messages, { signal, fetchImpl, lookup });
  body.generationConfig = {};
  if (options.temperature !== undefined) body.generationConfig.temperature = options.temperature;
  if (options.maxTokens !== undefined) body.generationConfig.maxOutputTokens = options.maxTokens;
  if (options.responseModalities) body.generationConfig.responseModalities = options.responseModalities;
  if (options.thinkingBudget !== undefined) body.generationConfig.thinkingConfig = { thinkingBudget: options.thinkingBudget, includeThoughts: Boolean(options.showReasoning) };
  if (tools.length) body.tools = [{ functionDeclarations: tools.map(tool => ({ name: tool.name, description: tool.description, parametersJsonSchema: tool.inputSchema })) }];
  const builtins = { googleSearch: 'googleSearch', googleMaps: 'googleMaps', codeExecution: 'codeExecution', urlContext: 'urlContext' };
  if (options.geminiBuiltinTools?.length) {
    if (tools.length && !/(?:^|\/)gemini-3(?:[.-]|$)/i.test(model)) {
      throw new ProviderError('当前 Gemini 模型不支持同时启用内置工具和自定义工具，请在预设中选择其中一种。', { code: 'INVALID_OPTIONS' });
    }
    body.tools ??= [];
    for (const name of options.geminiBuiltinTools) {
      if (!builtins[name]) throw new ProviderError('Gemini 内置工具名称无效。', { code: 'INVALID_OPTIONS' });
      body.tools.push({ [builtins[name]]: {} });
    }
  }
  const response = await post(geminiEndpoint(channel, model, options.stream), body, {
    provider: 'Gemini', signal, fetchImpl, headers: channel.apiKey ? { 'x-goog-api-key': channel.apiKey } : {}
  });
  if (!(response.headers.get('content-type') || '').includes('text/event-stream')) return normalize(await readJson(response), model);
  const aggregate = { candidates: [{ content: { parts: [] } }] };
  let finished = false;
  for await (const event of readSse(response)) {
    const chunk = parseEvent(event.data);
    if (chunk.error) throw new ProviderError('Gemini 流式服务返回错误。', { code: 'API_ERROR' });
    if (chunk.usageMetadata) aggregate.usageMetadata = chunk.usageMetadata;
    aggregate.modelVersion = chunk.modelVersion || aggregate.modelVersion;
    const candidate = chunk.candidates?.[0];
    if (candidate?.finishReason) finished = true;
    for (const part of candidate?.content?.parts ?? []) {
      const accumulated = aggregate.candidates[0].content.parts;
      const previous = accumulated.at(-1);
      if (part.text !== undefined && previous?.text !== undefined && Boolean(part.thought) === Boolean(previous.thought)) {
        previous.text += part.text;
        if (part.thoughtSignature) previous.thoughtSignature = part.thoughtSignature;
      } else accumulated.push(part);
      if (part.text) await request.onDelta?.({ type: part.thought ? 'reasoning' : 'text', text: part.text });
    }
  }
  if (!finished) throw new ProviderError('Gemini 流式响应中断。', { code: 'INCOMPLETE_STREAM' });
  return normalize(aggregate, model);
}
