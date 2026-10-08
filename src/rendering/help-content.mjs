export const helpTopics={
 'ai-public':{title:'AI 助手',subtitle:'聊天 · 语音 · 预设 · 记忆',groups:[
  {title:'开始聊天',items:[{command:'私聊机器人，或在群里 @ 机器人',description:'直接说你的问题；是否响应由机器人当前设置决定。'}]},
  {title:'选择预设',items:[{command:'#AI预设列表',description:'查看已启用的预设'},{command:'#AI切换预设 名称',description:'选择自己接下来使用的预设'},{command:'#AI当前预设',description:'查看当前选择'}]},
  {title:'管理自己的对话',items:[{command:'#AI结束对话',description:'清理本人的当前对话上下文'},{command:'#AI记忆 列表',description:'查看自己的记忆'},{command:'#AI记忆 添加 内容',description:'保存一条个人记忆'}]},
  {title:'切换回复方式',items:[{command:'#AI语音模式 / #AI文字模式',description:'切换机器人共用模式；默认文字，保留各会话上下文'},{command:'#AI语音状态',description:'查看机器人共用的回复方式和音色'},{command:'#AI转语音 文字',description:'直接朗读指定文字，不改变聊天回复方式'}]},
  {title:'选择语音音色',items:[{command:'#AI音色列表 中文女声 1',description:'按当前语音服务的分类查看可用音色和编号'},{command:'#AI语音游戏 中文女声',description:'选择机器人共用的音色列表分类'},{command:'#AI语音 中文女声001',description:'切换共用音色并开启语音，也可使用音色编号'},{command:'#AI语音帮助',description:'查看用法；有 AI 使用权限的用户均可切换'}]},
 ],footer:'帮助图保存在本地，发送时无需生成。具体可用能力以当前功能设置为准。'},
 'ai-master':{title:'AI 主人管理',subtitle:'仅机器人主人私聊',groups:[
  {title:'管理入口',items:[{command:'#AI登录',description:'获取临时工作台入口',permission:'主人'},{command:'#AI状态 / #AI备份 / #AI清理',description:'检查状态、备份和维护',permission:'主人'}]},
  {title:'对话与群聊',items:[{command:'#AI主动接话 开 / 关',description:'管理主动接话',permission:'主人'},{command:'#AI结束全部对话',description:'清理全部对话上下文',permission:'主人'}]},
 ],footer:'复杂扩展的接入与启用状态见工作台「功能状态」。临时登录链接不缓存为帮助图片。'},
};
