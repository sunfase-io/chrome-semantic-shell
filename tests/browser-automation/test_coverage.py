import ast
import importlib.util
import json
from pathlib import Path
import unittest

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]


class CoverageTests(unittest.TestCase):
    def test_every_declared_live_case_has_an_executable_implementation(self):
        spec = importlib.util.spec_from_file_location('browser_live', HERE/'run_live.py')
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        coverage = json.loads((HERE/'coverage.json').read_text(encoding='utf-8'))
        cases = json.loads((HERE/'live-cases.json').read_text(encoding='utf-8'))
        ids = [c['id'] for c in cases]
        self.assertEqual(len(ids),len(set(ids)))
        declared = {cid for group in coverage['groups'] for cid in group['live']}
        self.assertEqual(declared,set(ids)|module.SPECIAL_CASES)
        for group in coverage['groups']:
            self.assertTrue((ROOT/group['offline']).is_file(),group['offline'])

    def test_test_entrypoints_have_valid_python_syntax(self):
        for file in HERE.glob('*.py'):
            ast.parse(file.read_text(encoding='utf-8'),filename=str(file))


if __name__ == '__main__':
    unittest.main()
