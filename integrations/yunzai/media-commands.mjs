import { accessAllowed } from '../../src/core/client.mjs'

export const MEDIA_HELP = 'AI 图片与视频\n#AI画图 描述（写实，也可附图修改）\n#AI二次元 描述\n#AI媒体模型（查看已启用的图片和视频模型）\n#AI画图 描述 | 模型：模型编号\n#AI视频 动作描述 | 模型：模型编号\n默认视频：附图、引用图片，或接着自己刚生成的图片；可追加 | 配音：台词 | 音效：环境声音 | 时长：3秒或5秒 | 字幕：关闭 | 音效：关闭。\nNew API 视频：只接收文字，默认4秒，可设6/8秒；不支持参考图、指定配音、独立音效或字幕。模型须已配置并验证。'

// Only labelled sections are options. Ordinary pipes in an image/video prompt
// remain prompt text instead of silently disappearing.
export function parseMediaCommand(text) {
  if (/^媒体帮助$/.test(text)) return { kind: 'help' }
  if (/^媒体模型(?:列表)?$/.test(text)) return { kind: 'models' }
  const match = String(text).match(/^(画图|二次元|视频)(?:\s+([\s\S]*))?$/)
  if (!match) return null
  const kind = match[1] === '视频' ? 'video' : 'image'
  const pieces = (match[2] || '').split(kind === 'image' ? /\s*\|\s*(?=模型\s*[:：])/ : /\s*\|\s*(?=(?:配音|音效|字幕|时长|模型)\s*[:：])/)
  const options = { prompt: pieces.shift().trim(), ...(kind === 'image' ? { model: match[1] === '二次元' ? 'anima' : 'flux' } : {}) }, used = new Set()
  for (const piece of pieces) {
    const option = piece.match(/^(配音|音效|字幕|时长|模型)\s*[:：]\s*([\s\S]*)$/)
    if (!option || used.has(option[1])) throw new Error('生成选项不能重复，请发送 #AI媒体帮助 查看用法。')
    used.add(option[1])
    const value = option[2].trim()
    if (option[1] === '模型') {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/.test(value)) throw new Error('请从 #AI媒体模型 选择有效的模型编号。')
      options.model = value
    }
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
      if (!/^[34568](?:秒|s)?$/i.test(value)) throw new Error('默认视频时长为 3/5 秒；New API 视频为 4/6/8 秒。')
      options.duration = Number(value.replace(/(?:秒|s)$/i, ''))
    }
  }
  return { kind, options }
}

export async function handleMediaCommand({ client, input, text, reply, send }) {
  const parsed = parseMediaCommand(text)
  if (!parsed) return false
  if (parsed.kind === 'help') { await reply(MEDIA_HELP); return true }
  if (parsed.kind === 'models') {
    const models = client.generationModels?.() || { image: [], video: [] }
    await reply('已启用的生成模型\n图片：' + (models.image.join('、') || '暂无') + '\n视频：' + (models.video.join('、') || '暂无') + '\n在画图或视频指令后追加 | 模型：编号；不填写时沿用原有默认服务。')
    return true
  }
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
