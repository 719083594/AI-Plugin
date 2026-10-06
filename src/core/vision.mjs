import { selectChannel } from './client.mjs'

export const supportsVision = model => typeof model === 'object' && model !== null && (model.features || []).some(value => ['vision', 'visual'].includes(value))

/** Explicit binding, then the role's visual model, then advertised visual models. */
export function selectVision(config, preset) {
  if (!config.media.imagesEnabled) throw new Error('识图已关闭，请让主人开启图片识别')
  const channelId = config.media.visionChannelId, name = config.media.visionModel
  if (name) {
    const choice = { ...preset, model: name, channelId: channelId || '' }
    const channel = selectChannel(config, choice)
    const metadata = channel.models?.find(row => typeof row === 'object' && row.name === name)
    if (metadata?.features?.length && !supportsVision(metadata)) throw new Error('指定模型未声明视觉能力，请检查视觉模型配置')
    return { channel, model: name }
  }
  const models = config.channels.filter(row => row.enabled !== false && (!channelId || row.id === channelId)).flatMap(channel => (channel.models || []).filter(supportsVision).map(model => ({ channel, model: model.name })))
  const role = models.find(row => row.model === preset.model && (!preset.channelId || row.channel.id === preset.channelId))
  if (role) return role
  if (!models.length) throw new Error('尚未配置可用的视觉模型，请在图片与视觉设置中绑定支持识图的模型')
  const preferred = Math.max(...models.map(row => Number(row.channel.priority) || 0))
  return models.find(row => (Number(row.channel.priority) || 0) === preferred)
}

export function checkImageScope(image, context) {
  if (image.origin && context.botId && image.origin !== String(context.botId)) throw new Error('不能读取其他机器人的图片引用')
  if (image.groupId && String(image.groupId) !== String(context.groupId || '')) throw new Error('不能读取其他群的图片引用')
  if (!image.groupId && image.userId && String(image.userId) !== String(context.userId || '')) throw new Error('不能读取其他用户的私聊图片引用')
}

export function visionError(error) {
  if (error?.status === 429) return new Error('视觉模型当前限流，请稍后再试；本次未识别图片')
  if ([502, 503, 504].includes(error?.status)) return new Error('视觉模型暂不可用或等待超时；本次未识别图片，请稍后再试')
  return error
}

export const storedImage = image => ({ type: 'image', ref: image.ref, mime: image.mime })
export const imageNote = image => ({ type: 'text', text: `[此前的图片${image.ref ? ' ref:' + image.ref : ''}；可参考前面的图片分析，不能据此猜测未识别的细节]` })
