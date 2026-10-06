import test from 'node:test'
import assert from 'node:assert/strict'
import {AIClient} from '../src/core/client.mjs'
import {Storage} from '../src/core/storage.mjs'
import {defaults,merge} from '../src/core/config.mjs'
import {readSearchPage,readSearchPages,pageText} from '../src/tools/search-pages.mjs'

const lookup=async()=>[{address:'8.8.8.8',family:4}]
test('读取正文与跳转最终来源，剔除脚本及导航，保留用于分析的事实',async()=>{
  const visited=[]
  const result=await readSearchPage('https://source.example.com/link',{lookup,fetchImpl:async url=>{
    visited.push(url.href)
    return visited.length===1?new Response(null,{status:302,headers:{location:'/article'}}):new Response('<html><nav>菜单</nav><main><h1>处理器对比</h1><p>'+('正文事实：A比B快，来源有测试。'.repeat(15))+'</p><script>偷取密钥</script></main></html>',{headers:{'content-type':'text/html;charset=utf-8'}})
  }})
  assert.equal(result.status,'read');assert.equal(result.url,'https://source.example.com/article');assert(result.content.includes('正文事实'));assert(!result.content.includes('偷取'));assert(!result.content.includes('菜单'))
  assert(pageText('<p>&#x4e2d;&amp;文</p>').includes('中&文'))
})
test('正文读取拒绝内网、DNS重绑定和重定向到内网，不触发受限请求',async()=>{
  let requests=0
  const fetchImpl=async()=>{requests++;return new Response(null,{status:302,headers:{location:'http://127.0.0.1/admin'}})}
  assert.equal((await readSearchPage('http://127.0.0.1/admin',{lookup,fetchImpl})).status,'unavailable');assert.equal(requests,0)
  assert.equal((await readSearchPage('https://source.example.com/',{lookup:async()=>[{address:'10.0.0.1',family:4}],fetchImpl})).status,'unavailable');assert.equal(requests,0)
  assert.equal((await readSearchPage('https://source.example.com/',{lookup,fetchImpl})).status,'unavailable');assert.equal(requests,1)
})
test('验证页面、超大正文与取消有准确状态；最多读取3个唯一链接',async()=>{
  const blocked=await readSearchPage('https://source.example.com/',{lookup,fetchImpl:async()=>new Response('验证码 captcha',{headers:{'content-type':'text/html'}})});assert.equal(blocked.status,'blocked')
  const big=await readSearchPage('https://source.example.com/',{lookup,fetchImpl:async()=>new Response('x',{headers:{'content-type':'text/html','content-length':'999999'}})});assert.equal(big.status,'unavailable')
  const signal=AbortSignal.abort();assert.equal((await readSearchPage('https://source.example.com/',{signal,lookup})).status,'unavailable')
  let calls=0
  const result=await readSearchPages({results:[...Array.from({length:5},(_,n)=>({url:'https://source.example.com/'+n,title:'来源'+n})),{url:'https://source.example.com/0'}]},{reader:async url=>{calls++;return {url,status:'read',content:'实际正文'}}})
  assert.equal(calls,3);assert.equal(result.pageRead.read,3);assert.equal(result.pages[0].content,'实际正文')
})
function fixture(t,provider){
  const storage=new Storage(),calls=[],searches=[]
  const config=merge(defaults,{channels:[{id:'test',type:'openai',baseUrl:'https://provider.invalid',apiKey:'test',models:['fake']}],presets:[{...defaults.presets[0],model:'fake',tools:['web_search']}],security:{maxRequestsPerWindow:100}})
  const client=new AIClient({storage,imageStore:{},config:()=>config,search:async args=>{searches.push(args);return {ok:true,query:args.query,results:[{title:'实际测试资料',url:'https://source.invalid/article',snippet:'搜索摘要'}]}},host:{readSearchPages:async result=>({...result,pages:[{title:'实际测试资料',sourceUrl:result.results[0].url,url:'https://source.invalid/final',status:'read',content:'新型号实测提升约百分之十；基础频率更高。'}],pageRead:{attempted:1,read:1}})},provider:async request=>{calls.push(structuredClone({...request,signal:undefined}));return provider(calls.length,request)}})
  t.after(()=>client.close());return {client,calls,searches,storage,config}
}
const tool=()=>({contents:[],toolCalls:[{id:'search-one',name:'web_search',arguments:{query:'两款处理器性能对比'}}],usage:{inputTokens:1}})
const answer=text=>({contents:[{type:'text',text}],toolCalls:[],usage:{inputTokens:2}})
test('搜索后的XML工具计划只修复一次，分析接收真实正文，不重复搜索或发送计划',async t=>{
  const f=fixture(t,n=>n===1?tool():n===2?answer('<tool_call>web_search<arg_key>query</arg_key><arg_value>对比</arg_value></tool_call>'):answer('结论：新型号略快，实测约提升百分之十，基础频率也更高。'))
  const result=await f.client.chat({userId:'test-user',text:'这两款处理器哪款更快',transient:true})
  assert.equal(f.searches.length,1);assert.equal(f.calls.length,3);assert.equal(f.calls[1].tools.length,0);assert(JSON.stringify(f.calls[1].messages).includes('新型号实测提升'));assert(!result.text.includes('<tool_call>'));assert(result.text.startsWith('结论'));assert(result.text.includes('https://source.invalid/final'));assert.equal(result.searchAnalysis.status,'analyzed');assert.equal(result.searchAnalysis.pagesRead,1)
})
test('上游堵塞时保留已经搜索成功的来源，明确未分析，不伪装成搜索失败',async t=>{
  const f=fixture(t,n=>{if(n===1)return tool();throw Object.assign(new Error('上游暂时不可用'),{code:'API_ERROR'})})
  const result=await f.client.chat({userId:'test-user',text:'查询并分析',transient:true})
  assert.equal(f.calls.length,2);assert.equal(f.searches.length,1);assert(result.text.includes('搜索已成功'));assert(result.text.includes('https://source.invalid/final'));assert.equal(result.searchAnalysis.status,'upstream_error');assert.equal(f.storage.logs()[0].searchAnalysis.status,'upstream_error')
})
test('模型重复只返回链接清单时明确兜底，单次修复后停止',async t=>{
  const f=fixture(t,n=>n===1?tool():answer('来源：\nhttps://source.invalid/final'))
  const result=await f.client.chat({userId:'test-user',text:'请分析',transient:true})
  assert.equal(f.calls.length,3);assert.equal(f.searches.length,1);assert(result.text.includes('AI 暂时未能完成分析'));assert.equal(result.searchAnalysis.status,'no_analysis')
})

test('搜索成功后上游一直无响应也发送链接，外部取消仍不发送过期结果',async t=>{
  const f=fixture(t,n=>n===1?tool():new Promise(()=>{}))
  f.config.chat.timeoutMs=100;f.config.chat.toolTimeoutMs=3000
  const keepAlive=setTimeout(()=>{},1500);t.after(()=>clearTimeout(keepAlive))
  let sent
  const result=await f.client.chat({userId:'test-user',text:'查询并分析',transient:true},{send:async value=>{sent=value;return {delivered:true}}})
  assert.equal(result.searchAnalysis.status,'upstream_error');assert(sent.text.includes('https://source.invalid/final'));assert(sent.text.includes('搜索已成功'))
  const controller=new AbortController()
  const canceled=fixture(t,n=>{if(n===1)return tool();controller.abort(new Error('用户取消'));return new Promise(()=>{})})
  let deliveries=0
  await assert.rejects(canceled.client.chat({userId:'test-user',text:'请分析',transient:true},{signal:controller.signal,send:()=>{deliveries++}}),/取消/)
  assert.equal(deliveries,0)
})
