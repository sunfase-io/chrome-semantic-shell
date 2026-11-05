"""Summarize regression receipts without printing full DOM snapshots or image bytes."""
import argparse
from collections import Counter
import json
from pathlib import Path
from privacy import sanitize

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('report', type=Path)
parser.add_argument('--sanitize', action='store_true')
args = parser.parse_args()
data = sanitize(json.loads(args.report.read_text(encoding='utf-8')))
if args.sanitize:
    args.report.write_text(json.dumps(data, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
print(json.dumps({'counts': Counter(item['status'] for item in data['results'])}, ensure_ascii=False))
for item in data['results']:
    if item['status'] != 'failed':
        continue
    out = {key: item.get(key) for key in ('id', 'error')}
    receipt = item.get('receipt') or {}
    out['context'] = receipt.get('_meta', {}).get('chromeShellContext')
    out['steps'] = []
    out['images'] = []
    for part in receipt.get('content', []):
        if part.get('type') == 'image':
            out['images'].append({'mimeType': part.get('mimeType'), 'base64Length': len(part.get('data', ''))})
        if part.get('type') == 'text':
            try:
                value = json.loads(part['text'])
            except (ValueError, TypeError):
                out['steps'].append(part.get('text', '')[:1200])
            else:
                out['steps'].extend(value.get('steps', []) if isinstance(value, dict) else [value])
    print(json.dumps(out, ensure_ascii=False, indent=2))
