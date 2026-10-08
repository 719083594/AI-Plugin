# 致谢与来源

AI-Plugin 是新的独立实现。以下项目提供原有行为研究、适配环境或公开协议文档；不表示本项目获得第三方认证或继承其服务能力。

| 项目 | 使用方式 |
| --- | --- |
| [ChatGPT-Plugin](https://github.com/ikechan8370/chatgpt-plugin) | 调研既有命令、角色、会话、工具 ID 和用户需要保留的功能；未复制实现代码或界面资源。 |
| [Chaite / node-chaite](https://github.com/ikechan8370/node-chaite) | 调研模型、工具、历史和管理接口契约；不导入 SDK，也不依赖 Chaite Cloud。 |
| [TRSS-Yunzai](https://github.com/TimeRainStarSky/Yunzai) | 可选机器人适配环境，使用其公开插件加载与事件接口；框架不包含在本仓库。 |
| [Yunzai-Bot](https://github.com/Le-niao/Yunzai-Bot) | 云崽插件体系参考；实际平台能力由用户的框架与协议端提供。 |
| [OpenAI API](https://developers.openai.com/api/reference/resources/chat) | Chat Completions 请求、响应和工具调用协议。 |
| [Gemini API](https://ai.google.dev/gemini-api/docs) | Gemini 文字、图片与工具协议。 |
| [Claude API](https://platform.claude.com/docs/en/api/messages/create) | Messages 请求、图片与工具结果协议。 |
| [Node.js](https://nodejs.org/api/sqlite.html) | 内置 SQLite、HTTP、fetch、测试运行器和基础运行环境。 |
| [OrangeJuice-Plugin](https://github.com/719083594/OrangeJuice-Plugin) | 配套中文配置声明、权限、密钥遮罩与独立管理入口。 |
| [WebSearch-Plugin](https://github.com/719083594/WebSearch-Plugin) | 可选联网搜索后端；其依赖、网络访问和搜索质量属于独立部署。 |
| [VITS](https://github.com/jaywalnut310/vits) | 外部语音合成模型架构来源；AI-Plugin 不内置模型或训练权重。 |
| [Gradio](https://www.gradio.app/) | 可选语音服务的配置读取、异步队列与音频接口。服务源码、音色和模型权重适用其各自许可证。 |

本仓库没有引入上述插件的源码、前端资源或 npm 运行依赖。名称和工具 ID 用于兼容接口与来源标识，各原项目继续适用其许可证。AI-Plugin 自身采用 GPL-3.0-or-later，具体条款见仓库根目录 LICENSE。
