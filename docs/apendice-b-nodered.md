# Apéndice B — Notas sobre `node-red-contrib-mcp-server`

Paquete usado: [`node-red-contrib-mcp-server`](https://flows.nodered.org/node/node-red-contrib-mcp-server) (comunidad, mantenedor único, ~129 descargas/semana — funciona bien pero sin mucho respaldo si algo falla).

## Instalación

En el host/LXC donde corre Node-RED (no en el LXC del stack de IA):

```bash
cd ~/.node-red
npm install node-red-contrib-mcp-server
```

Reinicia Node-RED tras instalar.

## ⚠️ El paquete trae 5 nodos con propósitos muy distintos

Fácil de confundir porque todos comparten el prefijo `mcp-`:

| Nodo | Para qué sirve |
|---|---|
| `mcp-server` | Arranca/controla un **proceso MCP externo ya existente** (script Python, tipo Omnispindle). Pide un `Server Path` a un script. **No sirve para exponer flows como tools.** |
| `mcp-client` | Conecta Node-RED como cliente a un servidor MCP de terceros |
| `mcp-tool` | Invoca una tool concreta de un MCP ya conectado |
| **`mcp-flow-server`** | **El que necesitas** — construye un servidor MCP a partir de tus propios flows |
| `mcp-tool-registry` | Registra qué flow se expone como tool (nombre, descripción, parámetros) |

Si arrastras `mcp-server` al canvas pensando que es el servidor general, verás un campo obligatorio `Server Path` (ruta a un script Python) que no tiene sentido para este caso de uso — señal de que es el nodo equivocado.

## Configuración de `mcp-flow-server`

- **Server Port**: el puerto donde escuchará (comprobar disponibilidad con el botón integrado)
- **Auto Start**: actívalo, si no el servidor no arranca solo al desplegar
- **Enable CORS**: útil si vas a probarlo también desde un cliente web

Conecta un nodo `mcp-tool-registry` por cada acción que quieras exponer. La **descripción** de cada tool es lo único que el modelo lee para decidir cuándo usarla — evita dejar el valor genérico por defecto (`"Tool: mi_tool"`), sé específico (`"Enciende la luz de la cocina"`, no `"Controla dispositivo"`).

## Endpoints reales expuestos por `mcp-flow-server`

| Endpoint | Método | Para qué |
|---|---|---|
| `/mcp` | **POST** (JSON-RPC 2.0) | Endpoint principal del protocolo — **no responde a GET**, un `curl` simple sin `-X POST` da 404 aunque el servidor esté sano |
| `/health` | GET | Estado del servidor — el más rápido para un smoke test |
| `/sse` | GET | Streaming de eventos en tiempo real |
| `/mcp-flow-servers` | GET | Admin: lista los flow servers activos — **vive en el puerto de Node-RED (1880), no en el puerto del flow server** |

⚠️ Existe también un endpoint `/mcp-servers` (sin "flow") documentado en la página general del paquete — ese es para los nodos `mcp-server` (procesos externos), no para `mcp-flow-server`. Consultarlo da `{"servers":[]}` aunque tu `mcp-flow-server` esté funcionando perfectamente, lo cual genera confusión si no se sabe la diferencia.

## Verificación correcta

```bash
curl -s http://<ip-nodered>:<puerto>/health
# {"status":"healthy","server":"node-red-mcp-server","uptime":...,"tools":N}

curl -s -X POST http://<ip-nodered>:<puerto>/mcp \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
# debe listar tus tools registradas vía mcp-tool-registry
```

## Registro en OpenClaw

Igual que cualquier MCP remoto por HTTP (mismo patrón que Home Assistant):

```bash
docker exec -it openclaw sh -c '
openclaw mcp add nodered \
  --url=http://<ip-nodered>:<puerto>/mcp \
  --transport=streamable-http
'
docker exec -it openclaw sh -c "openclaw mcp doctor nodered --probe"
```
