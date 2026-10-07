import fs from 'node:fs'
export let apps = {}
try {
  const config = JSON.parse(fs.readFileSync(new URL('./config/integration.json', import.meta.url), 'utf8'))
  if (config.adapter === 'yunzai') {
    const integration=await import('./integrations/yunzai/index.js');
    const Base=globalThis.plugin||(await import('../../lib/plugins/plugin.js')).default;
    const {createStaticHelpApp}=await import('./integrations/yunzai/static-help.mjs');
    apps={...integration.apps,AIHelp:createStaticHelpApp(Base,()=>integration.client?.config())};
  }
  else if (config.adapter !== 'none') throw new Error('不支持的框架适配器：' + config.adapter)
} catch (error) { if (error.code !== 'ENOENT') throw error }
