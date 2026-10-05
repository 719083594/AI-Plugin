#!/usr/bin/env python3
"""Orange 主人入口：从实例文件读取认证信息，向已运行AI服务申请短期入口。"""
import argparse,json,urllib.request
from pathlib import Path
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--config',default=str(Path(__file__).resolve().parents[1]/'config/local.json'))
parser.add_argument('--endpoint',default='')
args=parser.parse_args();config=json.loads(Path(args.config).read_text(encoding='utf-8-sig'))
management=config['management'];endpoint=args.endpoint or 'http://127.0.0.1:'+str(management['port'])
request=urllib.request.Request(endpoint.rstrip('/')+'/api/ai-plugin/ticket',data=b'{}',method='POST',headers={'Content-Type':'application/json','Authorization':'Bearer '+management['apiToken']})
with urllib.request.urlopen(request,timeout=10) as response:result=json.load(response)
print(result['url'])
