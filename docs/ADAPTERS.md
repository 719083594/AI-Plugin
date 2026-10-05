# 通用核心与适配协议

## 独立核心

`api.mjs` 导出 `AIClient`、`Storage`、配置读取和管理服务。导入核心不加载云崽，也不创建聊天请求。

```js
import {AIClient} from './api.mjs'
const client = new AIClient({root: '/srv/AI-Plugin'})
await client.loadExtensions()
const result = await client.chat({userId: 'local-user', text: '你好'})
console.log(result.text)
client.close()
```

模型请求需要已配置渠道和角色。宿主可提供 `host`、模型 `provider`、搜索回调和图片存储以集成其他平台。`isMaster` 是宿主确认的权限，不能直接相信来自普通用户的字段。

核心输入支持 `userId`、`botId`、`groupId`、`text`、规范化 `content`、图片数组、角色标识、头像回调及取消信号。输出包含 `text/contents/usage/model/presetId/usedTools/sources`。`contents` 使用文字、图片和可选结构化思考类型；宿主自行转换为平台消息。

`chat(input,{send,signal})` 的 `send` 回调在最终结果准备好后调用。失败应返回 `false` 或 `{discarded:true}`，成功返回送达凭据；不要把被丢弃的内容报告为成功。平台不提供可靠凭据时需在适配器中定义边界。

## 云崽入口

根 `index.js` 默认导出空 `apps`。只有实例配置 `config/integration.json` 的 `adapter` 为 `yunzai` 时，才导入 `integrations/yunzai/index.js` 和框架基类。`none` 明确禁用适配器。

适配器负责事件、主人身份、引用消息、群近期消息、图片、QQ 头像和实际回复。其他框架可以独立实现这些接口，不需要仿造云崽目录。主动接话、群历史与撤回属于宿主能力。

## 模型与自定义工具

协议层在 `src/providers`，支持单次 OpenAI、Gemini、Claude 请求和 SSE 响应解析。协议层支持 SSE 不等于 QQ/网页逐字回复；当前完整聊天链路收集后统一回复。自动重试、原生多渠道竞速、模型发现和 Embedding API 尚未实现。

`data/tools` 内的 `.mjs` 工具在启动时加载，默认导出需包含 `name/description/inputSchema/execute`。工具代码由部署者安装，本版没有执行沙箱。每个预设的 `tools` 数组声明可调用的 ID。`requiresMaster` 限制主人，注册表验证参数和取消信号。

搜索后端可实现 `createWebSearch({configPath}).search(query,type,{signal})`，或通用 `search({query,type,maxResults,signal})`。HTTP 模式使用 POST，正文为 `{query,image,maxResults}`，可带 `x-search-secret`。结果需包含真实 `results/items` 及标题、URL；图片结果可提供图片内容或地址。

## Orange 配置声明

主声明为 `orangejuice.plugin.json`，实例 JSON 为 `config/local.json`，默认示例为 `config/example.json`。配置 ID 是 `settings`，标记 `ownerOnly:true`。

`channels.*.apiKey` 等通配路径定义中文数组子字段。密钥用 `secret:true`，长提示词用 `multiline:true`，选项用 `enumLabels`。渠道和角色必须保存唯一、稳定的 `id`，删除或排序后仍按 ID 找到原密钥；新项需要实际密钥。

未实现的配置字段带 `readonly:true/status:"planned"`。Orange 1.2.1 显示状态说明，保留字段位置但不生成可启用开关。`capabilities.json` 包含完整57项路线，状态只描述已实现范围，不能代替实例验收。

`managementPanel:"ai-plugin"` 引用 Orange 实例中的 `externalPanels` 条目。部署者需要登记真实本机管理入口；插件声明不会自动生成凭据。

`scripts/panel-ticket.py --config /private/config/local.json --endpoint http://127.0.0.1:48371` 可作为 Orange 的入口命令。它读取实例管理密钥，向已有运行服务申请一次性链接，不另外启动 AI 实例；`--endpoint` 可指定容器映射后的本机地址。命令输出仅为主人登录链接，实例文件和链接不可提交到公开仓库。

## HTTP 管理接口

默认端口48371。`/api/ai-plugin/*` 是 `/api/*` 的别名。浏览器通过主人一次性登录链接取得会话 Cookie，写请求带 `X-AI-CSRF`；独立客户端使用 `Authorization: Bearer <实例管理密钥>`。

| 接口 | 当前行为 |
| --- | --- |
| `GET /health` | 公开本地健康状态，不调用模型 |
| `GET /api/session` | 主人会话和 CSRF 信息 |
| `POST /api/ticket` | 仅 Bearer 管理密钥可申请主人临时入口；浏览器 Cookie 无权调用 |
| `GET /api/config` | 配置遮罩、revision、中文 schema |
| `PUT /api/config` | `{value,revision}`；稳定标识保留密钥、校验、备份再保存 |
| `POST /api/chat` | `{text,presetId}`；主人网页聊天，等待完整结果 |
| `GET /api/capabilities` | 57项实际范围和路线 |
| `GET /api/logs` | 逐次记录、记录数、累计 Token/耗时/成功失败与按模型统计；不是费用统计 |
| `GET /api/users`、`GET /api/history` | 用户状态与历史查询 |
| `GET/POST/DELETE /api/memories` | 手工个人/群事实管理 |
| `POST /api/knowledge` | 导入纯文本资料 |
| `POST /api/reset` | 新会话，保留原历史 |
| `POST /api/cleanup`、`POST /api/backup` | 数据清理和数据库/配置快照 |
| `GET /v1/models` | 已启用预设配置的真实模型名称列表，不是上游模型发现 |
| `POST /v1/chat/completions` | 有限非流式兼容；保留传入消息角色，不写主人历史；不支持 SSE 和 embeddings |

完整文件打包、导出/导入、多管理员 ACL、Cloud、PostgreSQL、MCP 和工作流仍在路线中。CLI 恢复要求先停止使用该数据目录的服务。
