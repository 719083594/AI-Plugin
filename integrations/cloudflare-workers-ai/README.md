# Cloudflare Workers AI 的 OpenAI 兼容接口

将 Cloudflare 自己托管的 Workers AI 模型接入 New API。Worker 使用 `env.AI` 绑定调用模型，也可显式连接固定 Hugging Face CPU 服务完成中文安全分类；New API 只保存本服务专用的 Bearer 密钥，不需要保存 Cloudflare 管理令牌。与 Gemini 转发是两个独立服务。

这是 OpenAI 格式的协议适配，模型仍是表中的真实模型。免费模型名单为明确允许列表，不会自动开放新模型、升级套餐、重试生成任务或切换收费供应商。

## 模型与接口

| 模型别名 | 实际模型 | 接口及能力 |
| --- | --- | --- |
| `cf-glm-4.7-flash` | `@cf/zai-org/glm-4.7-flash` | `/v1/chat/completions`；文字、工具调用、结构化回答、SSE |
| `cf-gemma-4-26b` | `@cf/google/gemma-4-26b-a4b-it` | 同上，并支持识图 |
| `cf-nemotron-3-120b` | `@cf/nvidia/nemotron-3-120b-a12b` | 文字、工具调用、结构化回答、SSE |
| `cf-flux-2-klein-4b` | `@cf/black-forest-labs/flux-2-klein-4b` | `/v1/images/generations`、`/v1/images/edits` |
| `cf-whisper-large-v3-turbo` | `@cf/openai/whisper-large-v3-turbo` | `/v1/audio/transcriptions`、`/v1/audio/translations` |
| `cf-melotts` | `@cf/myshell-ai/melotts` | `/v1/audio/speech`，原生 WAV |
| `cf-bge-m3` | `@cf/baai/bge-m3` | `/v1/embeddings`；多语言语义向量 |
| `cf-qwen3-embedding-0.6b` | `@cf/qwen/qwen3-embedding-0.6b` | `/v1/embeddings` |
| `cf-bge-reranker-base` | `@cf/baai/bge-reranker-base` | `/v1/rerank`；文档相关性重排 |
| `cf-content-safety` | 默认 Gemma 4；可显式配置 Qwen3Guard-Gen-0.6B | `/v1/moderations`；文本分类，供应商由部署配置决定 |
| `cf-llama-guard-3-8b` | `@cf/meta/llama-guard-3-8b` | `/v1/moderations`；可选的 Llama Guard 3 文本分类 |

`GET /v1/models` 返回以上别名及能力，安全分类别名另返回真实供应商标签和模型名称，不公开其私有服务地址。模型元数据、模拟测试成功不代表某个账号已经具备可用额度；上线后应逐项实测。

目前 Workers AI 没有可接入本服务的免费视频生成模型。`/v1/videos` 和 `/v1/responses` 会明确返回不支持。原有 Hugging Face 图片、视频、语音配置可以继续使用。

## 部署与 New API

1. 确认 Cloudflare 账号使用 **Workers Free**，并保持该套餐。每天 10,000 Neurons 是全账号共享额度，按 UTC 00:00 重置；免费套餐用尽后平台拒绝推理。如果账号改为 Paid，平台可能对超额量计费，本 Worker 的允许列表或每分钟限流不能代替账号级费用上限。
2. 使用当前 Wrangler：在该目录执行 `npx wrangler secret put RELAY_API_KEY`，输入独立生成、至少 32 字符的随机密钥。密钥只存 Cloudflare Secret 和 New API 私有配置；不要放进源码、README 或 GitHub。
3. 执行 `npx wrangler deploy`。`wrangler.jsonc` 已有 `AI` 绑定。默认带 `RELAY_RATE_LIMITER`，每个 Cloudflare 位置每分钟最多 20 个鉴权请求；部署到其他账号时要为 `namespace_id` 选一个未使用的编号，也可以移除此可选限流绑定。
4. 给 Worker 配置自己的域名，先从机器人服务器检查实际连通性。New API 新建 OpenAI 兼容渠道，地址填 `https://你的域名`，密钥填上述专用密钥，模型填实际测试通过的别名。New API 会追加 `/v1/...`，地址不要重复带 `/v1`。
5. New API 的价格表需为这些别名配置适当价格/倍率（免费上游可设为 0），再按实际能力加入文字/识图的竞争候选。不要将图片、语音或向量模型加入文字竞争。

