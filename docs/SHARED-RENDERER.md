# 可选图片渲染协作

`ai-plugin/renderer` 或 `src/rendering/index.mjs` 是纯图片转换入口。它导出 `createNativeCardRenderer`、`NativeCardRenderError` 和 `getNativeRenderStatus`，导入时不初始化 AI 聊天、适配器、账户、数据库或配置。现有约束及调用样例见 [渲染器协议](RENDERER.md)。

其他插件可以保留自己的 SVG 模板、资产解析和严格原生后端，再按需复用此入口。推荐由调用插件提供 `loadSharp: () => import('sharp')`，固定 sharp 0.35.5。AI-Plugin 不需要模型、API Key 或聊天启用状态即可提供转换服务；未安装 AI-Plugin 时，调用插件仍应能够使用自己的转换器。

原神与三国杀插件的 `createSharedNativeCardRenderer` 使用这种可选桥接：优先调用已安装的 AI 纯渲染服务，加载不可用或原生工作实际失败结束后使用本插件后端；失败的可选导入允许后续重新尝试。输入、图片及 SVG 校验失败和队列已满均直接报告，不通过切换后端绕过限制。共享和本地严格转换器复用 `ai-plugin.memory-native-card-renderer.v1` 的进程级队列，最多一项工作和两项等待。

卡片视觉质量由模板与素材决定。此 API 只将可信 SVG 转为 JPEG Buffer，不调用模型设计界面或上传个人数据。账户归属、私聊限制、昵称转义与素材验证仍由调用插件完成；两种转换路径都必须接收显式 `private` 标记。个人图像只在内存中处理，日志与指标不携带卡片、昵称、账号、凭据或上游错误。
