# Dashboard del informe diario en Home Assistant

## Qué hace

OpenClaw genera `homelab-health-daily` con Proxmox y logs de Home Assistant.
Un publicador consulta cada cinco minutos el historial existente mediante la CLI
y exporta la sesión de la última ejecución correcta para enviar su respuesta final
completa a Node-RED. No utiliza `summary`, que OpenClaw puede recortar. Node-RED actualiza un único sensor
y el dashboard muestra su texto y fecha. No se vuelve a ejecutar el modelo.
Se conserva la entrega en la web de OpenClaw; no se cambia a modo webhook.
Tampoco se modifica ni se borra el historial o la base de datos.

Direcciones de esta instalación: OpenClaw en `10.8.1.101`, Node-RED en
`10.8.1.28` y Home Assistant en `10.8.1.21`. El puerto de Node-RED se presupone
`1880`: cambia la URL si usas otro puerto, HTTPS o un prefijo HTTP.
El transporte HTTP del ejemplo es para la LAN; limita el endpoint al LXC
de OpenClaw en tu firewall. No publiques esta ruta en Internet.

El publicador no necesita una clave de Home Assistant: Node-RED reutiliza su
conexión existente. El observador mantiene sus permisos de lectura. El token
dedicado a publicación solo permite escribir el sensor del informe mediante este
flujo; no se acepta un nombre de entidad ni una acción desde la petición.

## 1. Preparar Node-RED y Home Assistant

Ya necesitas `node-red-contrib-home-assistant-websocket` conectado a HA.
Además, el nodo **Sensor** requiere **Node-RED Companion** dentro de Home Assistant:

1. Si no está instalado, busca `hass-node-red` en HACS e instálalo.
2. Reinicia Home Assistant cuando lo solicite.
3. En Ajustes → Dispositivos y servicios → Añadir integración, añade
   **Node-RED Companion** si todavía no figura.

No es necesario instalar un segundo servidor Node-RED en Home Assistant.

En el LXC de OpenClaw genera un token exclusivo de publicación:

```bash
openssl rand -hex 32
```

Copia ese valor a ambos extremos, sin enviarlo al chat ni subirlo a Git.

En Node-RED (`http://10.8.1.28:1880`):

1. Menú → Importar → selecciona `integrations/homeassistant/node-red-flow.json`.
2. Abre las propiedades de la pestaña **Informe homelab**, apartado variables
   de entorno, y añade `HOMELAB_REPORT_TOKEN` con el valor generado (tipo texto).
3. Abre **Actualizar informe en HA** y edita su Entity Config **Homelab informe**.
   Selecciona tu conexión existente a Home Assistant. Si el nodo Sensor también
   muestra un selector Server, selecciona la misma conexión.
4. Guarda y pulsa Deploy. Los nodos deben quedar sin errores de configuración.

El token queda en la configuración privada del flujo. No exportes ni publiques
esa versión con el secreto; el JSON del repositorio no contiene credenciales.
Opcionalmente puedes proporcionar la variable al servicio Node-RED en vez de
guardarla en las propiedades de la pestaña.

## 2. Configurar el publicador en el LXC de OpenClaw

Desde el repositorio actualizado:

```bash
cd /root/homelab-ai
git pull --ff-only
```

Guarda el mismo token en un archivo local protegido. Este bloque reemplaza solo
`/etc/homelab-report.env`; úsalo para la configuración inicial:

```bash
(
  umask 077
  read -rsp 'Token de publicación configurado en Node-RED: ' REPORT_TOKEN
  echo
  if [[ ! "$REPORT_TOKEN" =~ ^[a-fA-F0-9]{64}$ ]]; then
    echo 'Token no válido: se esperan 64 caracteres hexadecimales' >&2
    exit 1
  fi
  printf 'HOMELAB_REPORT_TOKEN=%s\n' "$REPORT_TOKEN" > /etc/homelab-report.env
  printf '%s\n' \
    'HOMELAB_REPORT_URL=http://10.8.1.28:1880/homelab/report' \
    'HOMELAB_REPORT_JOB_ID=c2c20bac-2f48-4605-b64a-5f7dfd40c743' \
    >> /etc/homelab-report.env
  chmod 600 /etc/homelab-report.env
)
```

Si recreaste la automatización, cambia `HOMELAB_REPORT_JOB_ID` aquí y añade la
misma variable en la pestaña Node-RED. El flujo rechaza IDs distintos.

Prueba una publicación manual:

```bash
bash scripts/05-publicar-informe-ha.sh
```

Debe devolver `published: true`. En Home Assistant, busca el sensor **Homelab
informe** y comprueba que su ID sea `sensor.homelab_informe`. Si HA le asigna
otro ID, renómbralo desde sus ajustes o sustituye todas las referencias del YAML.
El estado del sensor es la fecha; el texto está en el atributo `report`.

El mensaje HTTP de éxito se devuelve después de que el nodo Sensor complete la
actualización. Comprueba también en HA que los atributos y las cifras coincidan
con el informe completo de la web de OpenClaw. La primera publicación utiliza el informe existente más
reciente; no genera uno nuevo ni elimina secciones antiguas de su texto.

## 3. Crear el dashboard

En Home Assistant crea un dashboard vacío desde Ajustes → Paneles. Abre su
editor de configuración sin procesar y pega `integrations/homeassistant/dashboard.yaml`.
Úsalo en un panel nuevo: no reemplaces el YAML de tu panel habitual.

