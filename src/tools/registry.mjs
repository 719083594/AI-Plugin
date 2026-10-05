export class ToolError extends Error {
  constructor(message, code = 'TOOL_ERROR') { super(message); this.name = 'ToolError'; this.code = code; }
}

function validate(value, schema = {}, label = '参数') {
  if (schema.enum && !schema.enum.includes(value)) throw new ToolError(`${label}不在允许范围内。`, 'INVALID_TOOL_ARGUMENTS');
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ToolError(`${label}必须是对象。`, 'INVALID_TOOL_ARGUMENTS');
    for (const required of schema.required ?? []) if (!Object.hasOwn(value, required)) throw new ToolError(`缺少参数 ${required}。`, 'INVALID_TOOL_ARGUMENTS');
    for (const [key, item] of Object.entries(value)) {
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new ToolError('工具参数字段无效。', 'INVALID_TOOL_ARGUMENTS');
      if (schema.properties?.[key]) validate(item, schema.properties[key], `${label}.${key}`);
      else if (schema.additionalProperties === false) throw new ToolError(`未知参数 ${key}。`, 'INVALID_TOOL_ARGUMENTS');
    }
  } else if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolError(`${label}必须是文字。`, 'INVALID_TOOL_ARGUMENTS');
    if (schema.minLength !== undefined && value.trim().length < schema.minLength) throw new ToolError(`${label}不能为空。`, 'INVALID_TOOL_ARGUMENTS');
    if (schema.maxLength !== undefined && value.length > schema.maxLength) throw new ToolError(`${label}过长。`, 'INVALID_TOOL_ARGUMENTS');
  } else if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolError(`${label}必须是数组。`, 'INVALID_TOOL_ARGUMENTS');
    if (schema.maxItems !== undefined && value.length > schema.maxItems) throw new ToolError(`${label}数量过多。`, 'INVALID_TOOL_ARGUMENTS');
    for (const item of value) validate(item, schema.items, label);
  } else if (schema.type === 'boolean' && typeof value !== 'boolean') throw new ToolError(`${label}必须是布尔值。`, 'INVALID_TOOL_ARGUMENTS');
  else if (['number', 'integer'].includes(schema.type)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value))) throw new ToolError(`${label}必须是有效数值。`, 'INVALID_TOOL_ARGUMENTS');
    if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) throw new ToolError(`${label}超出范围。`, 'INVALID_TOOL_ARGUMENTS');
  }
}

function description(tool) {
  return { name: tool.name, description: tool.description, inputSchema: structuredClone(tool.inputSchema),
    ...(tool.status ? { status: tool.status } : {}), ...(tool.requiresMaster ? { requiresMaster: true } : {}) };
}

export class ToolRegistry {
  constructor(tools = []) { this.tools = new Map(); for (const tool of tools) this.register(tool); }

  register(tool, { replace = false } = {}) {
    if (!tool || !/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(tool.name) || typeof tool.execute !== 'function' || !tool.inputSchema || !tool.description) {
      throw new ToolError('工具定义无效。', 'INVALID_TOOL');
    }
    if (this.tools.has(tool.name) && !replace) throw new ToolError(`工具 ${tool.name} 已注册。`, 'DUPLICATE_TOOL');
    this.tools.set(tool.name, { ...tool, inputSchema: structuredClone(tool.inputSchema) });
    return this;
  }

  get(name) { const tool = this.tools.get(name); return tool ? description(tool) : undefined; }

  list({ names } = {}) {
    const selected = names === undefined ? [...this.tools.values()] : names.map(name => this.tools.get(name)).filter(Boolean);
    return selected.filter(tool => tool.enabled !== false).map(description);
  }

  async execute(name, args, context) {
    const tool = this.tools.get(name);
    if (!tool || tool.enabled === false) throw new ToolError(`工具 ${name} 不可用。`, 'TOOL_NOT_FOUND');
    if (!context?.signal || typeof context.signal.throwIfAborted !== 'function') throw new ToolError('工具调用必须提供取消信号。', 'SIGNAL_REQUIRED');
    context.signal.throwIfAborted();
    if (tool.requiresMaster && !context.isMaster) throw new ToolError('此工具仅允许管理员使用。', 'FORBIDDEN');
    let parsed = args ?? {};
    if (typeof parsed === 'string') {
      try { parsed = JSON.parse(parsed); } catch { throw new ToolError('工具参数 JSON 无效。', 'INVALID_TOOL_ARGUMENTS'); }
    }
    validate(parsed, tool.inputSchema);
    let onAbort;
    const cancelled = new Promise((_resolve, reject) => {
      onAbort = () => reject(context.signal.reason || new DOMException('工具调用已取消。', 'AbortError'));
      context.signal.addEventListener('abort', onAbort, { once: true });
    });
    let result;
    try { result = await Promise.race([Promise.resolve().then(() => tool.execute(parsed, context)), cancelled]); }
    finally { context.signal.removeEventListener('abort', onAbort); }
    context.signal.throwIfAborted();
    return result;
  }
}
