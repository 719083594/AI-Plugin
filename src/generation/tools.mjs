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
      name: 'generate_image', description: '仅在用户明确要求绘图或修改图片时生成图片。flux适合写实及参考图编辑，anima适合二次元且不支持参考图；其他模型须在已启用名单内。不要用于搜索图片，不要在主动接话中调用。结果会随回复发送。',
      inputSchema: schema({ prompt: { ...string('明确的画面描述'), minLength: 1 }, model: string('可选已启用的生成模型编号', 128), imageRef: string('可选当前或此前生成的图片引用；不用任意URL', 80) }, ['prompt']),
      async execute(args, context) {
        if (context.proactive) throw new Error('主动接话不会生成图片')
        return send(await client.runGeneration('image', context, args, { fromTool: true }), context)
      }
    },
    {
      name: 'generate_video', description: '仅在用户明确要求制作视频时调用。默认hf-story把当前、引用或本人本轮会话此前生成的图片转成3秒或5秒短视频，可选配音、字幕及视频音效。已启用的New API视频模型只接收文字，默认4秒，可选6/8秒，不接受图片、指定配音、独立音效或字幕；不要将HF选项用于这些模型。不能只生成图片就声称视频完成。不要在主动接话中调用。',
      inputSchema: schema({ prompt: { ...string('描述动作和镜头'), minLength: 1 }, model: string('可选已启用的视频模型编号；省略使用HF图片转视频', 128), imageRef: string('仅HF模型支持图片引用', 80), duration: { type: 'integer', enum: [3, 4, 5, 6, 8] }, script: string('HF模型可选配音文字；不要擅自添加', 200), effectsPrompt: string('HF模型可选视频内环境音描述', 500), effectsEnabled: { type: 'boolean' }, subtitles: { type: 'boolean' } }, ['prompt']),
      async execute(args, context) {
        if (context.proactive) throw new Error('主动接话不会生成视频')
        return send(await client.runGeneration('video', context, args, { fromTool: true }), context)
      }
    }
  ]
}