El panel utiliza únicamente tarjetas Markdown nativas. Muestra el texto completo
de la respuesta final exportada, sin interpretar su contenido como instrucciones.
Incluye un aviso si el informe tiene más de 30 horas o la última ejecución fue
`error`/`skipped`. Una ejecución correcta significa que el informe se generó,
no que el homelab carezca de incidencias: lee el diagnóstico.

## 4. Activar publicación automática

Solo después de comprobar la publicación manual y el panel. Estos servicios
presuponen que el repositorio está en `/root/homelab-ai`; ajusta el archivo
`.service` si usas otra ruta.

```bash
install -m 644 integrations/homeassistant/homelab-report-publisher.service /etc/systemd/system/
install -m 644 integrations/homeassistant/homelab-report-publisher.timer /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now homelab-report-publisher.timer
systemctl start homelab-report-publisher.service
systemctl list-timers homelab-report-publisher.timer
```

El informe nuevo aparecerá en el siguiente ciclo, en unos cinco minutos como
máximo más el tiempo de consulta. Las publicaciones repetidas conservan la fecha
original y reponen el sensor después de reiniciar Node-RED. No hay llamadas
adicionales al modelo. El temporizador no altera la hora del informe diario.

## Diagnóstico y límites

```bash
journalctl -u homelab-report-publisher.service -n 30 --no-pager
```

- HTTP 401: el token no coincide. HTTP 503: falta el token en Node-RED o falla
  el nodo de Home Assistant; comprueba Companion y la conexión del Sensor.
- HTTP 404: comprueba puerto, prefijo HTTP, ruta y que el flujo esté desplegado.
- Sin ejecución correcta en las últimas 20 entradas o sin una respuesta final
  identificable en su sesión exportada: no se sobrescribe el
  sensor. Se conserva el informe anterior y su fecha permite detectar antigüedad.
- Informe superior a 32 KiB: se rechaza, no se trunca. Ajusta la concisión del
  informe si ocurre. El límite se aplica a la respuesta completa, no al resumen.
- El estado de la última ejecución se calcula dentro de las últimas 20 entradas.
  Si la CLI cambia el formato JSON, el publicador falla y deja el informe previo.
- Los logs del publicador no imprimen el informe ni el token. No conectes un
  nodo Debug de mensaje completo a la entrada HTTP, que recibe la cabecera secreta.
- El texto del informe se guarda como atributo y puede quedar registrado por
  Recorder según tu configuración. No se añaden métricas numéricas inventadas
  ni se intenta extraerlas con expresiones regulares del texto del modelo.
- El script 04 no instala este panel. Ahora limita el observador a Proxmox y
  `homeassistant__ha_get_logs`; si la tarea ya existe, conserva su mensaje,
  horario y entrega.

Para detener solo la publicación a HA:

```bash
systemctl disable --now homelab-report-publisher.timer
```

Después puedes deshabilitar la pestaña importada en Node-RED. La automatización
original y la entrega en OpenClaw permanecen operativas.


## Actualizar el publicador que enviaba informes recortados

En OpenClaw 2026.9.4, `automations runs` puede devolver un `summary` que termina
con puntos suspensivos antes de las secciones finales. El nuevo publicador:

- Busca la sesión del agente `homelab-observer` por el `sessionId` de la ejecución.
  Usa su clave real aunque el historial devuelva una clave con sufijo `:run:…`.
- Exporta la sesión mediante `sessions export-trajectory --json`.
- Selecciona el último evento `assistant.message` con `stopReason: stop`,
  de esa sesión y dentro del intervalo entre `runAtMs` y `ts`.
- Envía solo sus bloques de texto, con la redacción que aplique el exportador.
  No publica razonamiento, resultados de herramientas ni eventos internos.
- Borra su exportación temporal al terminar, también si falla. No toca otras
  exportaciones ni las bases de datos. Si no puede identificar el informe, falla
  y conserva el sensor anterior; nunca usa el resumen recortado como alternativa.

Para actualizar una instalación existente:

```bash
cd /root/homelab-ai
git pull --ff-only
bash scripts/05-publicar-informe-ha.sh
```

La salida debe incluir `published: true`, `report_source: "trajectory"` y
`report_chars`. Comprueba que el panel incluye Home Assistant y las recomendaciones.
No necesitas regenerar el informe, reiniciar OpenClaw, reimportar Node-RED ni
cambiar el YAML. El temporizador utiliza automáticamente el código actualizado.
La fecha del informe se conserva aunque ahora se publique el contenido completo.

La exportación necesita espacio temporal dentro del contenedor. Un archivo de
eventos superior a 32 MiB se rechaza. Si el identificador de la ejecución ya no
está entre las sesiones guardadas, no se usa una conversación distinta.

## Validación

Pruebas locales con historial ficticio y receptor HTTP local:

```bash
node --test integrations/homeassistant/report-publisher.test.mjs
```

Verifican selección del último informe, cifras y saltos de línea, autenticación,
límites, rechazo de IDs ajenos, errores HTTP y confirmación de publicación.
También cubren resumen truncado, texto completo con logs HA, resolución de sesión,
exclusión de otras ejecuciones y limpieza de las exportaciones temporales.
No sustituyen la prueba real de importación con tu versión de Node-RED, Companion
y Home Assistant; esa validación queda pendiente del despliegue.

Referencias: [nodo Sensor](https://zachowj.github.io/node-red-contrib-home-assistant-websocket/node/sensor.html),
[Node-RED Companion](https://github.com/zachowj/hass-node-red),
[variables de Node-RED](https://nodered.org/docs/user-guide/environment-variables),
[tarjeta Markdown](https://www.home-assistant.io/dashboards/markdown),
[historial de OpenClaw](https://docs.openclaw.ai/cli/cron).
