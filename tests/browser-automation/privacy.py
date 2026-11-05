"""Keep synthetic test receipts from retaining unrelated browser download history."""
import json
from urllib.parse import urlsplit


def sanitize(value):
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, dict):
        out = {key: sanitize(item) for key, item in value.items()}
        download = out.get('download')
        if isinstance(download, dict):
            host = urlsplit(download.get('url') or '').hostname
            if host not in {'127.0.0.1', 'localhost', '::1'}:
                out['download'] = {key: download[key] for key in ('id', 'state', 'startTime') if key in download}
                out['download']['redacted'] = 'unrelated download; not produced by localhost fixture'
        return out
    if isinstance(value, str) and value.lstrip().startswith(('{', '[')):
        try:
            return json.dumps(sanitize(json.loads(value)), ensure_ascii=False)
        except ValueError:
            pass
    return value
