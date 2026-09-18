import asyncio
import json
import unittest
from unittest.mock import patch
import httpx
import server

class FakeClient:
    calls = []
    fail_alerts = False
    def __init__(self, **kwargs):
        self.kwargs = kwargs
    def __enter__(self):
        return self
    def __exit__(self, *args):
        pass
    def call(self, method, *args):
        self.calls.append(method)
        if method == "auth.login_with_api_key":
            return True
        if method == "pool.query":
            return [{"name":"vault","status":"ONLINE","size":1000,"allocated":250,
                     "free":750,"secret":"never expose"}]
        if method == "alert.list":
            if self.fail_alerts:
                raise RuntimeError("secret upstream error")
            return [{"klass":"PoolSpace","level":"WARNING","dismissed":False,
                     "args":{"password":"secret"},"formatted":"secret"}]
        raise AssertionError("Unexpected method")

class UnitTests(unittest.TestCase):
    def test_projection_and_readonly_methods(self):
        FakeClient.calls = []
        FakeClient.fail_alerts = False
        with patch.object(server, "settings", return_value=("wss://nas/api/current",True,"secret")):
            result = server.collect_health(FakeClient)
        self.assertEqual(FakeClient.calls, ["auth.login_with_api_key","pool.query","alert.list"])
        self.assertEqual(result["pools"][0]["used_percent"],25)
        self.assertNotIn("secret", json.dumps(result))
        self.assertEqual(result["alerts_total"],1)

    def test_partial_failure_does_not_claim_no_alerts(self):
        FakeClient.fail_alerts = True
        with patch.object(server,"settings",return_value=("wss://nas/api/current",True,"key")):
            result = server.collect_health(FakeClient)
        FakeClient.fail_alerts = False
        self.assertIsNone(result["alerts"])
        self.assertIn("alerts",result["query_errors"])
        self.assertNotIn("secret",json.dumps(result))

    def test_missing_metrics_are_unknown(self):
        self.assertIsNone(server.project_pool({"name":"offline"})["used_percent"])

    def test_reject_plaintext_and_unexpected_url(self):
        for uri in ("ws://nas/api/current","https://nas/api/current","wss://user:pass@nas/api/current","wss://nas/other"):
            with patch.dict(server.os.environ,{"TRUENAS_URL":uri}):
                with self.assertRaises(ValueError):
                    server.settings()

class ProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_initialize_tools_and_host_protection(self):
        app = server.mcp.streamable_http_app()
        async with app.router.lifespan_context(app):
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                    base_url="http://truenas-mcp:8000") as client:
                headers={"Accept":"application/json, text/event-stream"}
                r = await client.post("/mcp",headers=headers,json={
                    "jsonrpc":"2.0","id":1,"method":"initialize","params":{
                        "protocolVersion":"2025-03-26","capabilities":{},
                        "clientInfo":{"name":"test","version":"1"}}})
                self.assertEqual(r.status_code,200,r.text)
                r = await client.post("/mcp",headers=headers,json={
                    "jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})
                self.assertEqual(r.status_code,200,r.text)
                tools = r.json()["result"]["tools"]
                self.assertEqual([t["name"] for t in tools],["get_health"])
                self.assertTrue(tools[0]["annotations"]["readOnlyHint"])
                with patch.object(server,"collect_health",return_value={"pools":[],"alerts":[]}):
                    server._cached = None
                    r = await client.post("/mcp",headers=headers,json={
                        "jsonrpc":"2.0","id":3,"method":"tools/call",
                        "params":{"name":"get_health","arguments":{}}})
                    self.assertEqual(r.status_code,200,r.text)
                    self.assertFalse(r.json()["result"].get("isError",False))
                r = await client.post("/mcp",headers={**headers,"Host":"evil.example"},
                    json={"jsonrpc":"2.0","id":4,"method":"tools/list"})
                self.assertGreaterEqual(r.status_code,400)

if __name__ == "__main__":
    unittest.main()
