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

## 固定帮助图片

`buildStaticHelpCards` 为源码中的公开说明生成宽 1080 的原生 SVG 卡片，采用双栏分组、大字号指令与权限说明；长文本会换行，长帮助会分页，最多 8 页。支持 `dark`（默认）和 `light` 两种配色。它只接收下面的公开说明结构，不接收账号、会话、图片、SVG 或任意样式。不要将个人查询结果交给固定帮助构建器。

```js
import {buildStaticHelpCards, createNativeCardRenderer,
  createStaticHelpReader, hashStaticHelpSource} from 'ai-plugin/renderer'

const cards = buildStaticHelpCards({
  title: '群管 · GroupGuard',
  subtitle: '常用操作与权限，一张图快速查阅',
  groups: [{title: '查看与帮助', items: [
    {command: '#群管帮助', description: '查看公开指令说明'},
    {command: '禁言 @成员 [10分钟]', permission: '需要群管理员权限'}
  ]}],
  footer: '按说明发送命令即可使用。',
  theme: 'dark'
})
// cards: [{svg, width: 1080, height, private: false}, ...]
// 在离线构建脚本内逐张调用 render(card)，写入插件 resources/help/。
// 在线收到帮助命令时只调用 reader，不再启动浏览器或渲染器。
const render = createNativeCardRenderer({loadSharp: () => import('sharp')})
const image = await render(cards[0])

const readHelp = createStaticHelpReader({root: pluginRoot, defaultPrefix: '#群管'})
const images = readHelp({topic: 'help', private: false, prefix: '#群管'})
// 成功得到 Buffer[]，不存在、不匹配或校验失败得到 null。
```

离线构建脚本负责生成图片与 `resources/help/manifest.json`。只有内容变更时需要重新生成。源文件哈希必须调用 `hashStaticHelpSource(bytes)`：严格 UTF-8 解码、去除开头 BOM、把 CRLF/CR 规范为 LF，再计算 SHA-256。图片哈希使用原始 JPEG 字节的 SHA-256；两种算法不能混用。manifest 格式如下：

```json
{
  "version": 1,
  "hashAlgorithm": "sha256-lf-v1",
  "prefix": "#群管",
  "cards": {
    "help": [
      {"file": "resources/help/help-1.jpg", "sha256": "填写图片字节的64位小写SHA256", "width": 1080, "height": 720}
    ]
  },
  "sources": [
    {"file": "lib/help-content.mjs", "sha256": "填写规范化源文件的64位小写SHA256"}
  ]
}
```

topic 仅允许小写字母开头的字母、数字、短横线，最长 40 字符；对应图片必须依次为 `resources/help/<topic>-1.jpg` 至 `-8.jpg`。最多 32 个 topic、16 个源文件。源文件仅允许根目录 `index.js`、`api.mjs`、`help-content.mjs`、`package.json`、`README.md`，或 `lib/`、`src/`、`integrations/`、`yunzai/` 下的 `.mjs`、`.js`、`.md`；拒绝点目录、配置、账号数据及私密目录。根目录固定文件名 `help-content.mjs` 也支持适配器被安装脚本平铺的插件。需要追踪构建器本身变更时，也将该插件复制的构建说明源文件列入 `sources`。

reader 不导入 AI 核心，不读取账号，不下载素材，不写文件，不在首次请求生成图片。它只接受显式 `private: false` 的公开帮助请求，前缀必须与 manifest 及配置一致。manifest 可通过 `manifestFile` 指定为 `resources/help/` 下的固定小写 JSON 文件名。每次请求检查完整路径链，拒绝符号链接及多硬链接文件；文件标识或时间变化时重新校验 SHA-256。JPEG 还检查魔数、帧尺寸和末尾标记。公开图片只在内存缓存，最多 16 MiB、32 个 topic；每个调用者收到独立 Buffer 副本。任何校验失败都返回 `null`，由调用插件给出简短说明或文字帮助。

这种帮助 manifest 与旧游戏插件的 `help-manifest.json` 是两个明确分开的格式，不能将旧格式直接改名使用。API 也可从 `ai-plugin/static-help` 单独导入。

Windows 的部分旧 Node/libuv（已验证 Node 22.13.1）会让同一文件的 `lstat.dev` 返回不可用哨兵 `0`，而 `fstat.dev` 返回实际卷序号。reader 仅在 Windows 的这个跨 API 比较中兼容路径设备号 `0`；inode、模式、链接数、大小、mtime 与 ctime 仍严格相等。读取前后的路径 stat 与描述符 stat 各自继续比较完整指纹，缓存也保留路径 stat 的设备号与 ctime，不会因兼容性处理而忽略文件替换或时间变化。
