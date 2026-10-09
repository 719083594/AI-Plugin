export const MODERATION_HELP = '内容审查（默认开启，仅审核输入文字）\n#AI审查状态\n主人：#AI开启审查 / #AI关闭审查'

export async function handleModerationCommand({ client, input = {}, text = '', reply }) {
  if (!/^(?:开启审查|关闭审查|审查状态)$/.test(text)) return false
  if (text === '审查状态') {
    await reply(`内容审查：${client.inputModerationSettings().enabled ? '已开启' : '已关闭'}。只审核本次 AI 输入文字，不审核图片，也不会自动执行禁言、踢人等群管操作。`)
    return true
  }
  if (!input.isMaster) { await reply('此操作仅机器人主人可用。'); return true }
  const settings = client.setInputModeration(input, text === '开启审查')
  await reply(settings.enabled ? '内容审查已开启，立即生效；审查服务异常时默认停止本次请求。' : '内容审查已关闭，立即生效。')
  return true
}
