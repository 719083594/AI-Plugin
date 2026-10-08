# 语音音色目录

`voices.json` 收录 VITS 模型公开配置中的 804 个原始音色标签，保留原始编号和名称。来源为 [sayashi/vits-uma-genshin-honkai](https://huggingface.co/spaces/sayashi/vits-uma-genshin-honkai) 的 `model/config.json`；模型、人物和语音素材的权利归各自权利人所有。

游戏与语言分类是本插件为查询补充的目录信息。明确识别的角色归入原神、崩坏3、赛马娘；无法可靠识别的 NPC 放入其他/未分类，不用编号区间猜测其所属游戏。语言字段表示音色原素材的语言，合成语言由语音配置决定。别名只用于精确解析，存在歧义时需使用完整名称。

目录不包含已部署的服务地址、账号凭证或机器人配置。旧 VITS 接口仍使用此目录，并核对服务实际选项。

Gradio 5 四输入、三输出服务使用远端 `/config` 的音色选项。服务可提供隐藏 JSON 组件 `Speech catalogue`，值包括 `defaultVoice`、`maxCharacters`、`languages`（接口语言值到 `zh`/`en` 等代码的映射），以及 `voices` 数组；每项包含实际 `id`、显示 `label`、`language`、`group`。显示名称与真实推理 ID 分开，列表随服务更新，不再显示旧模型的游戏音色。未提供此元数据的兼容服务按下拉选项建立通用目录。
