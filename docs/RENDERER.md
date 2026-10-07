# 共享原生卡片渲染器

AI-Plugin 提供不启动浏览器的 SVG → JPEG 服务。插件自己把经过筛选的数据排版为 SVG，再取得可发送的 JPEG Buffer。服务不调用 AI，不读取配置或账号，不保存图片，不下载素材。固定帮助图仍适合预先生成后直接读取。

```js
import {createNativeCardRenderer} from 'ai-plugin/renderer'

// 宿主也可传入 loadSharp，复用已经安装的 sharp 0.35.5。
const render = createNativeCardRenderer({loadSharp: () => import('sharp')})
const image = await render({
  svg: '<svg xmlns="http://www.w3.org/2000/svg" width="320" height="100" viewBox="0 0 320 100"><rect width="320" height="100" fill="#17313d"/><text x="16" y="56" fill="#ffffff" font-size="26">公开示例</text></svg>',
  width: 320,
  height: 100,
  private: false
})
// 将 image 交给宿主的图片消息接口。
```

只有受信任的本地 SVG builder 应调用这个 API。用户提供的昵称、说明等内容应由 builder 转义为 XML 文本。它不是任意 HTML、上传 SVG 或远程图片的截图接口。资产、战绩等本人数据必须传 `private: true`；公开资料必须传 `private: false`，省略或非布尔值会被拒绝。隐私标记不替代宿主的身份及私聊权限检查，两种模式都只返回内存数据。

`api.mjs` 同时导出该 API；独立插件通过 `src/rendering/index.mjs` 或 npm 子路径 `ai-plugin/renderer` 导入时，不初始化 AI、机器人适配器或数据库。只在首次有效请求时加载 sharp。后端必须是 **sharp 0.35.5**；AI-Plugin 不会自动下载或安装依赖。已有游戏插件可在其模块范围内注入 `loadSharp: () => import('sharp')`，避免重复安装。sharp 的 `cache(false)`、`concurrency(1)` 是进程级设置。

所有调用者、多个实例及模块重载共享同一个 FIFO：最多 1 个活跃渲染和 2 个等待任务。队列满时返回 `NATIVE_RENDER_BUSY`。只有 sharp 原生工作真正完成或失败才交接槽位；调用者自行设置的截止时间不会提前放行另一项原生工作。sharp 使用原生 10 秒超时，无另一个提前解锁的定时器。

输入限制：画布宽 320–1600、高 100–12000，最多 1200 万像素；SVG 不超过 4 MiB、10000 个节点和 32 层。仅允许基础图形、文本、局部渐变与裁切。拒绝 DTD、脚本、CSS、HTML、外部链接和自定义实体；嵌入图片仅允许规范 base64 的 PNG/JPEG，并校验魔数、尺寸及 PNG CRC，拒绝动画 PNG。最多 64 张嵌入图，每张 256 KiB、合计 2 MiB，解码总像素最多 1200 万。JPEG 输出最多 8 MiB。

`NativeCardRenderError` 仅包含安全的固定提示与以下稳定 `code`，不带原生错误、SVG、路径或用户数据：

| code | 含义 |
| --- | --- |
| `INVALID_NATIVE_CARD` | 输入、尺寸或显式隐私标记不合法 |
| `UNSAFE_NATIVE_SVG` | SVG 不符合支持的安全结构 |
| `INVALID_NATIVE_IMAGE` | 嵌入栅格或 JPEG 输出格式不合法 |
| `NATIVE_IMAGE_LIMIT` | 嵌入图片数量、字节或像素超限 |
| `NATIVE_RENDER_BUSY` | 进程共享队列已满 |
| `NATIVE_BACKEND_UNAVAILABLE` | 后端缺失、版本不符或加载失败 |
| `NATIVE_RENDER_FAILED` | 原生工作失败或超时 |

可选的 `onMetrics` 只收到冻结的 `{backend, elapsed, code}`，回调失败不影响渲染。`getNativeRenderStatus()` 只返回冻结的 `{active, queued, maxQueued}`。两者都没有图片内容、账号、文件路径或上游错误。

测试通过注入模拟后端验证队列、失败隔离及输入边界。运行机装有 sharp 时还会执行实际 JPEG 转换；可用 `AI_RENDERER_TEST_SHARP` 显式指定现有 sharp 的入口文件执行真实后端测试，测试素材全部为合成公开数据。

来源：渲染约束来自本作者 SGS-Mobile-Plugin 的内存卡片实现；原生转换使用 [sharp](https://sharp.pixelplumbing.com/) 及其 [libvips](https://www.libvips.org/) 后端。服务没有远程渲染 API。