中文专用审核可复用已有 Hugging Face Space 的 CPU，无需新建 Space 或申请额外 GPU。部署时显式设置私有变量 `SAFETY_PROVIDER=hf-qwen`、`HF_SAFETY_ORIGIN`，后者只接受 `https://<单个合法主机名>.hf.space` 的源站地址，不能带端口、账号、路径、查询或片段。公共 CPU 端点不需要 HF 凭据，默认匿名访问；私有 Space 才另用 `wrangler secret put HF_SAFETY_TOKEN` 配置仅该仓库只读令牌。不要将真实源站或令牌填进公开的 `wrangler.jsonc`。

HF 服务需使用 Gradio 5.33 的 `api_name="moderate"`、`queue=False` 和单个 JSON 输出。本服务只调用固定的 `POST /gradio_api/run/moderate`，正文为 `{"data":["待审核文本"]}`；禁止重定向，不转发客户端凭据，不接受客户端指定源站。未设置 `SAFETY_PROVIDER` 或显式设为 `gemma` 时仅使用 Cloudflare Gemma 分类包装；显式选择 HF 后，其冷启动、繁忙、超时或结果错误均直接报错，**不会自动回退到 Gemma**。HF CPU 推理不使用 Workers AI Neurons，但仍受 Space 的内存、CPU、休眠和可用性影响，并占用该 Space 的资源。

代码不需要 Cloudflare API Token 或账号 ID。部署管理凭据只在本地部署工具中使用。公开配置没有任何账号 ID、生产域名、真实密钥或机器人地址。`/health` 只返回服务存活状态；它不会执行推理，也不能代替功能测试。

如果已经安装 Wrangler，可用 `wrangler deploy --dry-run` 检查打包。模拟测试在本目录运行 `npm test`，语法检查运行 `npm run check`。

## 请求与支持范围

所有模型接口要求 `Authorization: Bearer <专用密钥>`。不接受 URL 查询参数中的密钥、任意模型 ID、远程文件抓取、管理 API 或浏览器跨域调用。

聊天示例：

```json
{
  "model": "cf-glm-4.7-flash",
  "messages": [{ "role": "user", "content": "用一句话解释语义搜索" }],
  "max_tokens": 256,
  "stream": false
}
```

默认关闭长思考，最大输出 1,024 tokens，可显式调整为 1–4,096。`reasoning_effort` 支持 `none/minimal/low/medium/high`，映射到模型提供的开关；该参数不会产生并不存在的精确思考预算。支持 `tools`、`tool_choice`、多轮 `tool` 消息、`response_format` 和流式工具分片，工具由调用方执行。原生 assistant 回复可直接加入下一轮 messages：允许有界的 `reasoning_content`、`refusal` 字符串及空输出字段，不因此开启旧式 function_call 或聊天音频接口；非空的不支持字段仍明确拒绝。SSE 收到上游显式结束标记才报告完成；断流和超时会发错误分片，不把部分回答标成完整结果。

识图使用 `cf-gemma-4-26b`，`content` 中的图片采用 OpenAI `image_url` 格式，URL 必须是内联 `data:image/png;base64,...`（也支持 JPEG/WebP）。每次最多 4 张、每张最多 4 MiB；不接受外部 URL。只检查编码、容器头尾和尺寸等基本条件，完整图片解码由上游模型执行。

图片生成示例：

