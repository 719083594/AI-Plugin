const string = (description, maxLength = 2000) => ({ type: 'string', description, maxLength })
const schema = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })

/** Media generation is explicit user work. Sound effects belong to video composition. */
export function createGenerationTools(client) {
  const send = async (result, context) => {
    if (typeof context.send !== 'function') throw new Error('当前适配器不能发送生成结果')
    const receipt = await context.send(result.contents)
    if (receipt === false || receipt?.delivered === false || receipt?.error) throw new Error('生成结果发送失败')
    return { ok: true, generated: true, type: result.contents[0].type, ...(result.contents[0].ref ? { imageRef: result.contents[0].ref } : {}) }
  }
  return [
    {
      name: 'generate_image', description: '仅在用户明确要求绘图或修改图片时生成图片。flux适合写实及参考图编辑，anima适合二次元且不支持参考图。不要用于搜索图片，不要在主动接话中调用。结果会随回复发送。',
      inputSchema: schema({ prompt: { ...string('明确的画面描述'), minLength: 1 }, model: { type: 'string', enum: ['flux', 'anima'] }, imageRef: string('可选当前或此前生成的图片引用；不用任意URL', 80) }, ['prompt']),
      async execute(args, context) {
        if (context.proactive) throw new Error('主动接话不会生成图片')
        return send(await client.runGeneration('image', context, args, { fromTool: true }), context)
      }
    },
    {
      name: 'generate_video', description: '仅在用户明确要求制作视频时，把当前、引用或本人本轮会话此前生成的图片转成3秒或5秒短视频。需已有图片，没有图片时请用户提供图片或先用 #AI画图；不能只生成图片就声称视频完成。可选script配音及字幕，音效在视频内合成，可关闭effectsEnabled；配音使用当前共用音色。不要在主动接话中调用。',
      inputSchema: schema({ prompt: { ...string('描述动作和镜头'), minLength: 1 }, imageRef: string('可选图片引用', 80), duration: { type: 'integer', enum: [3, 5] }, script: string('可选配音文字；不要擅自添加', 200), effectsPrompt: string('可选视频内环境音描述', 500), effectsEnabled: { type: 'boolean' }, subtitles: { type: 'boolean' } }, ['prompt']),
      async execute(args, context) {
        if (context.proactive) throw new Error('主动接话不会生成视频')
        return send(await client.runGeneration('video', context, args, { fromTool: true }), context)
      }
    }
  ]
}
