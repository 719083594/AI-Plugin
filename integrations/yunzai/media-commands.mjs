import { accessAllowed } from '../../src/core/client.mjs'

export const MEDIA_HELP = 'AI 图片与视频\n#AI画图 描述（写实，也可附图修改）\n#AI二次元 描述\n#AI视频 动作描述（附图、引用图片，或接着自己刚生成的图片）\n#AI视频 动作描述 | 配音：要说的话 | 音效：环境声音\n可选：| 时长：3秒或5秒 | 字幕：关闭 | 音效：关闭\n配音沿用共用音色；音效用于视频，生成服务需已配置。'

// Only labelled sections are options. Ordinary pipes in an image/video prompt
// remain prompt text instead of silently disappearing.
export function parseMediaCommand(text) {
  if (/^媒体帮助$/.test(text)) return { kind: 'help' }
  const match = String(text).match(/^(画图|二次元|视频)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const kind = match[1] === '视频' ? 'video' : 'image'
  if (kind === 'image') return { kind, options: { prompt: (match[2] || '').trim(), model: match[1] === '二次元' ? 'anima' : 'flux' } }
  const pieces = (match[2] || '').split(/\s*\|\s*(?=(?:配音|音效|字幕|时长)\s*[:：])/)
  const options = { prompt: pieces.shift().trim() }, used = new Set()
  for (const piece of pieces) {
    const option = piece.match(/^(配音|音效|字幕|时长)\s*[:：]\s*([\s\S]*)$/)
    if (!option || used.has(option[1])) throw new Error('视频选项不能重复，请发送 #AI媒体帮助 查看用法。')
    used.add(option[1])
    const value = option[2].trim()
    if (option[1] === '配音') options.script = value
    if (option[1] === '音效') {
      options.effectsEnabled = !/^(?:关闭|关|无|off)$/i.test(value)
      options.effectsPrompt = options.effectsEnabled ? value : ''
    }
    if (option[1] === '字幕') {
      if (!/^(?:开启|开|关闭|关|on|off)$/i.test(value)) throw new Error('字幕选项请填写“开启”或“关闭”。')
      options.subtitles = /^(?:开启|开|on)$/i.test(value)
    }
    if (option[1] === '时长') {
      if (!/^(?:3|5)(?:秒|s)?$/i.test(value)) throw new Error('视频时长可选 3 秒或 5 秒。')
      options.duration = Number(value.replace(/(?:秒|s)$/i, ''))
    }
  }
  return { kind, options }
}

export async function handleMediaCommand({ client, input, text, reply, send }) {
  const parsed = parseMediaCommand(text)
  if (!parsed) return false
  if (parsed.kind === 'help') { await reply(MEDIA_HELP); return true }
  const config = client.config()
  if (!config.basic.enabled) throw new Error('AI 插件已停用')
  if (!accessAllowed(config, input)) throw new Error('你没有使用 AI 的权限')
  if (input.isPrivate ? !config.chat.privateEnabled : !config.chat.groupEnabled) throw new Error(input.isPrivate ? 'AI 私聊已关闭' : 'AI 群聊已关闭')
  if (!parsed.options.prompt) { await reply(parsed.kind === 'image' ? '请描述想画的内容，例如：#AI画图 雨后的森林。' : '请描述动作，例如：#AI视频 小猫慢慢转头。可附图、引用图片，或接着自己刚生成的图片。'); return true }
  if (!client.generationConfigured?.()) throw new Error('图片与视频生成服务尚未配置，请联系机器人主人。')
  const result = parsed.kind === 'image'
    ? await client.generateImage(input, parsed.options)
    : await client.generateVideo(input, parsed.options)
  await send(result)
  return true
}