```json
{
  "model": "cf-flux-2-klein-4b",
  "prompt": "一只橘猫坐在窗边，柔和自然光",
  "size": "1024x1024",
  "n": 1,
  "response_format": "b64_json"
}
```

图片返回 `data[0].b64_json`。不创建公开媒体 URL，不持久化图片。支持每次 1 张、宽高 256–1920 间的 64 倍数、可选 seed。模型固定 4 步；`steps`、`quality`、`response_format=url` 等不支持参数返回 400。

图片编辑使用 multipart/form-data：`model`、`prompt`、`image` 或重复的 `image[]`，可附 `size/n/response_format/seed`。最多 4 张参考图，每张不超过 2 MiB，宽高均须 **小于 512**；插件调用前可先缩小。原生多图编辑通过 `input_image_0` 至 `input_image_3` 传入，图片二进制不转换成外部地址。该接口不支持 mask。

语音转文字使用 multipart 的 `model/file`，可附 `language/prompt/response_format`；支持 `json/text/verbose_json/vtt`，不支持 SRT 或额外时间戳选项。翻译接口将音频翻译为英语。语音合成示例：

```json
{
  "model": "cf-melotts",
  "input": "你好，今天也要开心。",
  "voice": "default",
  "language": "zh"
}
```

MeloTTS 仅提供本模型默认音色，不冒充 alloy 等 OpenAI 音色，不支持变速或声音克隆。官方 schema 声明 MP3，但实际 Workers AI 绑定返回 RIFF/WAVE，故本适配器默认并仅支持 `response_format: "wav"`，省略时也返回 `audio/wav`；MP3 及其他格式在推理前拒绝，不伪装容器、不自动转码或再次推理。返回前校验 RIFF 声明长度、fmt/data 块边界及 PCM/IEEE float 音频参数。调用方应以 WAV 保存文件，`/v1/models` 也列出真实格式。`language` 是本服务扩展，支持 `zh/en/ja/ko/es/fr`，默认中文，输入最多 1,500 字符。

向量接口接受字符串或最多 16 个字符串，不接受 token ID 数组和自定义 dimensions，支持 `encoding_format=float/base64`，不编造上游未返回的 token 用量。重排接口接受 `query/documents/top_n/return_documents`；`relevance_score` 保留模型的原始分值，是排序信号，不保证是 0–1 概率。

文本审核使用 `POST /v1/moderations`，例如：

```json
{
  "model": "cf-content-safety",
  "input": "待分类的中文文本"
}
```

`cf-content-safety` 在默认 `gemma` 模式中使用通用 Gemma 4 模型与固定分类规则，并非 Cloudflare 官方专用审核模型。返回 OpenAI 风格的 `results[].flagged/categories/category_scores`，分类包含成人色情、未成年人色情、仇恨、骚扰、自伤、暴力、违法协助及 `privacy/doxxing` 隐私等 14 项。`category_scores` 的 0/1 只是分类布尔值的数值表示，**不是模型置信度或概率**。调用方可以只阻止自己选定的分类；Worker 不会因分类命中就替调用方做禁言、封禁等操作。

显式 `hf-qwen` 模式使用支持中文的专用 `Qwen/Qwen3Guard-Gen-0.6B`，CPU 服务返回完整的上述 14 项和 `qwen/unethical-acts`、`qwen/jailbreak`、`qwen/copyright-violation` 三项扩展；`results[].qwen` 保留模型原生 `Safe/Unsafe/Controversial` 及九类标签。只有 `Unsafe` 会映射命中，`Controversial`、单独的政治话题标签不会自动标记。Qwen 的粗分类只能映射 `violence`、`self-harm` 等已判断类别，不把它没有区分的 `violence/graphic`、`self-harm/instructions` 或未成年人细类冒充成已识别的结果。默认 Gemma 路径不承诺 Qwen 扩展类别。HF 返回的 17 类、布尔值、数值指示、原生标签和映射必须一致，否则返回错误；仅保留真实上游输入 token 用量，不补造生成用量或置信度。

