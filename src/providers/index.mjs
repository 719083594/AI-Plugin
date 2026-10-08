import { ProviderError } from './common.mjs';
import { completeOpenAI } from './openai.mjs';
import { completeGemini } from './gemini.mjs';
import { completeClaude } from './claude.mjs';

export { ProviderError, plannedCapability } from './common.mjs';
export { completeOpenAI } from './openai.mjs';
export { completeGemini } from './gemini.mjs';
export { completeClaude } from './claude.mjs';

export const providerCapabilities = Object.freeze({
  openai: { chat: true, vision: true, tools: true, streaming: true, nativeImageGeneration: false },
  gemini: { chat: true, vision: true, tools: true, streaming: true, nativeImageGeneration: 'model-dependent' },
  claude: { chat: true, vision: true, tools: true, streaming: true, nativeImageGeneration: false },
  planned: ['responses-api', 'speech-to-text', 'video', 'mcp', 'workflow']
});

/** One model request only. The caller owns history, retries, and tool execution. */
export async function complete(request, transport = {}) {
  const implementation = { openai: completeOpenAI, gemini: completeGemini, claude: completeClaude }[request.channel?.type];
  if (!implementation) throw new ProviderError('模型协议不受支持。', { code: 'UNSUPPORTED_PROVIDER' });
  return implementation(request, transport);
}

export function createProvider({ fetchImpl = fetch } = {}) {
  return { complete: request => complete(request, { fetchImpl }), capabilities: providerCapabilities };
}
