import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AIClient } from '../src/core/client.mjs'
import { Storage } from '../src/core/storage.mjs'
import { defaults, merge, validateConfig } from '../src/core/config.mjs'
import { checkDailyCleanup } from '../src/core/daily-cleanup.mjs'

function fixture(t, storage = new Storage()) {
  const config = merge(defaults, { channels: [{ id: 'mock', type: 'openai' }], presets: [{ id: 'default', model: 'mock', tools: [] }] })
  const client = new AIClient({ config: () => config, storage, imageStore: {}, provider: async () => ({ contents: [{ type: 'text', text: '回复' }], toolCalls: [] }) })
  t.after(() => client.close()); return { client, storage, config }
}
async function seed(client, storage) {
  storage.selectPreset('u', 'default');storage.addMemory('user', 'u', '保留事实');storage.addKnowledge('资料', '知识文本')
  storage.appendGroup('g', { id: 'msg', text: '群聊' });await client.chat({ userId: 'u', text: '问题', isMaster: true })
}
test('Beijing 03:30 cleanup runs once per day and preserves roles, manual memory and knowledge', async t => {
  const { client, storage } = fixture(t);await seed(client, storage)
  checkDailyCleanup(client, new Date('2026-10-06T19:29:00Z'))
  assert.equal(storage.stats().history, 2)
  const result = checkDailyCleanup(client, new Date('2026-10-06T19:30:00Z'))
  assert.equal(result.history, 2);assert.equal(result.groups, 1);assert.equal(storage.stats().history, 0)
  assert.equal(storage.state('u').settings.preset, 'default');assert.equal(storage.stats().memories, 1);assert.equal(storage.stats().knowledge, 1)
  await client.chat({ userId: 'u', text: '清理后的问题', isMaster: true })
  assert.equal(checkDailyCleanup(client, new Date('2026-10-06T19:31:00Z')).skipped, true)
  assert.equal(storage.stats().history, 2)
  assert.equal(checkDailyCleanup(client, new Date('2026-10-07T19:30:00Z')).history, 2)
})
test('cleanup marker persists across restart; first late startup waits until tomorrow; disabled switch works', async t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'ai-cleanup-test-')),filename=path.join(root,'ai.db')
  const storage=new Storage(filename), {client,config}=fixture(t,storage)
  await seed(client,storage)
  assert.equal(checkDailyCleanup(client,new Date('2026-10-06T20:00:00Z')).reason,'initialized')
  assert.equal(storage.stats().history,2)
  const second=new Storage(filename);t.after(()=>second.close())
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}))
  assert.equal(second.maintenance('daily-history-cleanup').lastDate,'2026-10-07')
  config.retention.dailyCleanupEnabled=false
  assert.equal(checkDailyCleanup(client,new Date('2026-10-07T20:00:00Z')).reason,'disabled')
  config.retention.dailyCleanupEnabled=true
  assert.equal(checkDailyCleanup(client,new Date('2026-10-07T20:00:00Z')).history,2)
})
test('clearing while the provider is waiting cancels late output and never repopulates history', async t => {
  const {client,storage}=fixture(t);let release,started
  const ready=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>release=resolve)
  client.provider=async()=>{started();return pending}
  let sent=0;const work=client.chat({userId:'u',text:'等待',isMaster:true},{send:async()=>{sent++}})
  const checked=assert.rejects(work,/清理|新会话/);await ready
  client.clearHistory();release({contents:[{type:'text',text:'迟到'}]});await checked
  assert.equal(sent,0);assert.equal(storage.stats().history,0)
})
test('invalid daily time, timezone and switch are rejected', () => {
  for(const retention of [{dailyCleanupTime:'25:30'},{dailyCleanupTime:'3.30'},{dailyCleanupTimezone:'invalid/place'},{dailyCleanupEnabled:'yes'}]) assert.throws(()=>validateConfig(merge(defaults,{retention})),/清理/)
})

test('changing to a future time arms today without repeating a cleanup that already ran today', async t => {
  const {client,storage,config}=fixture(t);await seed(client,storage)
  checkDailyCleanup(client,new Date('2026-10-06T20:00:00Z'))
  config.retention.dailyCleanupTime='04:01'
  assert.equal(checkDailyCleanup(client,new Date('2026-10-06T20:00:00Z')).reason,'configuration-updated')
  assert.equal(checkDailyCleanup(client,new Date('2026-10-06T20:01:00Z')).history,2)
  await client.chat({userId:'u',text:'新对话',isMaster:true})
  config.retention.dailyCleanupTime='04:02'
  checkDailyCleanup(client,new Date('2026-10-06T20:01:00Z'))
  assert.equal(checkDailyCleanup(client,new Date('2026-10-06T20:02:00Z')).skipped,true)
  assert.equal(storage.stats().history,2)
})
