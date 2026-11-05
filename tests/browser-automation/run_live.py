#!/usr/bin/env python3
"""Run independently verified browser contracts on synthetic localhost pages. Never reload the extension."""
import argparse
import base64
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import re
import tempfile
import threading
import time
import uuid
from privacy import sanitize

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
spec = importlib.util.spec_from_file_location('flow', ROOT/'skills/chrome-shell/scripts/jev_flow.py')
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)
SPECIAL_CASES = {'navigation', 'tabs', 'wrong-tab', 'stale-page', 'download', 'browser-dialog', 'learn-replay', 'jev-flow',
                 'navigate-error', 'fail-fast-file'}


class Handler(BaseHTTPRequestHandler):
    saved = None
    requests = []
    download_name = 'chrome-shell-test-download.txt'

    def do_GET(self):
        Handler.requests.append(self.path)
        if self.path == '/api/data':
            data, kind = b'{"ok":true,"count":2}', 'application/json'
        elif self.path == '/api/text':
            data, kind = b'plain api answer', 'text/plain; charset=utf-8'
        elif self.path == '/download':
            data, kind = b'chrome-shell synthetic download', 'text/plain'
        else:
            data, kind = (HERE/'fixture.html').read_bytes(), 'text/html; charset=utf-8'
        self.send_response(200)
        self.send_header('Content-Type', kind)
        self.send_header('Content-Length', str(len(data)))
        if self.path == '/download':
            self.send_header('Content-Disposition', f'attachment; filename="{self.download_name}"')
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        Handler.requests.append(self.path)
        Handler.saved = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        self.send_response(200)
        self.send_header('Content-Length', '2')
        self.end_headers()
        self.wfile.write(b'{}')

    def log_message(self, *args):
        pass


def probe(browser, expression):
    # Oracle is a new read, independent of the command's success flag.
    receipt = browser.run('js code=$oracle', variables={'oracle': f'return Boolean({expression})'})
    payload = json.loads(receipt['steps'][-1]['detail'])
    value = payload.get('result')
    if isinstance(value, str):
        value = json.loads(value)
    if payload.get('success') is not True or value is not True:
        raise AssertionError(f'ORACLE_FAILED: {expression}')


def expect_failure(browser, program, **kwargs):
    try:
        browser.run(program, **kwargs)
    except flow.FlowError:
        return
    raise AssertionError('Expected failure but program succeeded')


