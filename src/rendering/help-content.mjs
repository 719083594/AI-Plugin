export const helpTopics={
 'ai-public':{title:'AI 助手',subtitle:'聊天 · 预设 · 记忆',groups:[
  {title:'开始聊天',items:[{command:'私聊机器人，或在群里 @ 机器人',description:'直接说你的问题；是否响应由机器人当前设置决定。'}]},
  {title:'选择预设',items:[{command:'#AI预设列表',description:'查看已启用的预设'},{command:'#AI切换预设 名称',description:'选择自己接下来使用的预设'},{command:'#AI当前预设',description:'查看当前选择'}]},
  {title:'管理自己的对话',items:[{command:'#AI结束对话',description:'清理本人的当前对话上下文'},{command:'#AI记忆 列表',description:'查看自己的记忆'},{command:'#AI记忆 添加 内容',description:'保存一条个人记忆'}]},
 ],footer:'帮助图保存在本地，发送时无需生成。具体可用能力以当前功能设置为准。'},
 'ai-master':{title:'AI 主人管理',subtitle:'仅机器人主人私聊',groups:[
  {title:'管理入口',items:[{command:'#AI登录',description:'获取临时工作台入口',permission:'主人'},{command:'#AI状态 / #AI备份 / #AI清理',description:'检查状态、备份和维护',permission:'主人'}]},
  {title:'对话与群聊',items:[{command:'#AI主动接话 开 / 关',description:'管理主动接话',permission:'主人'},{command:'#AI结束全部对话',description:'清理全部对话上下文',permission:'主人'}]},
 ],footer:'复杂扩展的接入与启用状态见工作台「功能状态」。临时登录链接不缓存为帮助图片。'},
};
