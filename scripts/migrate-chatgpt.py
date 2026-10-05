#!/usr/bin/env python3
"""离线迁移 ChatGPT-Plugin v3 的本地配置、会话和历史。先停旧服务。
所有配置与提示词只写入目标实例私有文件；标准输出仅输出计数。
"""
import argparse, json, sqlite3, secrets, shutil, time
from pathlib import Path

def read_json(path, default=None):
    return json.loads(path.read_text(encoding='utf-8-sig')) if path.exists() else default
def decode(value, default=None):
    if isinstance(value, str):
        try: return json.loads(value)
        except (ValueError, TypeError): return default
    return value if value is not None else default
def write_json(path, value):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    temporary.chmod(0o600); temporary.replace(path)
def connect(path):
    connection = sqlite3.connect('file:' + path.as_posix() + '?mode=ro', uri=True)
    connection.row_factory = sqlite3.Row
    return connection
def content(message, role=None):
    value = dict(message)
    converted = []
    for part in message.get('content', []):
        item = dict(part)
        if item.get('type') == 'image':
            image = item.get('image') or item.get('url') or item.get('data')
            item['mime'] = item.get('mime') or item.get('mimeType') or 'image/jpeg'
            if isinstance(image, str) and image.startswith(('http://', 'https://')):
                item['url'] = image; item.pop('data', None)
            elif image:
                item['data'] = image[9:] if isinstance(image, str) and image.startswith('base64://') else image
                if isinstance(image, str) and image.startswith('data:image/'):
                    item['mime'] = image[5:].split(';', 1)[0]
        converted.append(item)
    value['content'] = converted
    value['toolCalls'] = []
    for call in message.get('toolCalls', []):
        function = call.get('function') or {}
        arguments = call.get('arguments', call.get('params', function.get('arguments', {})))
        normalized = decode(arguments, arguments) if isinstance(arguments, str) else arguments
        value['toolCalls'].append(dict(call, name=call.get('name') or function.get('name'), arguments=normalized))
    if (role or message.get('role')) == 'tool':
        results = []
        for part in message.get('content', []):
            if part.get('type') != 'tool': continue
            result = part.get('content', '')
            text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False)
            results.append({'toolCallId': part.get('toolCallId') or part.get('tool_call_id'),
                            'name': part.get('name'), 'content': [{'type': 'text', 'text': text}]})
        if results:
            value['toolResults'] = results
            value['toolCallId'] = results[0]['toolCallId']; value['name'] = results[0]['name']
            value['content'] = results[0]['content']
    return value

def table_rows(connection, table):
    if not connection.execute('SELECT 1 FROM sqlite_master WHERE type=? AND name=?', ('table', table)).fetchone(): return []
    return [dict(row) for row in connection.execute('SELECT * FROM ' + table)]
