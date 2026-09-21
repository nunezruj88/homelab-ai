# Dashboard del informe diario en Home Assistant

## Qué hace

OpenClaw genera `homelab-health-daily` con Proxmox y logs de Home Assistant.
Un publicador consulta cada hora el historial existente mediante la CLI
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

El temporizador del repositorio hace un primer intento dos minutos después del
arranque del LXC (o al activarse si ese plazo ya pasó) y después publica cada hora
mediante `OnUnitActiveSec=1h`, no necesariamente a la hora en punto.
El informe nuevo aparecerá en el siguiente ciclo, aproximadamente en una hora
más el tiempo de consulta si el servicio está operativo. Las publicaciones repetidas conservan la fecha
original y reponen el sensor después de reiniciar Node-RED. No hay llamadas
adicionales al modelo. El temporizador no altera la hora del informe diario.

### Cambiar una instalación anterior a publicación cada hora

Actualizar el repositorio no sustituye las unidades ya copiadas a systemd.
En el LXC, actualiza el temporizador instalado y reinícialo:

```bash
cd /root/homelab-ai
git pull --ff-only
install -m 644 integrations/homeassistant/homelab-report-publisher.timer /etc/systemd/system/
systemctl daemon-reload
systemctl restart homelab-report-publisher.timer
systemctl list-timers --all homelab-report-publisher.timer
```

Si todavía no existen el servicio y el temporizador, sigue la instalación completa
del apartado anterior. La generación diaria de OpenClaw no instala estas unidades.

Un override tiene prioridad sobre el archivo del repositorio. Si conserva solo
`OnUnitActiveSec=1h` y elimina el disparo inicial, puede quedarse sin próxima
ejecución. Comprueba la configuración combinada con:

```bash
systemctl cat homelab-report-publisher.timer
```

Cada ciclo vuelve a enviar el último informe, aunque no haya uno nuevo. No genera
otro informe ni cambia su fecha. Para forzar una publicación inmediata:

```bash
cd /root/homelab-ai
bash scripts/05-publicar-informe-ha.sh
```

### El temporizador aparece con NEXT vacío y no publica

Si `list-timers` muestra `NEXT -`, el servicio está inactivo y no hay entradas
recientes en el registro, comprueba el temporizador antes de investigar Node-RED.
En el homelab se recuperó la publicación añadiendo un primer disparo explícito
y conservando la repetición cada hora.

Este bloque sustituye el override de programación de este publicador. Si contiene
otros ajustes propios, consérvalos antes de sustituirlo:

```bash
mkdir -p /etc/systemd/system/homelab-report-publisher.timer.d

cat > /etc/systemd/system/homelab-report-publisher.timer.d/override.conf <<'EOF'
[Timer]
OnCalendar=
OnBootSec=
OnActiveSec=
OnUnitActiveSec=
OnUnitInactiveSec=
OnActiveSec=1min
OnUnitActiveSec=1h
EOF

systemctl daemon-reload
systemctl enable homelab-report-publisher.timer
systemctl restart homelab-report-publisher.timer
systemctl start homelab-report-publisher.service

systemctl list-timers --all homelab-report-publisher.timer
journalctl -u homelab-report-publisher.service \
  --since "10 minutes ago" -n 60 --no-pager
```

`OnActiveSec=1min` programa un intento un minuto después de activar el temporizador;
`OnUnitActiveSec=1h` mantiene los intentos cada hora. El arranque manual del servicio
publica inmediatamente y puede ir seguido del intento inicial al minuto.
Verifica que aparece una fecha en `NEXT` y que el registro confirma el envío.
Un servicio de tipo oneshot puede volver a `inactive (dead)` después de terminar
correctamente: ese estado por sí solo no indica un fallo.

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

## Separar el informe por sistema

El mensaje versionado en `config/automations/homelab-health-daily.txt` exige
exactamente `## Proxmox`, `## Home Assistant`, `## TrueNAS` y `## Estado general`, sin emojis en esos encabezados.
La [integración TrueNAS](truenas-mcp.md) es opcional; sin ella se indica cobertura no disponible.
Las tarjetas de secciones completas deben terminar Home Assistant antes de `## TrueNAS`.
Cada sección contiene sus propias recomendaciones y subsecciones de nivel 3.
Si falta información, se conserva el encabezado y se explica la limitación.

El script 04 utiliza este archivo para tareas nuevas. Para aplicar el formato
a la automatización existente, ejecuta desde el repositorio:

```bash
git pull --ff-only
docker exec openclaw openclaw automations edit \
  c2c20bac-2f48-4605-b64a-5f7dfd40c743 \
  --message "$(cat config/automations/homelab-health-daily.txt)"
```

Solo se actualiza el mensaje; se conservan horario, permisos y entrega.
Sustituye el ID si recreaste la tarea. Los informes antiguos no se reformatean.
Para generar y publicar uno con las nuevas secciones:

