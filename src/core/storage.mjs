import { DatabaseSync } from 'node:sqlite'
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export class Storage {
  constructor(filename = ':memory:') {
    this.filename = filename
    if (filename !== ':memory:') fs.mkdirSync(path.dirname(filename), { recursive: true })
    this.db = new DatabaseSync(filename)
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS user_states(id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY, parentId TEXT, conversationId TEXT NOT NULL, role TEXT NOT NULL, messageData TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS history_conversation ON history(conversationId,createdAt);
      CREATE TABLE IF NOT EXISTS operation_logs(id TEXT PRIMARY KEY, createdAt TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY, scope TEXT NOT NULL, ownerId TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS knowledge(id TEXT PRIMARY KEY, title TEXT NOT NULL, text TEXT NOT NULL, createdAt TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS legacy(key TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS group_context(id TEXT PRIMARY KEY, data TEXT NOT NULL);`)
  }
  state(id) { const row = this.db.prepare('SELECT data FROM user_states WHERE id=?').get(String(id)); return row ? JSON.parse(row.data) : { id: String(id), settings: {}, current: { conversationId: randomUUID(), messageId: null }, revision: 0 } }
  saveState(state) { this.db.prepare('INSERT OR REPLACE INTO user_states VALUES(?,?)').run(String(state.id), JSON.stringify(state)); return state }
  users() { return this.db.prepare('SELECT id,data FROM user_states').all().map(row => ({ id: row.id, ...JSON.parse(row.data) })) }
  selectPreset(id, preset) { const state = this.state(id); state.settings.preset = preset; state.current = { conversationId: randomUUID(), messageId: null }; state.revision = (state.revision || 0) + 1; return this.saveState(state) }
  reset(id) { const state = this.state(id); state.current = { conversationId: randomUUID(), messageId: null }; state.revision = (state.revision || 0) + 1; return this.saveState(state) }
  resetAll() { for (const state of this.users()) this.reset(state.id) }
  history(conversationId, limit = 20, parentId = null) {
    const expand = rows => rows.flatMap(row => row.role === 'tool' && row.toolResults?.length ? row.toolResults.map(result => ({ ...row, ...result, role: 'tool' })) : [row])
    if (parentId) {
      const rows = [], visited = new Set(); let id = parentId
      while (id && rows.length < limit && !visited.has(id)) {
        visited.add(id)
        const row = this.db.prepare('SELECT * FROM history WHERE id=? AND conversationId=?').get(id, conversationId)
        if (!row) break
        rows.push({ ...JSON.parse(row.messageData), id: row.id, parentId: row.parentId, role: row.role }); id = row.parentId
      }
      return expand(rows.reverse())
    }
    return expand(this.db.prepare('SELECT * FROM history WHERE conversationId=? ORDER BY createdAt DESC,rowid DESC LIMIT ?').all(conversationId, limit).reverse().map(row => ({ ...JSON.parse(row.messageData), id: row.id, parentId: row.parentId, role: row.role })))
  }
  commitTurn({ userId, revision, conversationId, parentId, messages }) {
    const state = this.state(userId)
    if ((state.revision || 0) !== revision || state.current.conversationId !== conversationId || (state.current.messageId || null) !== (parentId || null)) return false
    this.db.exec('BEGIN IMMEDIATE')
    try {
      let previous = parentId
      for (const message of messages) {
        const id = message.id || randomUUID()
        this.db.prepare('INSERT OR IGNORE INTO history VALUES(?,?,?,?,?,?)').run(id, previous || null, conversationId, message.role, JSON.stringify(message), new Date().toISOString())
        previous = id
      }
      state.current.messageId = previous; this.saveState(state)
      this.db.exec('COMMIT'); return true
    } catch (error) { this.db.exec('ROLLBACK'); throw error }
  }
  log(data) { this.db.prepare('INSERT INTO operation_logs VALUES(?,?,?)').run(randomUUID(), new Date().toISOString(), JSON.stringify(data)) }
  logs(limit = 100) { return this.db.prepare('SELECT * FROM operation_logs ORDER BY createdAt DESC LIMIT ?').all(Math.min(1000, Number(limit) || 100)).map(row => ({ id: row.id, createdAt: row.createdAt, ...JSON.parse(row.data) })) }
  stats() {
    const counts = Object.fromEntries(['user_states', 'history', 'operation_logs', 'memories', 'knowledge'].map(table => [table, this.db.prepare('SELECT count(*) AS n FROM ' + table).get().n]))
    return { ...counts, filename: this.filename === ':memory:' ? '内存数据库' : path.basename(this.filename) }
  }
  usageStats() {
    const totals = { requests: 0, successes: 0, failures: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, averageDurationMs: 0, byModel: {} }
    let duration = 0
    for (const row of this.db.prepare('SELECT data FROM operation_logs').all()) {
      const log = JSON.parse(row.data); if (log.kind !== 'chat') continue
      totals.requests++; totals[log.success ? 'successes' : 'failures']++; duration += log.durationMs || 0
      for (const key of ['inputTokens', 'outputTokens', 'totalTokens']) totals[key] += log.usage?.[key] || 0
      if (log.model) { const group = totals.byModel[log.model] ||= { requests: 0, totalTokens: 0 }; group.requests++; group.totalTokens += log.usage?.totalTokens || 0 }
    }
    totals.averageDurationMs = totals.requests ? Math.round(duration / totals.requests) : 0
    return totals
  }
  addMemory(scope, ownerId, text) { if (!['user', 'group'].includes(scope) || !String(text).trim()) throw new Error('记忆范围或内容无效'); const id = randomUUID(); this.db.prepare('INSERT INTO memories VALUES(?,?,?,?,?)').run(id, scope, String(ownerId), String(text).slice(0, 4000), new Date().toISOString()); return id }
  memories(scope, ownerId, limit = 5) { return this.db.prepare('SELECT * FROM memories WHERE scope=? AND ownerId=? ORDER BY createdAt DESC LIMIT ?').all(scope, String(ownerId), limit) }
  deleteMemory(id, scope, ownerId) { return this.db.prepare('DELETE FROM memories WHERE id=? AND scope=? AND ownerId=?').run(id, scope, String(ownerId)).changes > 0 }
  addKnowledge(title, text) { if (!text || text.length > 100000) throw new Error('知识内容为空或超出长度限制'); const id = randomUUID(); this.db.prepare('INSERT INTO knowledge VALUES(?,?,?,?)').run(id, String(title), String(text), new Date().toISOString()); return id }
  searchKnowledge(query, limit = 3) {
    const terms = String(query).split(/[\s，。？！、]+/).filter(x => x.length > 1).slice(0, 8)
    if (!terms.length) return []
    return this.db.prepare("SELECT id,title,text FROM knowledge WHERE id NOT LIKE 'commands:%' AND (" + terms.map(() => 'text LIKE ?').join(' OR ') + ') LIMIT ?').all(...terms.map(term => '%' + term.replace(/[%_]/g, '') + '%'), limit)
  }
  group(id) { const row = this.db.prepare('SELECT data FROM group_context WHERE id=?').get(String(id)); return row ? JSON.parse(row.data) : [] }
  appendGroup(id, message, limit = 20) { const rows = this.group(id); if (rows.some(row => message.id && row.id === message.id)) return; rows.push(message); this.db.prepare('INSERT OR REPLACE INTO group_context VALUES(?,?)').run(String(id), JSON.stringify(rows.slice(-Math.max(1, limit)))) }
  cleanup({ historyDays = 30, proactiveHistoryDays = 30, logLimit = 5000 } = {}) {
    let history = 0
    for (const [days, isProactive] of [[historyDays, false], [proactiveHistoryDays, true]]) if (days > 0) {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString()
      history += this.db.prepare('DELETE FROM history WHERE createdAt<? AND conversationId ' + (isProactive ? 'LIKE' : 'NOT LIKE') + " 'bym%'").run(cutoff).changes
    }
    const logs = this.db.prepare('DELETE FROM operation_logs WHERE id IN (SELECT id FROM operation_logs ORDER BY createdAt DESC LIMIT -1 OFFSET ?)').run(Math.max(1, logLimit)).changes
    this.db.exec('PRAGMA wal_checkpoint(PASSIVE)')
    return { history, logs }
  }
  backup(destination) { fs.mkdirSync(path.dirname(destination), { recursive: true }); if (fs.existsSync(destination)) throw new Error('备份目标已存在'); this.db.prepare('VACUUM INTO ?').run(destination); return destination }
  close() { this.db.close() }
}
