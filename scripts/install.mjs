import fs from 'node:fs'
import path from 'node:path'
import { pluginRoot, defaults, writeJson } from '../src/core/config.mjs'
const argv = process.argv.slice(2), index = argv.indexOf('--adapter'), adapter = index < 0 ? 'none' : argv[index + 1]
if (!['none', 'yunzai'].includes(adapter)) throw new Error('适配器仅支持 none（独立模式）或 yunzai（云崽）')
writeJson(path.join(pluginRoot, 'config/integration.json'), { adapter })
if (!fs.existsSync(path.join(pluginRoot, 'config/local.json'))) writeJson(path.join(pluginRoot, 'config/local.json'), defaults)
console.log(adapter === 'yunzai' ? '已启用云崽适配。请先配置渠道，再重启机器人。' : '已选择独立模式，可使用 Node API、CLI 和工作台。')