```bash
docker exec openclaw openclaw automations run \
  c2c20bac-2f48-4605-b64a-5f7dfd40c743 --wait
bash scripts/05-publicar-informe-ha.sh
```

Comprueba que ambas cabeceras estén presentes en el atributo `report`. Este
contrato de formato permite a los sensores de plantilla separar el texto.
El modelo debe respetarlo; el publicador conserva su respuesta, no inventa
secciones ni clasifica contenido automáticamente.

## Sensores de resumen tabular

El resumen narrativo inicial se sustituye por tablas. El informe completo y los
sensores de secciones completos que hayas creado anteriormente pueden conservarse.
Estos dos sensores nuevos derivan sus atributos del mismo `sensor.homelab_informe`:

- `sensor.informe_proxmox_summary`: una tabla por nodo con CPU y RAM en porcentaje y
  recuentos independientes de VM y LXC por estado: running, stopped, paused y otros/desconocidos.
- `sensor.informe_homeassistant_summary`: dos tablas, errores y warnings. Cada una tiene
  una fila Total y hasta tres mensajes ordenados por apariciones. La fila Total
  identifica fuente, periodo y cobertura; N/D significa que el dato no se pudo verificar.

Las cifras reflejan la consulta del informe, no métricas en tiempo real. Una
muestra parcial de logs no es el total de las últimas 24 horas. El modelo recibe
instrucciones de no extrapolar conteos ni inventar un ranking sin frecuencias.
Las tablas son parte de su respuesta: estos sensores separan el texto, no
recalculan ni verifican los datos de origen.

### Instalar las entidades en Home Assistant

Copia el contenido de [summary-sensors.yaml](../integrations/homeassistant/summary-sensors.yaml)
a `/config/homelab-summary-sensors.yaml` **en Home Assistant**, no en el LXC de OpenClaw.

Si todavía no tienes una clave `template:`, añade al nivel principal de
`configuration.yaml`:

```yaml
template: !include homelab-summary-sensors.yaml
```

Si ya usas `template: !include templates.yaml`, añade el contenido del archivo al
final de esa lista existente, sin reemplazar otros sensores. Si tienes la lista
directamente dentro de `template:`, integra el bloque `- sensor:` con dos espacios
de sangría debajo de esa clave. No lo pegues bajo `sensor:` ni dupliques `template:`.
El archivo descargado ya empieza por `- sensor:`; no requiere `platform`.

Comprueba la configuración y recarga las entidades de plantilla. Verifica los
IDs de las entidades creadas; si hay una colisión de nombres, ajusta los IDs o las
referencias de las tarjetas. El estado es la fecha del informe; las tablas están
en el atributo `report`, evitando el límite de longitud del estado.

### Actualizar y publicar el informe

En el LXC de OpenClaw:

```bash
cd /root/homelab-ai
git pull --ff-only
docker exec openclaw openclaw automations edit \
  c2c20bac-2f48-4605-b64a-5f7dfd40c743 \
  --message "$(cat config/automations/homelab-health-daily.txt)"
docker exec openclaw openclaw automations run \
  c2c20bac-2f48-4605-b64a-5f7dfd40c743 --wait
bash scripts/05-publicar-informe-ha.sh
```

Hasta que se publique un informe nuevo con los encabezados esperados, los sensores
figurarán como no disponibles. Los informes antiguos no se reformatean.
No hace falta reimportar el flujo Node-RED. Si el publicador falla (por ejemplo,
HTTP 503), resuelve ese fallo primero: las tablas no pueden actualizarse sin
recibir el informe nuevo.

### Tarjetas

Añade una tarjeta Manual y pega
[summary-cards.yaml](../integrations/homeassistant/summary-cards.yaml).
Es una tarjeta vertical con las dos entidades, no un dashboard completo.
Puedes usar también cada tarjeta Markdown por separado. La tabla Proxmox tiene
muchas columnas; reserva una zona ancha del panel.

Referencia: [entidades de plantilla de Home Assistant](https://www.home-assistant.io/integrations/template/).

### Renombrar sensores ya instalados

Se conservan los unique_id para evitar duplicados. Después de actualizar el YAML
y recargar las plantillas, Home Assistant puede conservar los entity_id anteriores.
En los ajustes de cada entidad cambia `sensor.proxmox_summary` a
`sensor.informe_proxmox_summary` y `sensor.homeassistant_summary` a
`sensor.informe_homeassistant_summary`. Actualiza también las tarjetas con
`summary-cards.yaml`. No borres las entidades ni cambies sus unique_id.

Para las tarjetas rápidas de salud, consulta [Estado general](estado-general.md).
Una tarjeta que extraiga la sección completa de TrueNAS debe terminar antes de
`## Estado general`; los sensores de tablas existentes conservan sus delimitadores.
