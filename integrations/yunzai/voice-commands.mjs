import { accessAllowed } from '../../src/core/client.mjs'
import { listVoices, resolveVoice, normalizeGame, VOICE_GAMES } from '../../src/speech/index.mjs'

export const VOICE_HELP = 'AI 语音（默认文字，所有人共用模式和音色，均可切换）\n#AI语音模式 / #AI文字模式 / #AI语音状态\n#AI转语音 要朗读的文字（不改变聊天模式）\n#AI音色列表 原神 1（可选：崩坏3、赛马娘、其他）\n#AI语音 纳西妲（选择音色并开启语音）\n#AI语音游戏 原神（选择音色列表分类）'

const voiceName = voice => typeof voice === 'object' ? voice.label || voice.name : voice
const gameName = (game, games) => games.find(row => row.id === game)?.name || game || '全部'
const recognized = text => /^(?:语音模式|切换语音|文字模式|切换文字|语音状态|语音帮助|语音)$/.test(text) || /^(?:音色列表|语音列表|文字转语音|转语音|语音游戏)(?:\s|$)/.test(text) || /^(?:语音|音色)\s*.+/.test(text)

// Keep parsing testable without starting the management server or contacting QQ.
export async function handleVoiceCommand({ client, input, text, reply, send, catalog = { listVoices, resolveVoice, normalizeGame, games: VOICE_GAMES } }) {
  if (!recognized(text)) return false
  const config = client.config()
  if (!config.basic.enabled) throw new Error('AI 插件已停用')
  if (!accessAllowed(config, input)) throw new Error('你没有使用 AI 的权限')
  if (input.isPrivate ? !config.chat.privateEnabled : !config.chat.groupEnabled) throw new Error(input.isPrivate ? 'AI 私聊已关闭' : 'AI 群聊已关闭')
  const settings = await client.speechSettings(input)
  if (/^(?:语音帮助|语音)$/.test(text)) { await reply(VOICE_HELP); return true }
  if (/^(?:语音模式|切换语音|文字模式|切换文字)$/.test(text)) {
    const mode = /文字/.test(text) ? 'text' : 'voice'
    const updated = await client.setSpeechSettings(input, { mode })
    await reply(mode === 'text' ? '已切换为全局文字模式。' : `已切换为全局语音模式，音色：${voiceName(updated.voice)}。所有人共用；合成失败时返回文字。`)
    return true
  }
  if (text === '语音状态') {
    await reply(`全局模式：${settings.mode === 'voice' ? '语音' : '文字'}\n共用音色：${voiceName(settings.voice)}\n列表分类：${gameName(settings.game, catalog.games)}\n语音服务：${client.speechConfigured?.() ? '已配置' : '未配置'}\n#AI音色列表 / #AI语音 纳西妲 / #AI文字模式`)
    return true
  }
  if (/^(?:文字转语音|转语音)(?:\s|$)/.test(text)) {
    const content = text.replace(/^(?:文字转语音|转语音)\s*/, '').trim()
    if (!content) await reply('用法：#AI转语音 要朗读的文字。此指令不改变聊天模式。')
    else await send(await client.speak(input, content))
    return true
  }
  if (/^语音游戏(?:\s|$)/.test(text)) {
    const name = text.replace(/^语音游戏\s*/, '').trim(), game = catalog.normalizeGame(name)
    if (!name || !game) { await reply('可选分类：' + catalog.games.map(row => row.name).join('、') + '。例如：#AI语音游戏 原神'); return true }
    await client.setSpeechSettings(input, { game })
    await reply(`全局音色列表分类已设为${gameName(game, catalog.games)}，当前音色保持不变。发送 #AI音色列表 ${gameName(game, catalog.games)} 查看。`)
    return true
  }
  if (/^(?:音色列表|语音列表)(?:\s|$)/.test(text)) {
    const args = text.replace(/^(?:音色列表|语音列表)\s*/, '').trim()
    if (!args) {
      const counts = catalog.games.map(game => `${game.name}：${catalog.listVoices({ game: game.id, pageSize: 30 }).total} 个音色`)
      await reply(`音色分类\n${counts.join('\n')}\n#AI音色列表 原神 1\n#AI音色列表 崩坏3 1\n#AI音色列表 赛马娘 1\n#AI音色列表 其他 1\n选音色：#AI语音 纳西妲。列表中的完整名称可直接使用。`)
      return true
    }
    const match = args.match(/^(.*?)(?:\s+(\d+))?$/), pageOnly = /^\d+$/.test(args)
    const game = pageOnly ? settings.game : catalog.normalizeGame(match[1].trim())
    const page = pageOnly ? Number(args) : Number(match[2] || 1)
    if (!game) { await reply('未找到这个分类。可选：' + catalog.games.map(row => row.name).join('、') + '。'); return true }
    if (!Number.isSafeInteger(page) || page < 1) { await reply('页码从 1 开始，例如：#AI音色列表 原神 1'); return true }
    const result = catalog.listVoices({ game, page, pageSize: 30 })
    if (!result.voices.length) { await reply(`${gameName(game, catalog.games)}没有第 ${page} 页，可用页码：1—${result.pages || 1}。`); return true }
    const lines = result.voices.map((voice, index) => {
      const aliases = (voice.aliases || []).filter(alias => alias !== voice.label && alias !== voice.name).slice(0, 3)
      return `${(result.page - 1) * result.pageSize + index + 1}. ${voice.label || voice.name}${aliases.length ? `（别名：${aliases.join('、')}）` : ''}`
    })
    await reply(`${gameName(game, catalog.games)}音色 · 第 ${result.page}/${result.pages} 页 · 共 ${result.total} 个\n${lines.join('\n')}\n选择：#AI语音 完整音色名${result.page < result.pages ? `\n下一页：#AI音色列表 ${gameName(game, catalog.games)} ${result.page + 1}` : ''}`)
    return true
  }
  const name = text.replace(/^(?:语音|音色)\s*/, '').trim()
  const voice = catalog.resolveVoice(name, { game: settings.game, language: settings.language }) || catalog.resolveVoice(name, { language: settings.language })
  if (!voice) {
    const candidates = catalog.listVoices({ search: name, page: 1, pageSize: 10 }).voices
    await reply(candidates.length ? `请使用完整音色名：\n${candidates.map(row => row.label || row.name).join('\n')}\n例如：#AI语音 ${candidates[0].label || candidates[0].name}` : '没有找到这个音色。发送 #AI音色列表 查看分类；例如：#AI语音 纳西妲。')
    return true
  }
  const updated = await client.setSpeechSettings(input, { voice: voice.label || voice.name, game: voice.game, language: voice.language === 'unknown' ? settings.language : voice.language, mode: 'voice' })
  await reply(`全局音色已切换为「${voiceName(updated.voice)}」，已开启语音模式。所有人共用；#AI文字模式 可切回文字。`)
  return true
}
