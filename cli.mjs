#!/usr/bin/env node
import path from 'node:path'
import fs from 'node:fs'
import { randomBytes } from 'node:crypto'
import { AIClient, readConfig } from './api.mjs'
import { pluginRoot, writeJson } from './src/core/config.mjs'
import { startManagement } from './src/management/server.mjs'
const args = process.argv.slice(2), command = args.shift() || 'help'
const option = name => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1] }
const root = path.resolve(option('--root') || pluginRoot), configFile = path.resolve(option('--config') || path.join(root, 'config/local.json'))
try {
  if (command === 'help') console.log('AI-Plugin\nnode cli.mjs diagnose|serve|chat|backup|restore|init [--root 目录] [--config 配置]\nchat --text 问题 --preset 预设\nrestore --backup 备份目录（须先停止机器人/AI服务）')
  else if (command === 'init') { if (fs.existsSync(configFile)) throw new Error('配置已存在，不会覆盖'); const config = readConfig(configFile); config.management.apiToken = randomBytes(32).toString('hex'); writeJson(configFile, config); console.log('已创建实例配置，请在 Orange 配置渠道与角色。') }
  else if (command === 'restore') {
    const directory = path.resolve(option('--backup') || '')
    if (!option('--backup') || !fs.existsSync(path.join(directory, 'ai.db')) || !fs.existsSync(path.join(directory, 'config.json'))) throw new Error('备份目录不完整')
    const { Storage } = await import('./src/core/storage.mjs'); const dbFile = path.join(root, 'data/ai.db'), storage = new Storage(dbFile)
    const safeguard = path.join(root, 'backups', 'before-restore-' + Date.now()); fs.mkdirSync(safeguard, { recursive: true }); storage.backup(path.join(safeguard, 'ai.db')); writeJson(path.join(safeguard, 'config.json'), readConfig(configFile)); storage.close()
    for (const suffix of ['-wal', '-shm']) if (fs.existsSync(dbFile + suffix)) fs.unlinkSync(dbFile + suffix)
    fs.copyFileSync(path.join(directory, 'ai.db'), dbFile); writeJson(configFile, JSON.parse(fs.readFileSync(path.join(directory, 'config.json'), 'utf8'))); console.log('数据库和配置已恢复。请重启服务。')
  } else {
    const client = new AIClient({ root, configFile }); await client.loadExtensions()
    if (command === 'diagnose') { console.log(JSON.stringify(client.health(), null, 2)); client.close() }
    else if (command === 'chat') { const result = await client.chat({ userId: 'cli-owner', text: option('--text') || args.join(' '), presetId: option('--preset'), isMaster: true }); console.log(result.text); client.close() }
    else if (command === 'backup') { const target = path.join(root, 'backups', 'cli-' + Date.now()); client.storage.backup(path.join(target, 'ai.db')); writeJson(path.join(target, 'config.json'), client.config()); console.log('备份已创建：' + target); client.close() }
    else if (command === 'serve') { client.startMaintenance(); const config = client.config(); if (!config.management.apiToken) { config.management.apiToken = randomBytes(32).toString('hex'); writeJson(configFile, config) }; const management = startManagement(client); await management.ready; console.log('AI-Plugin 服务已启动。控制台主人登录入口：' + management.ticket()); for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await management.close(); client.close(); process.exit(0) }) }
    else { client.close(); throw new Error('未知命令，请使用 help') }
  }
} catch (error) { console.error('AI-Plugin：' + error.message); process.exitCode = 1 }
