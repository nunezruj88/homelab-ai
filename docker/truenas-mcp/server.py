"""Bounded read-only TrueNAS MCP for the daily homelab report."""
import copy
from datetime import datetime, timezone
import os
from pathlib import Path
import threading
import time
from urllib.parse import urlsplit

from mcp.server.fastmcp import FastMCP
from mcp.server.transport_security import TransportSecuritySettings
from mcp.types import ToolAnnotations
from starlette.responses import JSONResponse
from truenas_api_client import Client

mcp = FastMCP(
    "TrueNAS read-only", host="0.0.0.0", port=8000,
    stateless_http=True, json_response=True,
    transport_security=TransportSecuritySettings(
        enable_dns_rebinding_protection=True,
        allowed_hosts=["truenas-mcp:8000", "localhost:*", "127.0.0.1:*"],
        allowed_origins=[],
    ),
)
_lock = threading.Lock()
_cached = None
_cached_at = 0.0


def settings():
    uri = os.environ.get("TRUENAS_URL", "")
    parsed = urlsplit(uri)
    if (parsed.scheme != "wss" or not parsed.hostname or parsed.username
            or parsed.password or parsed.path != "/api/current"
            or parsed.query or parsed.fragment):
        raise ValueError("TRUENAS_URL debe ser wss://HOST/api/current")
    raw = os.environ.get("TRUENAS_VERIFY_SSL", "true").lower()
    if raw not in ("true", "false"):
        raise ValueError("TRUENAS_VERIFY_SSL debe ser true o false")
    ca = Path("/run/secrets/ca.pem")
    if ca.is_file():
        os.environ["SSL_CERT_FILE"] = str(ca)
    key = Path("/run/secrets/api.key").read_text().strip()
    if not key:
        raise ValueError("Falta la clave TrueNAS")
    return uri, raw == "true", key


def project_pool(pool):
    fields = ("name", "status", "healthy", "warning", "size", "allocated", "free")
    result = {k: pool.get(k) for k in fields}
    size, used = result["size"], result["allocated"]
    result["used_percent"] = (
        round(100 * used / size, 2)
        if type(size) in (int, float) and type(used) in (int, float)
        and size > 0 and 0 <= used <= size else None
    )
    return result


def collect_health(factory=Client):
    uri, verify, key = settings()
    result = {
        "collected_at": datetime.now(timezone.utc).isoformat(),
        "tls_verified": verify,
        "pools": None, "alerts": None, "query_errors": {},
        "limits": [
            "Estado actual, no histórico de 24 horas.",
            "Alertas: solo clase, gravedad y dismissed; sin texto libre ni argumentos.",
            "Sin comprobación directa SMART, snapshots, scrubs o replicaciones.",
        ],
    }
    try:
        with factory(uri=uri, verify_ssl=verify, call_timeout=20) as client:
            if client.call("auth.login_with_api_key", key) is not True:
                raise RuntimeError("Autenticación TrueNAS rechazada")
            for field, method, transform in (
                ("pools", "pool.query", project_pool),
                ("alerts", "alert.list", lambda a: {
                    k: a.get(k) for k in ("klass", "level", "dismissed")
                }),
            ):
                try:
                    rows = client.call(method)
                    if not isinstance(rows, list):
                        raise ValueError("Unexpected result")
                    result[field] = [transform(row) for row in rows[:200]]
                    result[field + "_total"] = len(rows)
                    result[field + "_truncated"] = len(rows) > 200
                except Exception:
                    # Exceptions and free-text alerts can contain sensitive upstream data.
                    result["query_errors"][field] = "Consulta no disponible; revisar permisos y conectividad."
    except Exception:
        raise RuntimeError("No se pudo conectar o autenticar con TrueNAS; revisar WSS, certificado y clave.") from None
    return result


@mcp.tool(annotations=ToolAnnotations(
    readOnlyHint=True, destructiveHint=False, idempotentHint=True, openWorldHint=True,
))
def get_health() -> dict:
    """Consulta pools, capacidad y clases de alertas de TrueNAS. Solo lectura; caché de 60 s."""
    global _cached, _cached_at
    with _lock:
        if _cached is None or time.monotonic() - _cached_at >= 60:
            _cached = collect_health()
            _cached_at = time.monotonic()
        return copy.deepcopy(_cached)


@mcp.custom_route("/healthz", methods=["GET"])
async def healthz(request):
    # Liveness only: no TrueNAS login every healthcheck.
    return JSONResponse({"status": "ok", "upstream_checked": False})


if __name__ == "__main__":
    mcp.run(transport="streamable-http")