def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', required=True); parser.add_argument('--target', required=True); parser.add_argument('--backup', required=True); parser.add_argument('--bot-id', default=''); parser.add_argument('--management-port', type=int, default=48371); parser.add_argument('--public-url', default='http://127.0.0.1:48371'); parser.add_argument('--docker', action='store_true')
    args = parser.parse_args(); source = Path(args.source).resolve(); target = Path(args.target).resolve(); backup = Path(args.backup).resolve()
    if source == target or source in target.parents or target in source.parents: raise ValueError('源与目标目录必须独立')
    if any(backup == path or backup in path.parents or path in backup.parents for path in (source, target)): raise ValueError('备份目录必须在源与目标目录之外，且不能包含它们')
    if not source.is_dir() or not (source / 'data/data.db').is_file(): raise ValueError('源插件缺少 data/data.db')
    if backup.exists(): raise ValueError('备份目录已存在，请使用新的目录')
    if (target / 'config/local.json').exists() or (target / 'data/ai.db').exists(): raise ValueError('目标已存在私有配置或数据库，拒绝覆盖')
    config = read_json(target / 'config/example.json'); assert config, '目标插件缺少 config/example.json'
    backup.mkdir(parents=True, mode=0o700)
    old_data = source / 'data'; legacy = read_json(old_data / 'config.json', {})
    for filename in ['data.db', 'history.db', 'memory.db', 'operation_logs.db']:
        if (old_data / filename).exists():
            with connect(old_data / filename) as original, sqlite3.connect(backup / filename) as copied: original.backup(copied)
    for filename in ['config.json','storage.json','tool-image-assets.json','history.json']:
        if (old_data / filename).exists(): shutil.copy2(old_data / filename, backup / filename)
    for folder in ['images', 'vector_index', 'skills']:
        if (old_data / folder).exists(): shutil.copytree(old_data / folder, backup / folder)
    channels = []; presets = []; states = []
    with connect(backup / 'data.db') as old:
        for raw in old.execute('SELECT * FROM channels'):
            row = dict(raw); options = decode(row.get('options'), {}); models = decode(row.get('models'), [])
            keys = options.get('apiKey', options.get('apiKeys', ''))
            allkeys = keys if isinstance(keys, list) else [keys] if keys else []
            channels.append({'id': row['id'], 'name': row['name'], 'type': {'OpenAI':'openai','Gemini':'gemini','Claude':'claude'}.get(row['adapterType'], row['adapterType'].lower()), 'baseUrl': options.get('baseUrl',''), 'apiKey': allkeys[0] if allkeys else '', 'apiKeys': allkeys, 'enabled': row.get('status') != 'disabled', 'models': models, 'priority': row.get('priority') or 0, 'weight': row.get('weight') or 1})
        for raw in old.execute('SELECT * FROM chat_presets'):
            row = dict(raw); options = decode(row.get('sendMessageOption'), {})
            name = row['name']; aliases = ['星','开拓者','开拓者星','开拓者·星'] if row['id'] == 'default_local' else ['流萤'] if row['id'] == 'firefly_local' else []
            presets.append({'id': row['id'], 'name': name, 'aliases': aliases, 'prefix': row.get('prefix') or '', 'model': options.get('model',''), 'channelId': options.get('channelId',''), 'systemPrompt': options.get('systemOverride') or options.get('systemPrompt') or '', 'temperature': options.get('temperature',0.7), 'maxTokens': options.get('maxTokens',options.get('maxToken',options.get('max_tokens',2048))), 'historyLength': legacy.get('llm',{}).get('historyLength',20), 'tools': ['web_search','ask_about_image','look_at_image','resolve_image_ref','GetQQAvatar'], 'showReasoning': options.get('enableReasoning',False) and legacy.get('bym',{}).get('sendReasoning',False), 'stream': False, 'enabled': True})
        states = [dict(row) for row in old.execute('SELECT * FROM user_states')]
    config['channels'] = channels; config['presets'] = presets
    basic = legacy.get('basic', {}); llm = legacy.get('llm', {}); bym = legacy.get('bym', {}); management = legacy.get('management', {}); vision = legacy.get('vision', {})
    config['basic'].update(defaultPresetId=llm.get('defaultChatPresetId',presets[0]['id']), triggerMode=basic.get('toggleMode','at'), triggerPrefix=basic.get('togglePrefix','#chat'), debug=basic.get('debug',False))
    config['chat'].update(enableRoleSwitch=True, userRoleWhitelist=llm.get('customPresetUserWhiteList',[]), userRoleBlacklist=llm.get('customPresetUserBlackList',[]))
    config['group'].update(enableContext=llm.get('enableGroupContext',True), contextLength=llm.get('groupContextLength',20), contextImages=vision.get('enableGroupContextImages',True), proactiveEnabled=bym.get('enable',False), probability=bym.get('probability',0.03), keywords=bym.get('hit',[]), defaultPresetId=bym.get('defaultPreset',''), prompt=bym.get('contextualPrompt') or config['group']['prompt'], maxTokens=bym.get('maxTokens',256))
    config['memory'].update(userEnabled=legacy.get('memory',{}).get('user',{}).get('enable',False), groupEnabled=legacy.get('memory',{}).get('group',{}).get('enable',False))
    config['security'].update(userWhitelist=management.get('whiteUsers',[]),userBlacklist=management.get('blackUsers',[]),groupWhitelist=management.get('whiteGroups',[]),groupBlacklist=management.get('blackGroups',[]),inputBlockedWords=llm.get('promptBlockWords',[]),outputBlockedWords=llm.get('responseBlockWords',[]),blockStrategy=llm.get('blockStrategy','full'),replacement=llm.get('blockWordMask','***'),maxRequestsPerWindow=management.get('defaultRateLimit',6))
    config['media'].update(maxImageBytes=vision.get('maxImageSize',10485760),visionChannelId=vision.get('visionChannelId',''),visionModel=vision.get('imageDescriptionModel',''),imageRetentionHours=0 if vision.get('imageRetentionPreset')=='forever' else vision.get('imageRetentionCustomHours',24))
    config['retention'].update(historyDays=llm.get('historyRetentionDays',30),proactiveHistoryDays=bym.get('historyRetentionDays',30),logLimit=legacy.get('chaite',{}).get('operationLogLimit',5000))
    config['management'].update(host='0.0.0.0' if args.docker else '127.0.0.1',port=args.management_port,publicUrl=args.public_url,apiToken=secrets.token_hex(32))
    search = target.parent / 'WebSearch-Plugin'
    if (search / 'api.mjs').exists(): config['tools'].update(searchModule='../WebSearch-Plugin/api.mjs',searchConfigFile='../WebSearch-Plugin/config/plugin.json')
    elif (search / 'config/plugin.json').exists():
        oldsearch=read_json(search/'config/plugin.json',{}); config['tools'].update(searchEndpoint=oldsearch.get('endpoint','').rstrip('/')+'/search',searchToken=oldsearch.get('secret',''))
    write_json(target/'config/local.json',config)
    (target/'data').mkdir(exist_ok=True, mode=0o700); db=sqlite3.connect(target/'data/ai.db')
    db.executescript('CREATE TABLE IF NOT EXISTS user_states(id TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS history(id TEXT PRIMARY KEY,parentId TEXT,conversationId TEXT NOT NULL,role TEXT NOT NULL,messageData TEXT NOT NULL,createdAt TEXT NOT NULL); CREATE TABLE IF NOT EXISTS legacy(key TEXT PRIMARY KEY,data TEXT NOT NULL); CREATE TABLE IF NOT EXISTS memories(id TEXT PRIMARY KEY,scope TEXT NOT NULL,ownerId TEXT NOT NULL,text TEXT NOT NULL,createdAt TEXT NOT NULL);')
    for row in states:
        userid=str(row['userId']); key=args.bot_id+':'+userid if args.bot_id else userid
        state={'id':key,'legacyId':row['id'],'nickname':row.get('nickname'),'settings':decode(row.get('settings'),{}),'current':decode(row.get('current'),{}),'conversations':decode(row.get('conversations'),[]),'revision':0}
        db.execute('INSERT OR REPLACE INTO user_states VALUES(?,?)',(key,json.dumps(state,ensure_ascii=False)))
    count=0
    if (backup/'history.db').exists():
        with connect(backup/'history.db') as old:
            for row in old.execute('SELECT * FROM history'):
                db.execute('INSERT OR REPLACE INTO history VALUES(?,?,?,?,?,?)',(row['id'],row['parentId'],row['conversationId'],row['role'],json.dumps(content(decode(row['messageData'],{}), row['role']),ensure_ascii=False),row['createdAt']));count+=1
    with connect(backup/'data.db') as old:
        for table in ['tools','tools_groups','processors','triggers','mcp_servers','group_context_cache']:
            rows=table_rows(old, table)
            db.execute('INSERT OR REPLACE INTO legacy VALUES(?,?)',(table,json.dumps(rows,ensure_ascii=False)))
    db.execute('INSERT OR REPLACE INTO legacy VALUES(?,?)',('original_config',json.dumps(legacy,ensure_ascii=False)))
    memorycount=0
    if (backup/'memory.db').exists():
        with connect(backup/'memory.db') as old:
            for table,scope,key,textkey in [('user_memory','user','user_id','value'),('group_facts','group','group_id','fact')]:
                for row in table_rows(old, table):
                    db.execute('INSERT OR REPLACE INTO memories VALUES(?,?,?,?,?)',(scope+':legacy:'+str(row['id']),scope,str(row[key]),str(row[textkey]),row['created_at']));memorycount+=1
    db.commit();db.close(); (target/'data/ai.db').chmod(0o600)
    write_json(target/'data/migration-report.json',{'source':'chatgpt-plugin v3','channels':len(channels),'presets':len(presets),'users':len(states),'history':count,'memories':memorycount,'legacyBackup':str(backup),'createdAt':time.strftime('%Y-%m-%dT%H:%M:%S')})
    print(json.dumps({'channels':len(channels),'presets':len(presets),'users':len(states),'history':count,'memories':memorycount,'backupCreated':True},ensure_ascii=False))
if __name__=='__main__': main()
