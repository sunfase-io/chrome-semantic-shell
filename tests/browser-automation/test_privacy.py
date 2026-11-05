import json
import unittest
from privacy import sanitize


class PrivacyTests(unittest.TestCase):
    def test_unrelated_download_is_redacted_even_inside_nested_text_payloads(self):
        payload = {'content':[{'text':json.dumps({'steps':[{'detail':json.dumps({'download':{
            'id':1,'filename':'private-name','url':'https://other.test/file?token=fixture-secret','state':'complete'
        }})}]})}]}
        result = json.dumps(sanitize(payload))
        self.assertNotIn('fixture-secret', result)
        self.assertNotIn('private-name', result)
        self.assertIn('unrelated download', result)

    def test_owned_fixture_receipt_remains_verifiable(self):
        payload = {'download':{'id':2,'url':'http://127.0.0.1:1234/download','filename':'fixture.txt'}}
        self.assertEqual(sanitize(payload), payload)


if __name__ == '__main__':
    unittest.main()
