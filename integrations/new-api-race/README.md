# New API 有限并发竞速入口

这是 AI-Plugin 的可选外部网关。AI 插件继续调用 New API 中的稳定模型名，网关按能力和优先级选择已验证的上游模型。它单独运行，不由插件入口自动启动。

调用链：AI-Plugin → New API 稳定入口 → 本网关 → New API 候选别名 → 模型服务。

## 运行

需要 Node.js ≥ 22.13。把私有运行配置放在仓库之外，执行：

```bash
node gateway-race.mjs /path/to/private-gateway.json
```

私有配置包含以下字段，再合并 `policy.json` 的 `timeoutMs`、`inventoryTimeoutMs`、`requestTimeoutMs`、`headersTimeoutMs` 和 `race`：

```json
{
  "base": "http://new-api:3000/v1",
  "gatewayKey": "YOUR_NEW_API_TOKEN",
  "secret": "YOUR_GATEWAY_TOKEN",
  "port": 8080
}
```

`base` 是网关访问的 New API 地址。`gatewayKey` 用于读取候选目录和调用候选模型，`secret` 用于鉴权进入网关的请求。实际密钥、数据库、管理登录信息和用户预设不放入示例或仓库。

网关提供 OpenAI 兼容的 `POST /v1/chat/completions`，入口模型为 `qqbot-text`、`qqbot-vision`，当前仅支持非流式。New API 的稳定入口渠道映射到这两个模型；候选渠道则把 `qqbot-race-text-*`、`qqbot-race-vision-*` 映射到实际上游模型。候选必须指向上游渠道，不能再映射到稳定入口，否则会形成调用循环。

## 策略示例

`policy.json` 是 2026-10-07 实测后的公开示例，使用前须按自己的 New API 目录修改别名和能力：

- 文本首组选 Kimi、Qwen；失败后才尝试 DeepSeek Flash、GLM 5.3，再回退旧 GLM。
- 识图首组选 DeepSeek Flash Vision、Qwen；带工具的识图请求只使用已经验证支持两者的候选。
- 每组同时最多两路。Intern 资源组共享并发 2、RPM 40、估算 TPM 180 万及单次输出上限 4096，避免把整个模型目录一次发出。
- 主请求总时限 30 秒，为最终故障回退保留 6 秒。AI 实例示例时限为普通聊天 35 秒、工具任务 90 秒、渠道请求 35 秒；按实际网络和工具耗时调整。
- 工具后续轮次优先保持在同一赢家。缓存以调用方、当前用户消息、助手工具参数的摘要隔离；默认不缓存 reasoning 原文。

`aiInstanceTiming`、`manualOnlyModels`、`notes` 是部署参考字段，网关自身不读取。模型支持、速度、风格与限额会变化，需要自己验证；结构有效的回答不等于事实或角色风格一定正确。

New API 内部配额与供应商账单是两层配置。自用转发设内部倍率 0，并不会取消供应商的墨点扣费；不要把墨点换算成虚构的货币价格。已经启动的输家请求即使取消，也可能消耗上游额度。

出现 429 时按 Retry-After 冷却；识别到 Intern 配额耗尽则暂停该资源组，旧模型继续回退。确认配额恢复后可重启网关恢复尝试。此限流器仅覆盖单个网关进程，多副本或绕过网关的手动调用仍共用供应商账户限额。

## 验证

```bash
node --test --test-timeout=60000 gateway-race.test.mjs
```

31 个合成测试覆盖能力筛选、有限并发、配额暂停、回退预算、工具链隔离、取消传播、HTTP 鉴权与超时。测试不调用真实模型或读取运行凭据。详细边界见 [GATEWAY-VALIDATION.md](GATEWAY-VALIDATION.md)。

墨点费用与限制以官方文档为准：[模型与计费](https://cdn-static.openxlab.org.cn/magic-maker/action-static/tokenplan-doc/quick-start/04-model-limits-and-pricing.md)、[速率限制](https://cdn-static.openxlab.org.cn/magic-maker/action-static/tokenplan-doc/quick-start/05-rate-limits.md)。
