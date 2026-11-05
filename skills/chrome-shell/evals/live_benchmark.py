#!/usr/bin/env python3
"""Synthetic localhost benchmark: CLI vs batch/HTTP, real Jev, and automatic learning."""
import argparse
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import statistics
import subprocess
import tempfile
import threading
import time

ROOT = Path(__file__).resolve().parents[3]
spec = importlib.util.spec_from_file_location("jev_flow", Path(__file__).parents[1] / "scripts/jev_flow.py")
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)

PAGE = r'''<!doctype html><meta charset="utf-8"><title>Automation benchmark</title>
<label>Name <input id="name"></label><label>Email <input id="email"></label>
<label>Category <select id="category"><option value="basic">Basic</option><option value="policy">Policy</option></select></label>
<button id="save" onclick="save()">Save</button><p id="status"></p><section id="view"></section>
<script>
window.wrongClicks=0;
view.innerHTML='<button id="help" onclick="help()">Help center</button><button id="orders" onclick="wrongClicks++;view.textContent=\'Order history ready\'">Order history</button>';
function help(){view.innerHTML='<h2>Help center ready</h2><button id="warranty" onclick="policy()">Warranty terms</button><button id="tracking" onclick="wrongClicks++;view.textContent=\'Shipment tracking ready\'">Shipment tracking</button>'}
function policy(){view.innerHTML='<h2 id="policy">Warranty policy ready</h2><p>Warranty lasts two years.</p>'}
async function save(){const data={name:document.getElementById('name').value,email:email.value,category:category.value};
const r=await fetch('/save',{method:'POST',body:JSON.stringify(data)});if(!r.ok)throw Error('save failed');
document.getElementById('status').textContent='Save complete';}
</script>'''


class Handler(BaseHTTPRequestHandler):
    saved = None

    def do_GET(self):
        data = PAGE.encode()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        Handler.saved = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
        self.send_response(200)
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):
        pass


class CliChrome:
    def __init__(self, tab, workspace, endpoint):
        self.tab, self.workspace, self.endpoint = tab, workspace, endpoint
        self.calls = self.elapsed_ms = self.runtime_ms = 0

    def run(self, program, expected_url=None, variables=None, **kwargs):
        command = ["node", str(ROOT / "app/native-server/dist/semantic-cli.js"), "--stdin", "--tab", str(self.tab),
                   "--workspace", self.workspace, "--endpoint", self.endpoint, "--output", "json", "--timeout", "10000"]
        if expected_url:
            command += ["--expected-url", expected_url]
        if variables:
            command += ["--vars-json", json.dumps(variables)]
        start = time.perf_counter()
        result = subprocess.run(command, input=program, text=True, encoding="utf-8", capture_output=True, timeout=20)
        self.elapsed_ms += (time.perf_counter() - start) * 1000
        self.calls += 1
        if result.returncode:
            raise AssertionError(f"Synthetic CLI failure: {result.stderr or result.stdout}")
        receipt = json.loads(result.stdout)
        assert receipt["ok"]
        self.runtime_ms += receipt.get("durationMs", 0)
        return receipt


def policy_plan(origin):
    def action(description, name, selector, success, next_node):
        return {"description": description, "requires": [{"role": "button", "name": name}],
                "guard": f'assert visible="{selector}"', "program": f'query role=button name="{name}" | click',
                "verify": f'assert text="{success}"', "next": next_node}
    return {"goal": "Read the warranty policy. Do not start a refund or track shipments.",
            "acceptance": "Warranty policy ready is visible, no refund/shipment action was taken.",
            "allowed_origins": [origin], "start": "support", "nodes": {
                "support": {"observe": "inspect interactive limit=20", "instructions": "Choose the entry for reading product support information.",
                            "choices": {"help": action("Open help information", "Help center", "#help", "Help center ready", "policy"),
                                        "orders": action("Read previous purchase history", "Order history", "#orders", "Order history ready", "done")}},
                "policy": {"observe": "inspect interactive limit=20", "instructions": "Choose the warranty rules page, not shipment tracking.",
                           "choices": {"warranty": action("Read warranty rules", "Warranty terms", "#warranty", "Warranty policy ready", "done"),
                                       "tracking": action("Read shipment tracking progress", "Shipment tracking", "#tracking", "Shipment tracking ready", "done")}},
            }}


