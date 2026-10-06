import fs from 'node:fs'
import {fileURLToPath} from 'node:url'

// Optional OrangeJuice integration. AI remains usable without the command table.
export async function getCommandCatalog(input) {
  const source=new URL('../../../OrangeJuice-Plugin/command-knowledge.mjs',import.meta.url)
  if(!fs.existsSync(source))return null
  const [{commandCatalog},{default:loader},{default:cfg}]=await Promise.all([
    import(source.href),import('../../../../lib/plugins/loader.js'),import('../../../../lib/config/config.js')
  ])
  const event=input?{isMaster:input.isMaster===true,isGroup:Boolean(input.groupId),group_id:input.groupId,self_id:input.botId}:{isMaster:true}
  const table=commandCatalog(loader,event,{bridgeRoot:fileURLToPath(new URL('.',source)),groupConfig:input?.groupId?cfg.getGroup?.(input.botId,input.groupId)||{}:{}})
  table.memberRole='unknown'
  if(input?.groupId&&!input.isMaster) {
    const bot=globalThis.Bot?.bots?.[input.botId]||globalThis.Bot?.[input.botId]
    let timer
    try {
      const result=await Promise.race([input.getGroupMember ? input.getGroupMember() : bot?.sendApi?.('get_group_member_info',{group_id:Number(input.groupId),user_id:Number(input.userId),no_cache:true}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('权限查询超时')),1500)})])
      if((Number(result?.retcode)===0||result?.status==='ok')&&['member','admin','owner'].includes(result.data?.role))table.memberRole=result.data.role
    }catch{}finally{clearTimeout(timer)}
  }
  return table
}
