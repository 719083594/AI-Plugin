import {fileURLToPath} from 'node:url';
import {createFixedHelpDelivery} from '../../src/rendering/static-help-reply.mjs';
import {helpTopics} from '../../src/rendering/help-content.mjs';
const root=fileURLToPath(new URL('../..',import.meta.url));

// A separate app leaves existing chat/persona integration changes untouched.
export function createStaticHelpApp(Base,getConfig,{sendHelp=createFixedHelpDelivery({root,defaultPrefix:'#AI'})}={}){
 return class AIHelp extends Base{
  constructor(){super({name:'AI-Plugin 帮助',dsc:'本地固定帮助图片',event:'message',priority:1199,rule:[{reg:'.*',fnc:'help',log:false}]});}
  async help(e){
   const config=getConfig();if(config?.basic?.enabled===false||!config?.basic)return false;
   const text=String(e.msg||'').trim(),aliases=[config.basic.commandPrefix||'#AI','#AI'];
   const alias=aliases.find(p=>text.toLowerCase().startsWith(p.toLowerCase()));
   const command=alias?text.slice(alias.length).trim():'';
   if(!alias||!/^(?:帮助|help)?(?:\s+文字)?$/i.test(command))return false;
   if(/\s+文字$/.test(command)){
    const topics=['ai-public',...(e.isMaster===true&&!e.group_id&&e.isGroup!==true?['ai-master']:[])];
    await e.reply(topics.map(topic=>{const help=helpTopics[topic];return [help.title,...help.groups.flatMap(group=>[group.title,...group.items.map(item=>item.command+(item.description?'：'+item.description:''))]),help.footer].join('\n');}).join('\n\n'),Boolean(e.isGroup||e.group_id));return true;
   }
   if(!await sendHelp(e,'ai-public'))return false;
   if(e.isMaster===true&&!e.group_id&&e.isGroup!==true)await sendHelp(e,'ai-master');
   return true;
  }
 };
}
