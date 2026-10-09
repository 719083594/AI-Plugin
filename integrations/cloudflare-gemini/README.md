# OrangeJuice Gemini Relay

用于 New API 和 AI 插件的 Cloudflare Workers Gemini 转发服务。固定上游 `https://generativelanguage.googleapis.com`，无公开聊天界面，也不接受自定义目标网址。

## 配置

Worker 名称：`orangejuice-gemini-relay`。用 Cloudflare Secret 分别保存：

- `GEMINI_API_KEY`：Google 原始密钥，仅在 Worker 调用 Google 时使用。
- `RELAY_API_KEY`：至少 32 个字符的独立随机转发密钥，保存到 New API 的对应渠道密钥位置。

两个密钥必须不同，缺少配置时接口返回 503。不要把密钥写进本项目、`wrangler.jsonc`、README 或 GitHub；本地 `.dev.vars` 也已忽略。

New API 的 **Gemini 渠道** base URL 填 Worker 的根地址，如 `https://orangejuice-gemini-relay.<account>.workers.dev`，不要再追加 `/v1` 或 `/v1beta`。渠道自身负责添加 Gemini API 版本与路径。OpenAI 兼容客户端 base URL 则是根地址加 `/v1beta/openai`。

首选 `Authorization: Bearer <RELAY_API_KEY>` 或 `x-goog-api-key: <RELAY_API_KEY>`。为兼容 New API 的媒体下载，也支持 `?key=<RELAY_API_KEY>`；此参数只用于 Worker 鉴权，不传给 Google。多个鉴权来源同时存在时必须全部正确。

## 支持范围

- `/v1/models`、`/v1beta/models` 模型列表与单个模型元数据。
- `/v1/models/{model}:...`、`/v1beta/models/{model}:...` 的 `generateContent`、`streamGenerateContent`、`countTokens`、`embedContent`、`predict`、`predictLongRunning`。
- `/v1beta/operations/{id}` 和 `/v1beta/models/{model}/operations/{id}` 的 Veo 任务查询。
- `/v1beta/files/{id}` 元数据及 `/v1beta/files/{id}:download?alt=media` 媒体下载，支持单段 Range。
- `/v1beta/openai/chat/completions`、`images/generations`、`embeddings`、`models`。

模型是否可用、是否需要付费，以及图像/视频额度，由实际 Google 项目决定。代理不会赋予额外额度。Veo 创建任务与轮询是分开的请求；生成结果中的 Google 文件 URL 会改写成当前 Worker 的受鉴权下载 URL，不携带任何密钥。

当前不开放上传、删除、调优、批量任务和 OpenAI `videos` multipart API。视频使用原生 Gemini `predictLongRunning` 协议。上游重定向统一拒绝，避免将密钥交给其他域名；若 Google 某个下载实际依赖重定向，该下载会安全失败，需要针对实测协议另行实现。

## 限制和保护

固定上游和路径/方法/查询参数白名单；拒绝跨站浏览器请求；没有通配 CORS。只转发必要请求头。上游 429 与 `Retry-After` 保留；响应不缓存，不透传敏感头。JSON 和 SSE 中的密钥会遮蔽，SSE 支持跨网络分块遮蔽，不缓冲整个对话。

默认请求体上限 8 MiB，JSON 响应上限 16 MiB，媒体下载上限 64 MiB，整次请求/流式传输超时 180 秒。流式超过上限或超时会关闭流。可通过 `wrangler.jsonc` 中非敏感变量调整。Worker 不记录请求/响应内容、鉴权头或密钥；配置关闭 Workers Observability。

可选 `RELAY_RATE_LIMITER` 绑定按共享客户端预算限流；`wrangler.jsonc` 提供注释示例。启用时应选账户中尚未使用的 namespace；未启用绑定时只有密钥鉴权及上游配额。绑定故障会拒绝请求。Workers 的限流适用于各 Cloudflare 位置，并非精确的账户总账或财务消费上限。需要额外消费保护时应配置 Google 项目/模型额度。

## 验证与部署

```powershell
npm test
npm run check
# 使用已登录且授权到本 Worker 的 Wrangler；不要把密钥放到命令参数里。
wrangler secret put GEMINI_API_KEY
wrangler secret put RELAY_API_KEY
wrangler deploy
```

`GET /health` 只返回 `{"ok":true}`，用于进程探活。它不调用 Google，也不证明密钥、模型、额度或生产功能可用；必须另外进行受鉴权的模型与实际生成测试。

测试使用隔离的模拟上游，不消耗真实额度，覆盖未鉴权/冲突鉴权、目标网址与路径绕过、超限、429、SSE、密钥遮蔽、视频 URI 重写、二进制下载、网络超时及限流失败。

## 协议参考

- [Gemini generateContent API](https://ai.google.dev/api/generate-content)
- [Gemini OpenAI 兼容接口](https://ai.google.dev/gemini-api/docs/openai)
- [Gemini Veo 视频任务与下载](https://ai.google.dev/gemini-api/docs/veo)
- [Gemini Files API](https://ai.google.dev/api/files)
- [Cloudflare Workers Rate Limiting](https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/)