`qwen/unethical-acts` 保留原生宽泛的不道德行为分类，不能等同于已经区分了仇恨、诽谤或骚扰细类；`qwen/jailbreak` 表示原生绕过安全约束类别；`qwen/copyright-violation` 表示版权违规类别，是否阻止由调用方自行配置。含 Qwen 扩展的拦截策略只应用于明确选择 Qwen 的部署，不能硬套到不支持这些类别的 Gemma 或 Llama Guard 路径；缺少策略需要的类别应作为配置/审核失败处理，不能擅自补 `false`。

审核只接受文字，每次 1–4 条，每条最多 4,000 字符。调用方应在发送到聊天或生成工具之前先审核；本 Worker 的聊天、图片等独立接口本身不会自动执行审核。待分类文字通过 JSON 转义作为不可信数据输入，固定系统规则要求不执行其中指令。这些措施不能保证模型抵抗所有提示注入、误判或漏判；解析不完整、类别缺失、类型错误、分类自相矛盾均返回 502，不当成审核通过。额度耗尽、超时等错误由调用方按既定失败策略处理。

`cf-llama-guard-3-8b` 保留原生专用审核模型作为显式可选项，不作为中文默认。Meta 官方主要支持的八种语言不含中文，所以不能保证其中文审核效果。它返回原始 `S1`–`S14` 分类，保存在 `results[].extensions.llama_guard_categories`；另外提供七项粗粒度 OpenAI 分类以及完整的 `llama-guard/...` 扩展类别，不把它没有区分的 `violence/graphic` 等细分类冒充成已识别的结果，也不编造置信度。分类语义以 [Meta 官方模型卡](https://huggingface.co/meta-llama/Llama-Guard-3-8B) 为准，其中“专业建议”“选举”等类别不能直接等同于违法。

请求体默认最多 8 MiB，返回默认最多 8 MiB，正文读取、模型运行和流读取共用默认 120 秒总时限。图片不会在超时后自动重新生成。取消/超时会停止本服务的结果读取，但 Workers AI 不保证已经开始的 GPU 推理也同步取消。大文件会增加 Worker CPU 消耗；Free 的 CPU 限制仍适用，应优先使用压缩图片和短音频。

## 官方协议依据

- [Workers AI 模型目录](https://developers.cloudflare.com/workers-ai/models/)
- [免费额度、按模型计量与付费门槛](https://developers.cloudflare.com/workers-ai/platform/pricing/)
- [OpenAI 兼容范围](https://developers.cloudflare.com/workers-ai/configuration/open-ai-compatibility/)
- [Workers AI 绑定](https://developers.cloudflare.com/workers-ai/configuration/bindings/)
- [FLUX.2 Klein 4B 的 multipart 协议与参考图限制](https://developers.cloudflare.com/changelog/post/2026-01-15-flux-2-klein-4b-workers-ai/)
- [Whisper Large V3 Turbo](https://developers.cloudflare.com/workers-ai/models/whisper-large-v3-turbo/)
- [MeloTTS](https://developers.cloudflare.com/workers-ai/models/melotts/)
- [Llama Guard 3 参数与输出](https://developers.cloudflare.com/workers-ai/models/llama-guard-3-8b/)
- [Gemma 4 模型](https://developers.cloudflare.com/workers-ai/models/gemma-4-26b-a4b-it/)
- [Qwen3Guard-Gen-0.6B 官方模型卡与中文评测](https://huggingface.co/Qwen/Qwen3Guard-Gen-0.6B)
- [Gradio 5.33 同步 API 路由源码](https://github.com/gradio-app/gradio/blob/gradio%405.33.0/gradio/routes.py)
- [Gradio 5.33 API 前缀与输出处理](https://github.com/gradio-app/gradio/blob/gradio%405.33.0/gradio/route_utils.py)