def run_special(case, browser, origin, workspace, endpoint, all_cases):
    tab = browser.defaults['tabId']
    if case == 'navigation':
        browser.run(f'navigate {origin}/second && wait navigation timeout=3000 && wait selector="#save" timeout=3000')
        probe(browser, "location.pathname === '/second'")
        browser.run('query role=link name="Next page" | click && wait navigation timeout=3000')
        probe(browser, "location.pathname === '/third'")
        browser.run('back && wait navigation timeout=3000')
        probe(browser, "location.pathname === '/second'")
        browser.run('forward && wait navigation timeout=3000 && reload && wait navigation timeout=3000')
        probe(browser, "location.pathname === '/third'")
    elif case == 'tabs':
        child = browser.run(f'tab new {origin}/child')['tabId']
        try:
            browser.run(f'tab list && tab switch {tab}')
            probe(browser, "location.pathname === '/'")
        finally:
            browser.run(f'tab close {child}')
    elif case == 'wrong-tab':
        other = flow.Chrome(2147483000, workspace, 3000, endpoint)
        try:
            expect_failure(other, 'assert text="Regression fixture"')
        finally:
            other.close()
        probe(browser, 'window.count === 0')
    elif case == 'stale-page':
        expect_failure(browser, 'click css="#counter"', expected_url=origin+'/different')
        probe(browser, 'window.count === 0')
    elif case == 'download':
        result = browser.run('query role=link name="Download fixture" | click && download timeout=5000')
        if not any(Handler.download_name in (s.get('detail') or '') for s in result['steps']):
            raise AssertionError('Download receipt does not identify the owned fixture file')
    elif case == 'browser-dialog':
        browser.run(f'tab switch {tab}')
        opener = flow.Chrome(tab, workspace, 5000, endpoint)
        try:
            with ThreadPoolExecutor(max_workers=1) as pool:
                pending = pool.submit(opener.run, 'js code=$code', variables={'code': "window.confirmed=confirm('fixture confirmation'); return true"})
                deadline = time.monotonic()+3
                while True:
                    if pending.done():
                        try: pending.result()
                        except Exception as error: raise AssertionError('Dialog opener failed: '+json.dumps(getattr(opener,'last_response',{}))) from error
                        state = opener.run('js code=$code', variables={'code': "return {confirmed:window.confirmed,visible:document.visibilityState,focus:document.hasFocus(),confirmType:typeof window.confirm}"})
                        raise AssertionError('Dialog opener finished without a visible dialog: '+state['steps'][-1]['detail'])
                    try:
                        browser.run('dialog accept')
                        break
                    except flow.FlowError:
                        message = json.dumps(getattr(browser, 'last_response', {})).lower()
                        if time.monotonic() >= deadline or not re.search(r'no (?:javascript )?dialog|dialog.*not.*open|not.*showing', message):
                            raise
                        time.sleep(.03)
                pending.result(timeout=6)
            probe(browser, 'window.confirmed === true')
        finally:
            opener.close()
    elif case == 'learn-replay':
        source = 'fillform Name=$name && query role=button name="Save" | click && wait text="Save complete" timeout=3000 && assert text="Save complete"'
        for value in ('learning-alpha', 'learning-beta'):
            browser.run(source, variables={'name': value})
        browser.connection.request('POST', browser.request_path, json.dumps({'script': 'learn status', 'workspace': workspace}), {'Content-Type': 'application/json'})
        response = browser.connection.getresponse()
        envelope = json.loads(response.read())
        status = json.loads(envelope['content'][0]['text'])
        active = [item for item in status['operations'] if item['state']=='active']
        assert active, status
        # Find the learned recipe containing only Name input, not another case's tool.
        manifest = next(json.loads(p.read_text(encoding='utf-8')) for p in (Path(workspace)/'.webmcp/learned').glob('*.tool.json')
                        if 'field Name' in p.read_text(encoding='utf-8') and len(json.loads(p.read_text(encoding='utf-8'))['inputSchema']['required']) == 1)
        browser.run(f'call {manifest["name"]} input={{"arg1":"learning-gamma"}}')
        assert Handler.saved['name'] == 'learning-gamma'
    elif case == 'navigate-error':
        # Port 1 is blocked by Chrome (ERR_UNSAFE_PORT): an instant, proxy-independent error page.
        expect_failure(browser, 'navigate http://127.0.0.1:1/')
        browser.run(f'navigate {origin}/ && wait selector="#save" timeout=3000')
        probe(browser, "location.pathname === '/'")
    elif case == 'fail-fast-file':
        browser.defaults['failFast'] = True
        try:
            expect_failure(browser, 'fill css="#name" value="first"\nassert exists="#absent"\nfill css="#name" value="second"')
        finally:
            browser.defaults.pop('failFast', None)
        probe(browser, "document.querySelector('#name').value === 'first'")
    elif case == 'jev-flow':
        spec = importlib.util.spec_from_file_location('bench', ROOT/'skills/chrome-shell/evals/live_benchmark.py')
        bench = importlib.util.module_from_spec(spec); spec.loader.exec_module(bench)
        # Reuse the labelled two-decision fixture on this owned tab.
        browser.run('js code=$code', variables={'code': 'document.open();document.write('+json.dumps(bench.PAGE)+');document.close();return true'})
        settings = flow.read_json(ROOT/'skills/chrome-shell/config.json')
        jev = flow.load_jev(settings['jev']['skill_script'])
        api = jev.load_config(settings['jev']['config_file'])
        jev = flow.make_jev(jev, api, settings)
        try:
            result = flow.execute(bench.policy_plan(origin), settings, browser, jev, api)
        finally:
            if isinstance(jev, flow.JevSession): jev.close()
        assert result['status']=='verified'
        probe(browser, "!!document.querySelector('#policy') && window.wrongClicks === 0")
    else:
        raise AssertionError(f'Unimplemented case: {case}')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--out', type=Path, required=True)
    parser.add_argument('--endpoint', default='http://127.0.0.1:12306/chrome/shell')
    parser.add_argument('--cases', help='Comma-separated case IDs; default all non-external cases')
    parser.add_argument('--jev', action='store_true', help='Include paid real Jev case using shared configuration')
    parser.add_argument('--downloads', action='store_true', help='Include owned fixture download to browser download directory')
    args = parser.parse_args()
    cases = json.loads((HERE/'live-cases.json').read_text(encoding='utf-8'))
    by_id = {case['id']: case for case in cases}
    declared = {cid for group in json.loads((HERE/'coverage.json').read_text(encoding='utf-8'))['groups'] for cid in group['live']}
    assert declared == set(by_id) | SPECIAL_CASES, 'Coverage table and executable cases disagree'
    selected = args.cases.split(',') if args.cases else [*by_id, *sorted(SPECIAL_CASES)]
    assert set(selected) <= declared, 'Unknown case ID'
    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    Handler.download_name = f'chrome-shell-test-{uuid.uuid4().hex[:8]}.txt'
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f'http://127.0.0.1:{server.server_port}'
    results = []
    with tempfile.TemporaryDirectory(prefix='chrome-suite-', dir=Path(tempfile.gettempdir())/'opencode') as workspace:
        tools = Path(workspace)/'.webmcp'; tools.mkdir()
        (tools/'read.js').write_text('// tool: fixture_read\n// readonly: true\nreturn {count:window.count};', encoding='utf-8')
        (tools/'write.js').write_text('// tool: fixture_write\ndocument.querySelector("#name").value=ARGS.value;return true;', encoding='utf-8')
        (tools/'slow.js').write_text('// tool: fixture_slow\n// readonly: true\nawait new Promise((resolve) => setTimeout(resolve, 2000));\nreturn 1;', encoding='utf-8')
        upload = Path(workspace)/'fixture-upload.txt'; upload.write_text('fixture upload', encoding='utf-8')
        for cid in selected:
            if (cid=='jev-flow' and not args.jev) or (cid=='download' and not args.downloads):
                results.append({'id':cid,'status':'skipped','reason':'requires explicit live API/download test flag'}); continue
            browser = flow.Chrome(None, workspace, 8000, args.endpoint)
            tab = None
            start = time.perf_counter()
            Handler.saved = None; Handler.requests = []
            try:
                browser.run('tab list')  # Read-only protocol handshake before allocating a tab.
                tab = browser.run(f'tab new {origin}/')['tabId']
                browser.defaults['tabId'] = tab
                browser.run('wait selector="#save" timeout=3000')
                if cid in SPECIAL_CASES:
                    run_special(cid, browser, origin, workspace, args.endpoint, by_id)
                else:
                    case = by_id[cid]
                    if case.get('setup'): browser.run(case['setup'])
                    program = case['program']
                    if case.get('refs'):
                        state = browser.run('inspect interactive limit=100')['state']
                        for key, target in case['refs'].items():
                            nodes = [n for n in state['nodes'] if all(n.get(k)==v for k,v in target.items())]
                            assert len(nodes)==1, f'ambiguous fixture ref {key}'
                            assert re.fullmatch(r'ref_\d+', nodes[0]['ref'])
                            program = program.replace('{{'+key+'}}', '@'+nodes[0]['ref'])
                    if case.get('setupAfterRefs'): browser.run(case['setupAfterRefs'])
                    values = {**case.get('vars',{}), 'file':str(upload)}
                    if case.get('expectError'):
                        expect_failure(browser, program, variables=values)
                        receipt = None
                    else:
                        receipt = browser.run(program, variables=values)
                    if case.get('image'):
                        images = [c for c in browser.last_response['content'] if c.get('type')=='image']
                        assert images, 'Screenshot returned no image'
                        data = base64.b64decode(images[0]['data'])
                        assert (images[0]['mimeType'] == 'image/png' and data.startswith(b'\x89PNG')) or (images[0]['mimeType'] == 'image/jpeg' and data.startswith(b'\xff\xd8')), 'Image MIME/signature mismatch'
                    if case.get('outputContains'): assert case['outputContains'] in json.dumps(receipt, ensure_ascii=False), 'expected output missing'
                    if case.get('outputExcludes'):
                        assert case['outputExcludes'] not in ''.join(c.get('text', '') for c in browser.last_response['content']).replace(case['program'], ''), 'secret leaked into output'
                    if case.get('artifact'):
                        artifact = Path(workspace)/case['artifact']
                        assert artifact.is_file()
                        if cid == 'capture-publish':
                            manifest = json.loads(artifact.read_text(encoding='utf-8'))
                            assert manifest['kind'] == 'http-sequence'
                            request = manifest['requests'][0]
                            assert request['method'] == 'POST' and request['url'] == origin+'/save'
                            assert request['body']['name'] == '{{name}}'
                            assert request['body']['email'] == 'capture@example.test'
                    if case.get('saved'): assert Handler.saved == case['saved']
                    if case.get('requestPath'): assert case['requestPath'] in Handler.requests
                    if case.get('oracle'):
                        probe(browser, case['oracle'])
                    else:
                        assert case.get('saved') and case.get('artifact'), 'A case needs an independent oracle'
                result = {'id':cid,'status':'passed','duration_ms':round((time.perf_counter()-start)*1000,1)}
            except Exception as error:
                result = {'id':cid,'status':'failed','error':str(error),'receipt':getattr(browser,'last_response',None) if tab is not None else None}
            finally:
                if tab is not None:
                    try: browser.run(f'tab close {tab}')
                    except Exception as error: results.append({'id':cid+':cleanup','status':'failed','error':str(error)})
                browser.close()
            results.append(result)
            print(json.dumps({k:v for k,v in result.items() if k!='receipt'}, ensure_ascii=False), flush=True)
        server.shutdown()
    args.out.write_text(json.dumps(sanitize({'fixture':'synthetic localhost','results':results}),ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    raise SystemExit(1 if any(r['status']=='failed' for r in results) else 0)


if __name__ == '__main__':
    main()
