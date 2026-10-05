import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { defaults } from '../src/core/config.mjs';
import { superviseChild } from './helpers/resources.mjs';

const python = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
const script = fileURLToPath(new URL('../scripts/migrate-chatgpt.py', import.meta.url));
const fixtureKey = 'synthetic-private-key-one';
const fixturePrompt = 'synthetic-private-system-prompt-do-not-print';
const fixture = String.raw`
import json, sqlite3, sys
from pathlib import Path
root=Path(sys.argv[1]); data=root/'data'; data.mkdir(parents=True)
j=lambda v:json.dumps(v,ensure_ascii=False)
legacy={'basic':{'toggleMode':'at'},'llm':{'defaultChatPresetId':'default_local','historyLength':20},'vision':{'imageRetentionPreset':'forever'},'bym':{'enable':True,'sendReasoning':False},'management':{'defaultRateLimit':6}}
(data/'config.json').write_text(j(legacy),encoding='utf-8')
db=sqlite3.connect(data/'data.db'); db.execute('PRAGMA journal_mode=WAL');db.execute('PRAGMA wal_autocheckpoint=0')
db.executescript('''
CREATE TABLE channels(id TEXT PRIMARY KEY,name TEXT,adapterType TEXT,options TEXT,models TEXT,status TEXT,priority INTEGER,weight INTEGER);
CREATE TABLE chat_presets(id TEXT PRIMARY KEY,name TEXT,prefix TEXT,sendMessageOption TEXT);
CREATE TABLE user_states(id TEXT PRIMARY KEY,userId TEXT,nickname TEXT,settings TEXT,current TEXT,conversations TEXT);
CREATE TABLE tools(id TEXT PRIMARY KEY,name TEXT,code TEXT);
CREATE TABLE tools_groups(id TEXT PRIMARY KEY,data TEXT);
CREATE TABLE processors(id TEXT PRIMARY KEY,name TEXT,code TEXT);
CREATE TABLE triggers(id TEXT PRIMARY KEY,code TEXT);
CREATE TABLE mcp_servers(id TEXT PRIMARY KEY,data TEXT);
CREATE TABLE group_context_cache(id TEXT PRIMARY KEY,data TEXT);
''')
db.execute('INSERT INTO channels VALUES(?,?,?,?,?,?,?,?)',('channel1','一','OpenAI',j({'baseUrl':'https://gateway.invalid/v1','apiKey':'synthetic-private-key-one'}),j([{'name':'model1','features':['chat','tool']},{'name':'vision-model','features':['vision','tool']}]),'enabled',2,3))
db.execute('INSERT INTO channels VALUES(?,?,?,?,?,?,?,?)',('channel2','二','Gemini',j({'baseUrl':'https://other.invalid/v1beta','apiKey':['synthetic-private-key-two','synthetic-private-key-three']}),j(['model2']),'disabled',1,2))
db.execute('INSERT INTO chat_presets VALUES(?,?,?,?)',('default_local','默认角色','#one',j({'model':'model1','systemOverride':'synthetic-private-system-prompt-do-not-print','maxTokens':1234})))
db.execute('INSERT INTO chat_presets VALUES(?,?,?,?)',('firefly_local','另一角色','#two',j({'model':'model2','systemPrompt':'synthetic-second-private-prompt','maxToken':1000})))
db.execute('INSERT INTO user_states VALUES(?,?,?,?,?,?)',('old-uuid-not-a-qq-id','300000001','测试用户',j({'preset':'default_local'}),j({'conversationId':'conversation-one','messageId':'h-final'}),j(['conversation-one','conversation-two'])))
db.execute('INSERT INTO tools VALUES(?,?,?)',('raw-tool','raw-tool',"throw new Error('legacy tool must never execute');"))
db.execute('INSERT INTO processors VALUES(?,?,?)',('raw-processor','raw-processor',"throw new Error('legacy processor must never execute');"))
db.commit()
history=sqlite3.connect(data/'history.db');history.execute('PRAGMA journal_mode=WAL');history.execute('PRAGMA wal_autocheckpoint=0')
history.execute('CREATE TABLE history(id TEXT PRIMARY KEY,parentId TEXT,conversationId TEXT,role TEXT,messageData TEXT,createdAt TEXT)')
rows=[
('h-user',None,'conversation-one','user',{'role':'user','content':[{'type':'text','text':'原始问题'},{'type':'image','image':'https://cdn.invalid/p.png','mimeType':'image/png'},{'type':'image','image':'base64://aW1hZ2U=','mimeType':'image/png'}]}),
('h-assistant','h-user','conversation-one','assistant',{'role':'assistant','content':[{'type':'reasoning','text':'核对','signature':'preserved-signature'}],'toolCalls':[{'id':'call-one','type':'function','function':{'name':'web_search','arguments':'{"query":"完整中文问题"}'}},{'id':'call-two','name':'GetQQAvatar','params':{'qqs':['300000001']}}]}),
('h-tools','h-assistant','conversation-one','tool',{'role':'tool','content':[{'type':'tool','tool_call_id':'call-one','name':'web_search','content':'{"results":[{"title":"资料"}]}'},{'type':'tool','tool_call_id':'call-two','name':'GetQQAvatar','content':{'ref':'legacy-ref'}}]}),
('h-final','h-tools','conversation-one','assistant',{'role':'assistant','content':[{'type':'text','text':'最终回答'}]}),
('h-branch','h-user','conversation-one','assistant',{'role':'assistant','content':[{'type':'text','text':'另一个分支'}]}),
('h-second',None,'conversation-two','user',{'role':'user','content':[{'type':'text','text':'第二个会话'}]})]
for i,(identifier,parent,conversation,role,message) in enumerate(rows):history.execute('INSERT INTO history VALUES(?,?,?,?,?,?)',(identifier,parent,conversation,role,j(message),f'2026-01-01T00:00:0{i}Z'))
history.commit()
# Keep both connections open: this latest committed record remains in WAL.
history.execute('INSERT INTO history VALUES(?,?,?,?,?,?)',('h-wal-recent','h-final','conversation-one','user',j({'role':'user','content':[{'type':'text','text':'最新 WAL 记录'}]}),'2026-01-01T00:00:07Z'));history.commit()
memory=sqlite3.connect(data/'memory.db');memory.executescript('CREATE TABLE user_memory(id INTEGER,user_id TEXT,value TEXT,created_at TEXT); CREATE TABLE group_facts(id INTEGER,group_id TEXT,fact TEXT,created_at TEXT);')
memory.execute('INSERT INTO user_memory VALUES(?,?,?,?)',(1,'300000001','用户事实','2026-01-01T00:00:00Z'));memory.execute('INSERT INTO group_facts VALUES(?,?,?,?)',(2,'10001','群事实','2026-01-01T00:00:00Z'));memory.commit()
print('READY',flush=True)
sys.stdin.readline()
for connection in (memory,history,db):connection.close()
`;

