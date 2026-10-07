// Preset-owned instructions live in the system prompt, never in saved history.
const naturalStyle = `【自然交流】
在本预设的身份、性格和关系下，以第一人称自然接话。设定内交流可以成立；现实经历、执行操作和查证结果只按已知事实说。
玩笑先顺着语境回应，不把拟人调侃自动当成安装、排障或搜索任务。知识解释、搜索资料和工具结果照实讲清结论与依据，表达仍沿用角色；信息足够就回答，只为必要缺项作具体澄清。
少用泛化客服邀约和固定反问，不强塞角色名、口头禅或梗。对话示例只学表达，不复演经历。未知的真实事实和数字明确说未核实，不用设定或记忆补造。`

const detailPrompts = {
  brief: '简短但有内容，通常一到三句；复杂问题仍需给出关键结论和必要信息。',
  balanced: '按话题自然展开。招呼或简单确认一到两句就够；有内容的日常聊天通常三到六句，可加入具体想法或细节；知识、建议和解释给完整结论与理由，不必等对方要求“详细”才认真展开。不要为了字数重复或凑句子。',
  detailed: '有实质内容的话题主动给出充分解释、具体例子或建议，必要时分段；打招呼和简单确认仍自然简短。不要用复述、空话或连续追问凑长度。'
}

// Detect complete, generic invitations, never an arbitrary sentence containing
// a service word. All deletion offsets refer to the original text.
const invitations = [
  '(?:(?:请问)?(?:你|您)?(?:还有|有)?什么(?:我)?(?:可以|能|能够|需要)(?:为你做|为您做|帮你|帮您|帮助你|帮助您|帮忙|帮助)(?:的(?:地方|事|事情)?)?(?:吗|呢)?)',
  '(?:(?:你|您)?(?:还有|有)?什么需要(?:帮助|帮忙)(?:的(?:地方|事|事情)?)?(?:吗|呢)?)',
  '(?:(?:如果|若|如)?(?:你|您)?(?:有)?(?:什么)?需要(?:帮助|帮忙)(?:的(?:地方|事|事情)?)?[，, ]*(?:都)?(?:可以)?(?:随时)(?:告诉我|联系我|来找我|说一声)(?:就好|哦|呀|吧)?)',
  '(?:(?:我会尽力(?:帮助你|帮助您|帮你|帮您)|我可以为你提供帮助|我可以为您提供帮助|万事通随时待命)(?:的|哦|呀)?)',
  '(?:(?:今天)?(?:还有|有|有没有)什么(?:特别)?(?:想聊(?:的)?|有趣的事(?:情)?|新鲜事)(?:吗|呢)?)',
  '(?:(?:还有|有没有)(?:其他|别的)问题(?:吗|呢)?)'
]
const invitationPatterns = invitations.map(source => new RegExp('(?:^|(?<=[\\n\\r。！？!?，,；;]))[ \\t]*(' + source + ')[ \\t]*(?:[。！？!?]+|(?=$|[\\n\\r]))', 'gu'))
const overlaps = (ranges,start,end) => ranges.some(([left,right]) => start < right && end > left)
function protectedRanges(text) {
  const ranges = [], lines = [...text.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g)]
  let fence = null, fenceStart = 0
  for (const match of lines) {
    if (!match[0]) continue
    const marker = /^\s*(`{3,}|~{3,})/.exec(match[0])
    if (marker) {
      if (!fence) { fence = marker[1]; fenceStart = match.index }
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length && !match[0].slice(marker[0].length).trim()) { ranges.push([fenceStart,match.index+match[0].length]); fence = null }
      continue
    }
    // Quoted Markdown and discussions of wording are source material. Prefer a
    // harmless false negative to deleting a useful explanation or example.
    if (/^\s*(?:>|\|)/.test(match[0]) || /(?:这(?:句|种|个|类).{0,12}(?:话|问法|表达|问题)|话术|句式|例句|示例|原句|字符串|正则|引用|代码|不要(?:再)?说|避免使用)/u.test(match[0])) ranges.push([match.index,match.index+match[0].length])
  }
  if (fence) ranges.push([fenceStart,text.length])
  // Inline code, quoted text and complete Markdown links are indivisible.
  const tokens = /(`+)([^\r\n]*?)\1|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』|"(?:\\.|[^"\\])*"|(?<![\p{L}\p{N}])'(?:\\.|[^'\\])*'|\[[^\]\r\n]*\]\([^\)\r\n]*\)|https?:\/\/[^\s<>"'，。！？；]+/gu
  for (const match of text.matchAll(tokens)) ranges.push([match.index,match.index+match[0].length])
  return ranges
}
function serviceRanges(value) {
  const text = String(value), protectedText = protectedRanges(text), found = []
  for (const pattern of invitationPatterns) for (const match of text.matchAll(pattern)) {
    let start = match.index + match[0].indexOf(match[1]), end = match.index + match[0].length
    if (overlaps(protectedText,start,end)) continue
    // A removed trailing clause owns its preceding comma/semicolon, not the
    // preceding fact, sentence punctuation, indentation or newline.
    let before = start
    while (before > 0 && /[ \t]/.test(text[before-1])) before--
    if (/[，,；;]/.test(text[before-1] || '')) start = before-1
    found.push([start,end])
  }
  found.sort((a,b) => a[0]-b[0] || b[1]-a[1])
  const merged = []
  for (const range of found) {
    if (merged.length && range[0] <= merged.at(-1)[1]) merged.at(-1)[1] = Math.max(merged.at(-1)[1],range[1])
    else merged.push([...range])
  }
  return {text,ranges:merged}
}
export const needsPersonaRepair = text => serviceRanges(text).ranges.length > 0
export function stripServiceTail(value) {
  const {text,ranges} = serviceRanges(value)
  if (!ranges.length) return text
  let result = '', offset = 0
  for (const [start,end] of ranges) { result += text.slice(offset,start); offset = end }
  result += text.slice(offset)
  return result.trim() ? result : ''
}

