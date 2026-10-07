import test from 'node:test';import assert from 'node:assert/strict';
import {createStaticHelpApp} from '../integrations/yunzai/static-help.mjs';
class Base{constructor(options){this.options=options;}}
test('AI static help respects enablement, custom prefix and private master scope',async()=>{
 const topics=[],config={basic:{enabled:true,commandPrefix:'#助理'}};
 const App=createStaticHelpApp(Base,()=>config,{sendHelp:async(e,topic)=>{topics.push(topic);return true;}}),app=new App();
 assert.equal(await app.help({msg:'#助理帮助',group_id:'synthetic',isMaster:true}),true);assert.deepEqual(topics,['ai-public']);
 topics.length=0;await app.help({msg:'#AIhelp',isMaster:true});assert.deepEqual(topics,['ai-public','ai-master']);
 topics.length=0;assert.equal(await app.help({msg:'#AI登录',isMaster:true}),false);assert.equal(topics.length,0);
 config.basic.enabled=false;assert.equal(await app.help({msg:'#AI帮助'}),false);assert.equal(topics.length,0);
});
test('AI帮助文字模式不读图，也不在群展示主人附加页',async()=>{
 const replies=[],App=createStaticHelpApp(Base,()=>({basic:{enabled:true}}),{sendHelp:async()=>{throw new Error('UNEXPECTED_IMAGE_READ');}}),app=new App();
 assert.equal(await app.help({msg:'#AI帮助 文字',isMaster:true,group_id:'synthetic',reply:async text=>replies.push(text)}),true);
 assert.match(replies[0],/#AI预设列表/);assert.doesNotMatch(replies[0],/#AI登录/);
 replies.length=0;await app.help({msg:'#AIhelp 文字',isMaster:true,reply:async text=>replies.push(text)});assert.match(replies[0],/#AI登录/);
});