async function fixtureTree(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ai-plugin-migration-test-'));
  const source = path.join(directory, 'source'), target = path.join(directory, 'target'), backup = path.join(directory, 'backup');
  let lifecycle;
  // Register cleanup before setup, so failed startup still stops Python and removes the fixture.
  t.after(async () => {
    try { if (lifecycle) await lifecycle.stop(); }
    finally {
      const resolved = path.resolve(directory);
      assert.ok(resolved.startsWith(path.resolve(os.tmpdir()) + path.sep));
      assert.ok(path.basename(resolved).startsWith('ai-plugin-migration-test-'));
      await fs.rm(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    }
  });
  await fs.mkdir(path.join(target, 'config'), { recursive: true });
  await fs.writeFile(path.join(target, 'config/example.json'), JSON.stringify(defaults));
  const child = spawn(python, ['-u', '-c', fixture, source], { env: { ...process.env, PYTHONUTF8: '1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  lifecycle = superviseChild(child, { label: 'Python migration fixture' });
  await lifecycle.ready();
  return { directory, source, target, backup };
}

function migrate(tree, overrides = {}) {
  return spawnSync(python, [script, '--source', overrides.source || tree.source, '--target', overrides.target || tree.target,
    '--backup', overrides.backup || tree.backup, '--bot-id', '123456789'], { encoding: 'utf8', timeout: 10000, env: { ...process.env, PYTHONUTF8: '1' } });
}
function readDb(filename, query) {
  const db = new DatabaseSync(filename, { readOnly: true });
  try { return db.prepare(query).all().map(row => ({ ...row })); } finally { db.close(); }
}
function failure(result) { assert.notEqual(result.status, 0); assert.doesNotMatch(result.stdout + result.stderr, new RegExp(`${fixtureKey}|${fixturePrompt}`)); }

test('real Python migration preserves private configuration and all history relationships including WAL', async t => {
  const tree = await fixtureTree(t);
  const originalConfig = await fs.readFile(path.join(tree.source, 'data/config.json'), 'utf8');
  const originalMain = await fs.readFile(path.join(tree.source, 'data/history.db'));
  assert.ok((await fs.stat(path.join(tree.source, 'data/history.db-wal'))).size > 0);
  const result = migrate(tree);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout + result.stderr, /synthetic-private-key|synthetic-private-system-prompt|原始问题|最终回答/);
  assert.deepEqual(JSON.parse(result.stdout), { channels: 2, presets: 2, users: 1, history: 7, memories: 2, backupCreated: true });
  const config = JSON.parse(await fs.readFile(path.join(tree.target, 'config/local.json'), 'utf8'));
  assert.equal(config.channels[0].apiKey, fixtureKey);
  assert.deepEqual(config.channels[0].models, [{ name: 'model1', features: ['chat', 'tool'] }, { name: 'vision-model', features: ['vision', 'tool'] }]);
  assert.equal(config.channels[1].apiKey, 'synthetic-private-key-two');
  assert.deepEqual(config.channels[1].apiKeys, ['synthetic-private-key-two', 'synthetic-private-key-three']);
  assert.equal(config.presets[0].systemPrompt, fixturePrompt);
  assert.equal(config.presets[0].maxTokens, 1234);
  assert.equal(config.presets[1].maxTokens, 1000);
  assert.equal(config.media.imageRetentionHours, 0);
  assert.doesNotMatch(await fs.readFile(path.join(tree.target, 'config/example.json'), 'utf8'), /synthetic-private/);
  assert.doesNotMatch(await fs.readFile(path.join(tree.target, 'data/migration-report.json'), 'utf8'), /synthetic-private/);
  const rows = readDb(path.join(tree.target, 'data/ai.db'), 'SELECT id,parentId,conversationId,role,messageData FROM history ORDER BY id');
  const originalRows = readDb(path.join(tree.backup, 'history.db'), 'SELECT id,parentId,conversationId,role FROM history ORDER BY id');
  assert.deepEqual(rows.map(({ messageData, ...row }) => row), originalRows);
  assert.equal(rows.length, 7);
  assert.ok(rows.some(row => row.id === 'h-wal-recent'));
  const state = readDb(path.join(tree.target, 'data/ai.db'), 'SELECT id,data FROM user_states')[0];
  assert.equal(state.id, '123456789:300000001');
  const data = JSON.parse(state.data);
  assert.equal(data.legacyId, 'old-uuid-not-a-qq-id');
  assert.equal(data.current.conversationId, 'conversation-one');
  assert.equal(data.current.messageId, 'h-final');
  assert.deepEqual(data.conversations, ['conversation-one', 'conversation-two']);
  const user = JSON.parse(rows.find(row => row.id === 'h-user').messageData);
  assert.equal(user.content[1].url, 'https://cdn.invalid/p.png');
  assert.equal(user.content[1].data, undefined);
  assert.equal(user.content[2].data, 'aW1hZ2U=');
  assert.equal(user.content[2].mime, 'image/png');
  const calls = JSON.parse(rows.find(row => row.id === 'h-assistant').messageData);
  assert.deepEqual(calls.toolCalls[0].arguments, { query: '完整中文问题' });
  assert.equal(calls.toolCalls[0].name, 'web_search');
  assert.equal(calls.content[0].signature, 'preserved-signature');
  const tool = JSON.parse(rows.find(row => row.id === 'h-tools').messageData);
  assert.equal(tool.toolCallId, 'call-one');
  assert.deepEqual(tool.toolResults.map(item => item.toolCallId), ['call-one', 'call-two']);
  assert.deepEqual(JSON.parse(tool.toolResults[1].content[0].text), { ref: 'legacy-ref' });
  const legacy = readDb(path.join(tree.target, 'data/ai.db'), 'SELECT key,data FROM legacy');
  assert.equal(JSON.parse(legacy.find(row => row.key === 'tools').data)[0].code, "throw new Error('legacy tool must never execute');");
  assert.equal(JSON.parse(legacy.find(row => row.key === 'processors').data)[0].code, "throw new Error('legacy processor must never execute');");
  const memories = readDb(path.join(tree.target, 'data/ai.db'), 'SELECT scope,ownerId,text FROM memories ORDER BY scope');
  assert.deepEqual(memories.map(row => row.ownerId), ['10001', '300000001']);
  assert.equal(await fs.readFile(path.join(tree.source, 'data/config.json'), 'utf8'), originalConfig);
  assert.deepEqual(await fs.readFile(path.join(tree.source, 'data/history.db')), originalMain);
  const repeated = migrate(tree); failure(repeated);
  assert.match(repeated.stderr, /备份目录已存在/);
});

test('migration rejects source/target/backup overlap before creating artifacts', async t => {
  const tree = await fixtureTree(t);
  const same = migrate(tree, { target: tree.source }); failure(same); assert.match(same.stderr, /源与目标目录必须独立/);
  const nested = migrate(tree, { target: path.join(tree.source, 'nested') }); failure(nested);
  const backupInSource = migrate(tree, { backup: path.join(tree.source, 'backup') }); failure(backupInSource); assert.match(backupInSource.stderr, /备份目录必须/);
  const backupInTarget = migrate(tree, { backup: path.join(tree.target, 'backup') }); failure(backupInTarget);
  const backupAncestor = migrate(tree, { backup: tree.directory }); failure(backupAncestor);
  assert.equal(await fs.stat(tree.backup).then(() => true, () => false), false);
  assert.equal(await fs.stat(path.join(tree.target, 'config/local.json')).then(() => true, () => false), false);
});

test('migration refuses existing private target configuration or database without overwriting', async t => {
  const tree = await fixtureTree(t);
  const privateFile = path.join(tree.target, 'config/local.json');
  await fs.writeFile(privateFile, '{"sentinel":"keep"}');
  const result = migrate(tree); failure(result); assert.match(result.stderr, /拒绝覆盖/);
  assert.equal(await fs.readFile(privateFile, 'utf8'), '{"sentinel":"keep"}');
  await fs.unlink(privateFile);
  await fs.mkdir(path.join(tree.target, 'data'));
  const database = path.join(tree.target, 'data/ai.db');
  await fs.writeFile(database, 'existing database sentinel');
  const existingDb = migrate(tree); failure(existingDb);
  assert.equal(await fs.readFile(database, 'utf8'), 'existing database sentinel');
  assert.equal(await fs.stat(tree.backup).then(() => true, () => false), false);
});