def management(chrome, workspace, script):
    chrome.connection.request("POST", chrome.request_path, json.dumps({"workspace": workspace, "script": script}), {"Content-Type": "application/json"})
    response = chrome.connection.getresponse()
    assert response.status == 200
    envelope = json.loads(response.read())
    assert not envelope.get("isError"), envelope
    return json.loads(envelope["content"][0]["text"])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--endpoint", default="http://127.0.0.1:12306/chrome/shell")
    parser.add_argument("--repeats", type=int, default=3)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    origin = f"http://127.0.0.1:{server.server_port}"
    settings = flow.read_json(Path(__file__).parents[1] / "config.json")
    jev = flow.load_jev(settings["jev"]["skill_script"])
    api = jev.load_config(settings["jev"]["config_file"])
    jev = flow.make_jev(jev, api, settings)
    rows, decisions = [], []
    temporary_root = Path(tempfile.gettempdir()) / "opencode"
    with tempfile.TemporaryDirectory(prefix="chrome-live-", dir=temporary_root) as workspace:
        browser = flow.Chrome(None, workspace, 10000, args.endpoint)
        tab = None
        try:
            browser.run('tab list')
            tab = browser.run(f"tab new {origin}/")['tabId']
            browser.defaults["tabId"] = tab
            commands = ['fill role=textbox name="Name" value=$name', 'fill role=textbox name="Email" value=$email',
                        'select role=combobox name="Category" value="Policy"', 'query role=button name="Save" | click',
                        'wait text="Save complete" timeout=3000', 'assert text="Save complete"']
            for index in range(args.repeats):
                modes = ["cli_steps", "cli_batch", "http_batch"]
                if index % 2:
                    modes.reverse()
                for mode in modes:
                    browser.run(f"navigate {origin}/ && wait selector=\"#save\" timeout=3000")
                    values = {"name": f"sample-{index}-{mode}", "email": f"sample-{index}@example.test"}
                    driver = browser if mode == "http_batch" else CliChrome(tab, workspace, args.endpoint)
                    start_calls, start = driver.calls, time.perf_counter()
                    for program in commands if mode == "cli_steps" else [" && ".join(commands)]:
                        driver.run(program, variables=values)
                    elapsed = (time.perf_counter() - start) * 1000
                    assert Handler.saved == {**values, "category": "policy"}, Handler.saved
                    rows.append({"mode": mode, "run": index, "total_ms": round(elapsed, 1), "calls": driver.calls-start_calls, "verified": True})
                    print(json.dumps(rows[-1]), flush=True)

            # Ordinary commands above must have taught a callable tool without capture/publish instructions.
            status = management(browser, workspace, "learn status")
            active = [e for e in status["operations"] if e["state"] == "active"]
            assert active, status
            tool = active[0]
            manifest = json.loads((Path(workspace)/'.webmcp/learned'/f'{tool["name"]}.tool.json').read_text(encoding='utf-8'))
            inputs = {}
            for key, prop in manifest["inputSchema"]["properties"].items():
                description = prop["description"]
                inputs[key] = "learned-example" if "Name" in description else "learned@example.test" if "Email" in description else "Policy"
            browser.run(f"navigate {origin}/ && wait selector=\"#save\" timeout=3000")
            start = time.perf_counter()
            browser.run(f'call {tool["name"]} input=$input', variables={"input": inputs})
            assert Handler.saved == {"name": "learned-example", "email": "learned@example.test", "category": "policy"}
            learning = {"automatically_published": True, "replayed": True, "version": tool["version"], "replay_ms": round((time.perf_counter()-start)*1000, 1)}

            plan = policy_plan(origin)
            for index in range(args.repeats):
                modes = ["jev_cli", "jev_http"] if index % 2 == 0 else ["jev_http", "jev_cli"]
                for mode in modes:
                    browser.run(f"navigate {origin}/ && wait selector=\"#help\" timeout=3000")
                    driver = browser if mode == "jev_http" else CliChrome(tab, workspace, args.endpoint)
                    old_calls, old_ms, old_runtime = driver.calls, driver.elapsed_ms, driver.runtime_ms
                    events = []
                    receipt = flow.execute(copy.deepcopy(plan), settings, driver, jev, api, events.append)
                    oracle = browser.run('js code=$oracle', variables={"oracle": "return {policy:!!document.querySelector('#policy'),wrong:window.wrongClicks}"})
                    # The oracle comes from a fresh browser read after task timing ends.
                    detail = json.loads(oracle['steps'][0]['detail'])
                    actual = json.loads(detail['result']) if isinstance(detail['result'], str) else detail['result']
                    assert actual == {"policy": True, "wrong": 0}, actual
                    receipt.update(mode=mode, run=index, calls=receipt['browser_calls'], verified=True)
                    rows.append(receipt)
                    decisions.extend(e for e in events if e['event']=='decision')
                    print(json.dumps(receipt), flush=True)

            output = {"fixture": "synthetic localhost; setup/reset/oracle excluded equally", "rows": rows,
                      "learning": learning, "decisions": decisions,
                      "summary": {mode: {"runs": len(group), "median_ms": statistics.median(r['total_ms'] for r in group),
                                          "min_ms": min(r['total_ms'] for r in group), "max_ms": max(r['total_ms'] for r in group)}
                                  for mode in sorted({r['mode'] for r in rows}) if (group := [r for r in rows if r['mode']==mode])}}
            args.out.write_text(json.dumps(output, ensure_ascii=False, indent=2)+'\n', encoding='utf-8')
            print(json.dumps({"report": str(args.out), "summary": output["summary"], "learning": learning}), flush=True)
        except Exception:
            print(json.dumps({"synthetic_fixture_diagnostic": getattr(browser, 'last_response', None) if tab is not None else 'protocol/bootstrap failed'}, ensure_ascii=False), flush=True)
            raise
        finally:
            if tab is not None:
                browser.run(f"tab close {tab}")
            browser.close()
            if isinstance(jev, flow.JevSession): jev.close()
            server.shutdown()


if __name__ == "__main__":
    main()
