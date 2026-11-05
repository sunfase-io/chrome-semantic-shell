from datetime import datetime, timezone
import importlib.util
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
spec = importlib.util.spec_from_file_location('inventory', ROOT / 'docs/analysis/session_inventory.py')
inventory = importlib.util.module_from_spec(spec)
spec.loader.exec_module(inventory)


class InventoryTests(unittest.TestCase):
    def test_new_session_is_listed_without_content(self):
        result = inventory.differences({}, {'opencode:new': {'source': 'opencode', 'id': 'new', 'fingerprint': 'a'}})
        self.assertEqual(result['new'], [{'key': 'opencode:new', 'id': 'new'}])

    def test_existing_message_edit_uses_updated_part_watermark(self):
        old = {'opencode:x': {'source': 'opencode', 'id': 'x', 'fingerprint': 'a', 'part_updated_watermark_ms': 123}}
        new = {'opencode:x': {**old['opencode:x'], 'fingerprint': 'b'}}
        change = inventory.differences(old, new)['changed'][0]
        self.assertEqual(change['parts_updated_after_ms'], 123)
        self.assertTrue(change['include_updated_existing_parts'])
        self.assertTrue(change['watermark_inclusive'])

    def test_codex_append_and_rewrite_are_distinguished(self):
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir())/'opencode') as folder:
            path = Path(folder)/'rollout.jsonl'
            path.write_bytes(b'first\n')
            old = {'codex:x': {'source': 'codex', 'id': 'x', 'path': str(path), 'bytes': 6, 'fingerprint': inventory.file_digest(path)}}
            path.write_bytes(b'first\nsecond\n')
            new = {'codex:x': {**old['codex:x'], 'bytes': path.stat().st_size, 'fingerprint': inventory.file_digest(path)}}
            self.assertEqual(inventory.differences(old, new)['changed'][0]['append_from_byte'], 6)
            path.write_bytes(b'replaced\n')
            new['codex:x'].update(bytes=path.stat().st_size, fingerprint=inventory.file_digest(path))
            self.assertTrue(inventory.differences(old, new)['changed'][0]['rescan_required'])

    def test_incomplete_jsonl_tail_is_reanalysed_from_last_complete_line(self):
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir())/'opencode') as folder:
            path = Path(folder)/'rollout.jsonl'
            path.write_bytes(b'{}\n{"part":')
            old = {'codex:x': {'source': 'codex', 'id': 'x', 'path': str(path), 'bytes': path.stat().st_size, 'fingerprint': inventory.file_digest(path)}}
            path.write_bytes(b'{}\n{"part":1}\n')
            new = {'codex:x': {**old['codex:x'], 'bytes': path.stat().st_size, 'fingerprint': inventory.file_digest(path)}}
            self.assertEqual(inventory.differences(old,new)['changed'][0]['append_from_byte'],3)

    def opencode_home(self, folder):
        home = Path(folder)
        (home/'.local/share/opencode').mkdir(parents=True)
        db = sqlite3.connect(home/'.local/share/opencode/opencode.db')
        db.executescript('''
            CREATE TABLE session (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INT, time_updated INT);
            CREATE TABLE part (id TEXT, session_id TEXT, time_created INT, time_updated INT, data TEXT);
            CREATE TABLE session_v2 (id TEXT, title TEXT, directory TEXT, parent_id TEXT, time_created INT, time_updated INT);
            CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INT, time_created INT, time_updated INT, data TEXT);
        ''')
        db.execute("INSERT INTO session VALUES ('migrated','m','d',NULL,1,5)")
        db.execute("INSERT INTO session VALUES ('legacy','l','d',NULL,1,30)")
        db.execute("""INSERT INTO part VALUES ('p1','legacy',20,20,'{"type":"tool","tool":"bash","state":{"input":{"command":"chrome-shell tab list"}}}')""")
        db.execute("INSERT INTO session_v2 VALUES ('migrated','m','d',NULL,1,40)")
        tool = json.dumps({'content': [{'type': 'tool', 'name': 'shell', 'state': {'input': {'command': "chrome-shell 'inspect text'"}}}]})
        db.execute("INSERT INTO session_message VALUES ('a','migrated','assistant',1,3,3,'{}')")
        db.execute("INSERT INTO session_message VALUES ('b','migrated','assistant',2,40,40,?)", (tool,))
        db.commit()
        db.close()
        return home

    def test_v2_and_unmigrated_legacy_sessions_are_both_inventoried(self):
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir())/'opencode') as folder:
            home = self.opencode_home(folder)
            with inventory.readonly(home/'.local/share/opencode/opencode.db') as db:
                sessions = inventory.opencode_sessions(db)
            self.assertEqual({k: v['store'] for k, v in sessions.items()}, {'migrated': 'v2', 'legacy': 'legacy'})
            self.assertEqual(sessions['migrated']['message_created_watermark_ms'], 40)

    def test_store_migration_compares_message_creation_not_fingerprint(self):
        old = {'opencode:x': {'source': 'opencode', 'id': 'x', 'fingerprint': 'a', 'part_updated_watermark_ms': 10}}
        same = {'opencode:x': {'source': 'opencode', 'store': 'v2', 'id': 'x', 'fingerprint': 'b', 'message_created_watermark_ms': 9}}
        self.assertEqual(inventory.differences(old, same)['unchanged'], 1)
        grown = {'opencode:x': {**same['opencode:x'], 'message_created_watermark_ms': 11}}
        self.assertTrue(inventory.differences(old, grown)['changed'][0]['store_migrated'])

    def test_pending_lists_keyword_sessions_after_cutoff_in_both_stores(self):
        with tempfile.TemporaryDirectory(dir=Path(tempfile.gettempdir())/'opencode') as folder:
            home = self.opencode_home(folder)
            cutoff = datetime.fromtimestamp(0.010, timezone.utc).isoformat()
            baseline = {'coverage': {'opencode': {'analysis_cutoff_utc': cutoff}}, 'excluded_session_ids': []}
            found = {item['id']: item for item in inventory.pending(home, baseline, ['chrome-shell'], [])}
            self.assertEqual(set(found), {'migrated', 'legacy'})
            self.assertEqual(found['migrated']['tool_calls'], 1)
            self.assertEqual(inventory.pending(home, baseline, ['chrome-shell'], ['migrated', 'legacy']), [])

    def test_schema1_cutoff_applies_to_every_source(self):
        cut = inventory.coverage({'analysis_cutoff_utc': '2026-09-21T07:28:32+00:00'})
        self.assertEqual(set(cut), {'opencode', 'codex'})
        self.assertEqual(cut['opencode'], cut['codex'])


if __name__ == '__main__':
    unittest.main()
