// Preset-owned instructions live in the system prompt, never in saved history.
const naturalStyle = `【自然聊天】
以角色自己的语气和正在交谈的朋友交流，先接住对方这句话，再给出贴合话题的想法、细节或轻微吐槽。不要把每一轮聊天当成等待派发任务。
不要习惯性使用“有什么需要帮助的吗”“还有其他问题吗”“我可以为你提供帮助”等客服开场或收尾，不要每次都反问。需要澄清时问一个具体问题，已在上下文说明的信息不要重复询问。
普通的“你好”“你好啊”“嗨”只需要自然回应，可以带一点角色自己的态度；不要自动追加“有什么可以帮你的吗”“今天有什么新鲜事”“有什么想聊的”。连续每轮反问会像采访，允许正常陈述和停顿。不要捏造今天已做过的事情来制造角色感。
你可以有自己的判断和偏好，不必一味附和；不确定的事实坦诚说明。对方分享经历或情绪时回应具体内容，不只说“我理解”“加油”。短句、省略和玩笑结合上下文理解，别机械复述身份。
认真问题先给有用的结论，再补原因、例子或可操作的建议；正常聊天不硬插角色梗，不写客服总结。`

const detailPrompts = {
  brief: '简短但有内容，通常一到三句；复杂问题仍需给出关键结论和必要信息。',
  balanced: '按话题自然展开。招呼或简单确认一到两句就够；有内容的日常聊天通常三到六句，可加入具体想法或细节；知识、建议和解释给完整结论与理由，不必等对方要求“详细”才认真展开。不要为了字数重复或凑句子。',
  detailed: '有实质内容的话题主动给出充分解释、具体例子或建议，必要时分段；打招呼和简单确认仍自然简短。不要用复述、空话或连续追问凑长度。'
}

const servicePatterns = [
  /(?:还有|有|请问有)?什么(?:我)?(?:可以|能|能够|需要)(?:为你|帮你|帮您|帮助你|帮助您|帮忙|帮助)[^。！？!？\n]{0,25}/u,
  /(?:你|您)?(?:有|如果有|若有)?什么需要(?:帮助|帮忙)[^。！？!？\n]{0,20}/u,
  /(?:如果|若|如|有)?[^。！？!？\n]{0,20}(?:需要帮助|需要帮忙)[^。！？!？\n]{0,20}(?:随时|告诉我|尽力)/u,
  /(?:我会尽力|我可以为你提供帮助|我可以为您提供帮助|万事通随时待命)/u,
  /(?:今天)?(?:有|还有|有没有)什么(?:特别)?(?:想聊|有趣的事|新鲜事)[^。！？!？\n]{0,25}/u
]
export const needsPersonaRepair = text => servicePatterns.some(pattern => pattern.test(text))
export function stripServiceTail(text) {
  return String(text).split(/(?<=[。！？!?])|\n/u).filter(sentence => !needsPersonaRepair(sentence)).join('').trim()
}

export function buildPersonaPrompt(preset, { proactive = false } = {}) {
  const sections = [preset.systemPrompt || '']
  if (preset.chatStyle === 'natural') sections.push(naturalStyle)
  if (detailPrompts[preset.replyDetail]) sections.push('【回复展开程度】\n' + detailPrompts[preset.replyDetail])
  if (preset.dialogueExamples?.trim()) sections.push('【角色对话示例】\n以下是创作示例，只学习语气和接话方式，不逐字套用，不视为本轮事实或已经发生的经历：\n' + preset.dialogueExamples.trim())
  if (proactive) sections.push('【本轮为群内主动接话】\n本轮简短接话，通常一到三句，不展开长篇解释；没有合适话题时返回 [不回复]。')
  return sections.filter(Boolean).join('\n\n')
}
