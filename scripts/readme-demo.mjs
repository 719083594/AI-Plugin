// Isolated README preview: real management server and web assets, synthetic data.
// No existing config, database, model service or network provider is opened.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {defaults,merge} from '../src/core/config.mjs';
import {startManagement} from '../src/management/server.mjs';

const source=fileURLToPath(new URL('../',import.meta.url));
const root=await fs.mkdtemp(path.join(os.tmpdir(),'ai-readme-demo-'));
const version=JSON.parse(await fs.readFile(path.join(source,'package.json'),'utf8')).version;
const port=Number(process.env.README_DEMO_PORT||48881);
if(!Number.isInteger(port)||port<1024||port>65535)throw new Error('Invalid local demo port');
for(const file of ['capabilities.json','orangejuice.plugin.json','web/index.html','web/app.js','web/app.css']){
  await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});
  await fs.copyFile(path.join(source,file),path.join(root,file));
}
const config=merge(defaults,{
  channels:[],
  presets:[{...defaults.presets[0],id:'demo',name:'演示助手 · 固定回复',model:'offline-demo',tools:[]}],
  basic:{defaultPresetId:'demo'},
  management:{host:'127.0.0.1',port,publicUrl:`http://127.0.0.1:${port}`,apiToken:''}
});
const records=[];
const client={root,config:()=>config,
  health:()=>({name:'AI-Plugin',version:`${version} · 离线演示`,ready:true}),
  storage:{logs:()=>records,stats:()=>({}),usageStats:()=>({}),users:()=>[],history:()=>[]},
  chat:async()=>{
    records.unshift({createdAt:'离线演示',success:true,model:'offline-demo',durationMs:0});
    return {text:'可以，从这三步开始：\n\n1. 建立一个角色预设，选择模型与工具。\n2. 用 CLI 或网页工作台先完成一次对话。\n3. 需要群聊时，再启用可选的云崽适配器。\n\n提示：这是一段固定的离线演示回复，用来展示界面；不会调用外部模型。',contents:[],model:'offline-demo'};
  },end:()=>{},clearHistory:()=>({message:'演示实例没有真实聊天历史'})};
const management=startManagement(client);
await management.ready;
console.log(`README_DEMO_URL=${management.ticket()}`);
console.log('Synthetic preview only. Press Ctrl+C to close and remove its temporary directory.');
let closing=false;
async function close(){
  if(closing)return;closing=true;
  await management.close();
  const resolved=path.resolve(root),temp=path.resolve(os.tmpdir());
  if(path.dirname(resolved)!==temp||!path.basename(resolved).startsWith('ai-readme-demo-'))throw new Error('Unexpected demo directory');
  await fs.rm(resolved,{recursive:true,force:true});
  process.exit(0);
}
process.on('SIGINT',close);process.on('SIGTERM',close);