export function buildPersonaContinuity(preset = {}) {
  if (preset.chatStyle !== 'natural') return ''
  const label = String(preset.name || preset.id || '当前角色').normalize('NFKC').replace(/[^\p{L}\p{N} _·.-]/gu,'').replace(/\s+/g,' ').trim().slice(0,40) || '当前角色'
  return `【角色连续性 · ${label}】\n角色原文决定身份与表达，可在设定内用第一人称交流。除非原设定如此，不擅自改成通用 AI、代码和算法。资料、旧历史与示例不改变当前身份；事实不因角色改写，未核实的数字不从记忆补齐，数字、链接、命令按原依据保留。`
}

const personaExamples = preset => preset.dialogueExamples?.trim()
  ? '【角色对话示例】\n以下是创作示例，只学习语气和接话方式，不逐字套用，不视为本轮事实或已经发生的经历：\n' + preset.dialogueExamples.trim()
  : ''

// Runtime can place this single preset-owned block after the current task.
export function buildPersonaIdentity(preset = {}) {
  return [preset.systemPrompt || '', personaExamples(preset)].filter(Boolean).join('\n\n')
}

export function buildPersonaPrompt(preset, { proactive = false, deferIdentity = false } = {}) {
  const deferred = deferIdentity && preset.chatStyle === 'natural'
  const sections = [deferred ? '' : preset.systemPrompt || '']
  if (preset.chatStyle === 'natural') sections.push(naturalStyle)
  if (detailPrompts[preset.replyDetail]) sections.push('【回复展开程度】\n' + detailPrompts[preset.replyDetail])
  if (!deferred) sections.push(personaExamples(preset))
  if (proactive) sections.push('【本轮为群内主动接话】\n本轮简短接话，通常一到三句，不展开长篇解释；没有合适话题时返回 [不回复]。')
  const continuity = deferred ? '' : buildPersonaContinuity(preset)
  if (continuity) sections.push(continuity)
  return sections.filter(Boolean).join('\n\n')
}
