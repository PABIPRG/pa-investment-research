# -*- coding: utf-8 -*-
"""种子数据 API 保持固定无输入路由，且不影响服务健康。"""

import importlib
import inspect
import unittest
from unittest import mock

from fastapi.testclient import TestClient


app_module = importlib.import_module("industry_chain.app")


class _Manager:
    def status(self):
        return {
            "status": "missing", "files_completed": 0, "files_total": 5,
            "downloaded_bytes": 0, "current_file": None, "error": None,
        }

    def bootstrap(self):
        return {
            "status": "ready", "files_completed": 5, "files_total": 5,
            "downloaded_bytes": 123, "current_file": None, "error": None,
        }


class DataRouteTests(unittest.TestCase):
    def test_routes_use_exact_methods_and_bootstrap_accepts_no_input(self):
        routes = {
            (route.path, method)
            for route in app_module.app.routes
            for method in getattr(route, "methods", set())
        }
        self.assertIn(("/data/status", "GET"), routes)
        self.assertIn(("/data/bootstrap", "POST"), routes)
        self.assertEqual(list(inspect.signature(app_module.data_bootstrap).parameters), [])

    def test_status_is_read_only_and_ready_bootstrap_invalidates_graph_cache(self):
        manager = _Manager()
        with mock.patch.object(app_module, "seed_data_manager", manager), mock.patch.object(
            app_module.graph, "invalidate",
        ) as invalidate:
            with TestClient(app_module.app) as client:
                status = client.get("/data/status")
                self.assertEqual(status.status_code, 200)
                self.assertEqual(status.json()["status"], "missing")
                invalidate.assert_not_called()

                bootstrap = client.post("/data/bootstrap")
                self.assertEqual(bootstrap.status_code, 200)
                self.assertEqual(bootstrap.json()["status"], "ready")
                invalidate.assert_called_once_with()

    def test_health_stays_green_independently_of_data_readiness(self):
        health = app_module.health()
        self.assertTrue(health["ok"])
        self.assertEqual(health["service"], "industry-chain")


if __name__ == "__main__":
    unittest.main()
