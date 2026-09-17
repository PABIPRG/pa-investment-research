import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from adapter.store import JsonStore
from adapter.evolution_history import history, HistoryCursorConflict


class HistoryTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.store = JsonStore(Path(self.temp.name))
        for key in ['a', 'b', 'c']:
            self.store.set('evolution_previews', key, {
                'preview_status': 'applied', 'applied_at': '2026-09-09 15:36:00',
                'actions': [{'type': 'promote', 'sid': f'{key}-{i}'} for i in range(4)],
            })
        self.store.set('evolution_previews', 'draft', {'preview_status': 'pending', 'actions': [{'sid': 'hidden'}]})

    def test_pages_split_large_round_without_duplicates_and_reuse_index(self):
        first = history(self.store, limit=3)
        rows = list(first['items'])
        cursor = first['next_cursor']
        with patch.object(self.store, 'all', side_effect=AssertionError('pages must reuse index')):
            while cursor:
                page = history(self.store, limit=3, cursor=cursor)
                rows.extend(page['items'])
                cursor = page['next_cursor']
        self.assertEqual(len(rows), 12)
        self.assertEqual(len({row['action_id'] for row in rows}), 12)
        self.assertEqual(rows[0]['round_id'], 'c')

    def test_changed_history_requires_explicit_restart(self):
        cursor = history(self.store, limit=3)['next_cursor']
        self.store.set('evolution_previews', 'new', {'preview_status': 'applied', 'actions': [{'sid': 'new'}]})
        with self.assertRaises(HistoryCursorConflict):
            history(self.store, cursor=cursor)

    def test_cursor_validation_and_bounds(self):
        for cursor in ['nonsense', 'e30=']:
            with self.assertRaises(ValueError):
                history(self.store, cursor=cursor)
        with self.assertRaises(ValueError):
            history(self.store, limit=51)
        self.assertEqual(history(self.store, limit=50)['next_cursor'], None)

    def test_http_contract_validation_and_conflict(self):
        from fastapi.testclient import TestClient
        from adapter.app import create_app
        with patch('adapter.evolution_history.JsonStore', return_value=self.store):
            client = TestClient(create_app())
            response = client.get('/evolution/history', params={'limit': 2})
            self.assertEqual(response.status_code, 200)
            cursor = response.json()['next_cursor']
            self.assertEqual(client.get('/evolution/history', params={'limit': 51}).status_code, 422)
            self.assertEqual(client.get('/evolution/history', params={'cursor': 'bad'}).status_code, 400)
            self.store.set('evolution_previews', 'changed', {})
            self.assertEqual(client.get('/evolution/history', params={'cursor': cursor}).status_code, 409)

    def test_status_can_omit_legacy_history_without_rescanning(self):
        from adapter.evolution import status
        with patch('adapter.evolution._recent_applied', side_effect=AssertionError('legacy history disabled')):
            result = status(self.store, include_history=False)
        self.assertEqual(result['recent_applied'], [])
        self.assertEqual(result['last_applied_at'], '2026-09-09 15:36:00')
