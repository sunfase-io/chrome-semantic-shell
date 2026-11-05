import copy
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest
from unittest.mock import patch
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import json

spec = importlib.util.spec_from_file_location("jev_flow", Path(__file__).parents[1] / "scripts/jev_flow.py")
flow = importlib.util.module_from_spec(spec)
spec.loader.exec_module(flow)


def plan():
    return {
        "goal": "Read the policy", "acceptance": "policy visible", "allowed_origins": ["https://example.test"],
        "start": "first", "nodes": {"first": {
            "observe": "inspect interactive limit=10", "instructions": "Read the policy, do not purchase",
            "choices": {"policy": {"description": "Read policy", "requires": [{"role": "link", "name": "Policy"}],
                "guard": 'assert visible="#policy"', "program": 'query role=link name="Policy" | click',
                "verify": 'assert text="policy visible"', "next": "done"}},
        }},
    }


class FakeBrowser:
    def __init__(self):
        self.calls = 0
        self.elapsed_ms = self.runtime_ms = 0
        self.requests = []
        self.state = {"url": "https://example.test/start", "version": 1, "title": "Example",
                      "nodes": [{"role": "link", "name": "Policy", "ref": "ref_1", "value": "private-value", "states": {}}]}

    def run(self, program, **kwargs):
        self.calls += 1
        self.requests.append((program, kwargs))
        return {"ok": True, "state": copy.deepcopy(self.state)}


class FakeJev:
    def __init__(self, selected=True):
        self.selected = selected
        self.requests = []

    def request_decisions(self, payload, **kwargs):
        self.requests.append(payload)
        return {"model": "jev-latest", "answers": {}}

    def build_report(self, *args, **kwargs):
        return {"decisions": {"next": {"status": "selected" if self.selected else "needs_review", "value": "policy"}}}


class FlowTests(unittest.TestCase):
    def setUp(self):
        self.settings = flow.read_json(Path(__file__).parents[1] / "config.json")
        self.browser, self.jev = FakeBrowser(), FakeJev()
        self.api = SimpleNamespace(model="jev-latest")

    def test_one_decision_uses_only_initial_observation_and_fused_action(self):
        result = flow.execute(plan(), self.settings, self.browser, self.jev, self.api)
        self.assertEqual(result["status"], "verified")
        self.assertEqual(self.browser.calls, 2)
        self.assertEqual(len(self.jev.requests), 1)
        source, options = self.browser.requests[-1]
        self.assertIn('&& inspect interactive limit=1', source)
        self.assertEqual(options["expected_url"], "https://example.test/start")
        self.assertNotIn("private-value", str(self.jev.requests))

    def test_known_nodes_are_fused_without_model_calls(self):
        value = plan()
        first = value["nodes"]["first"]["choices"]["policy"]
        first["next"] = "second"
        value["nodes"] = {"first": first, "second": {**first, "next": "done"}}
        result = flow.execute(value, self.settings, self.browser, None, None)
        self.assertEqual(result["steps"], 2)
        self.assertEqual(self.browser.calls, 2)

    def test_ambiguous_candidates_do_not_reach_jev_or_execute(self):
        self.browser.state["nodes"].append(copy.deepcopy(self.browser.state["nodes"][0]))
        with self.assertRaises(flow.NeedsReview):
            flow.execute(plan(), self.settings, self.browser, self.jev, self.api)
        self.assertEqual(self.browser.calls, 1)
        self.assertEqual(self.jev.requests, [])

    def test_abstention_stops_before_action(self):
        with self.assertRaises(flow.NeedsReview):
            flow.execute(plan(), self.settings, self.browser, FakeJev(False), self.api)
        self.assertEqual(self.browser.calls, 1)

    def test_wrong_origin_stops_before_api_or_mutation(self):
        self.browser.state["url"] = "https://other.test/"
        with self.assertRaises(flow.FlowError):
            flow.execute(plan(), self.settings, self.browser, self.jev, self.api)
        self.assertEqual(self.jev.requests, [])

    def test_dependent_chain_rejects_unconditional_continuation(self):
        value = plan()
        value["nodes"]["first"]["choices"]["policy"]["program"] = 'click css="#first"; click css="#second"'
        with self.assertRaises(flow.FlowError):
            flow.validate(value)

    def test_loop_detected_even_if_refs_and_mutation_version_change(self):
        state = copy.deepcopy(self.browser.state)
        state["version"] += 1
        state["nodes"][0]["ref"] = "ref_999"
        self.assertEqual(flow.signature(state), flow.signature(self.browser.state))

    def test_model_evidence_omits_url_credentials_query_and_fragment(self):
        self.assertEqual(flow.evidence_url('https://user:secret@example.test/path?token=private#session'), 'https://example.test/path')
        self.assertEqual(flow.evidence_url('http://[::1]:1234/path?token=private'), 'http://[::1]:1234/path')


class TransportTests(unittest.TestCase):
    def test_persistent_transport_reuses_connection_and_does_not_retry_provider_errors(self):
        ports, requests = [], []

        class Handler(BaseHTTPRequestHandler):
            protocol_version = 'HTTP/1.1'

            def do_POST(self):
                ports.append(self.client_address[1])
                requests.append(json.loads(self.rfile.read(int(self.headers['Content-Length']))))
                status = 200 if len(requests) < 3 else 503
                raw = b'{"answers":{}}' if status == 200 else b'{"error":"fixture-secret"}'
                self.send_response(status)
                self.send_header('Content-Length', str(len(raw)))
                self.end_headers()
                self.wfile.write(raw)

            def log_message(self, *args):
                pass

        class Error(ValueError):
            def __init__(self, message, **kwargs):
                super().__init__(message)

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        module = SimpleNamespace(JevError=Error, number=lambda *args: None, validate_request=lambda value: value, load_json=json.loads)
        config = SimpleNamespace(api_url=f'http://127.0.0.1:{server.server_port}/v1/systemone', api_key='fixture-only')
        with patch.object(flow.urllib.request, 'getproxies', return_value={}):
            session = flow.JevSession(module, config)
        try:
            session.request_decisions({'model':'jev-latest'})
            session.request_decisions({'model':'jev-latest'})
            self.assertEqual(ports[0], ports[1])
            with self.assertRaisesRegex(Error, 'HTTP 503') as caught:
                session.request_decisions({'model':'jev-latest'})
            self.assertNotIn('fixture-secret', str(caught.exception))
            self.assertEqual(len(requests), 3)
        finally:
            session.close(); server.shutdown(); server.server_close()


if __name__ == "__main__":
    unittest.main()
