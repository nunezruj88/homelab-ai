# Estado general del informe

Cuatro entidades derivan del atributo report de sensor.homelab_informe:
- `sensor.informe_proxmox_estado`
- `sensor.informe_homeassistant_estado`
- `sensor.informe_truenas_estado`
- `sensor.informe_homelab_estado`

Sus valores son ok, warning, critical y unknown. Incluyen motivo, recomendacion,
cobertura, fuente, procedencia, estado_del_informe, vigencia, generated_at,
report_id y last_run_status. El estado pasa a unknown si la fuente no está
disponible, la fecha es inválida/futura, el informe supera 30 horas o la última
ejecución fue error/skipped. El motivo y estado_del_informe conservan la información
histórica y deben leerse junto a vigencia. No es monitorización en tiempo real.

## Cómo se calcula

El modelo transcribe los datos consultados en un bloque `homelab-evidence-v2` de líneas clave=valor, sin JSON.
El publicador valida tipos y aplica reglas fijas; no interpreta adjetivos del texto
ni acepta un color elegido por el modelo. La transcripción sigue dependiendo del
modelo: no es una verificación independiente contra las API. source identifica
la consulta y cobertura declaradas. Datos ausentes, formato inválido, duplicado o
cobertura incompleta nunca producen ok. Una incidencia confirmada conserva su
gravedad aunque la cobertura sea parcial.

| Sistema | critical | warning |
| --- | --- | --- |
| Proxmox | Algún nodo offline | Backups fallidos; almacenamiento >80%; CPU/RAM >90% |
| Home Assistant | Indisponibilidad confirmada | Errores o warnings en la cobertura consultada |
| TrueNAS | Pool no saludable/no ONLINE o alerta crítica no descartada | Pool >80% o alertas WARNING/ERROR no descartadas |

Un pool ONLINE con healthy=false da critical aunque su alerta esté descartada.
Una VM detenida no demuestra un fallo. Un error de permisos no prueba caída de HA.
Los conteos de logs parciales no se extrapolan a las últimas 24 horas.
El global da critical antes que warning; solo es ok cuando los tres sistemas
son ok. Su cobertura indica si falta información de alguno.
Estas reglas cubren únicamente las comprobaciones declaradas; no verifican SMART,
restaurabilidad de backups ni salud absoluta de cada integración.

La sección `## Estado general` va al final, después de TrueNAS.
En la web de OpenClaw se ve la tabla orientativa del modelo y sus datos estructurados.
Para Home Assistant, el publicador sustituye esa sección por la tabla calculada
y un bloque técnico oculto que leen las plantillas. Por eso puede corregir el
estado que aparecía en la respuesta del modelo.
Los informes antiguos se siguen publicando, pero sus sensores de estado muestran
unknown hasta generar uno con la nueva estructura. No se vuelve a llamar al modelo
por cada publicación horaria.

## 1. Actualizar y generar un informe

En el LXC de OpenClaw:

```bash
cd /root/homelab-ai
git pull --ff-only

docker exec openclaw openclaw automations edit c2c20bac-2f48-4605-b64a-5f7dfd40c743 \
  --message "$(cat config/automations/homelab-health-daily.txt)"

docker exec openclaw openclaw automations run c2c20bac-2f48-4605-b64a-5f7dfd40c743 --wait
bash scripts/05-publicar-informe-ha.sh
```

El comando edit conserva horario, entrega y herramientas. En otra instalación,
sustituye el ID por el de tu informe. El script 04 no actualiza el mensaje de una
tarea que ya existe.

## 2. Instalar los sensores en Home Assistant

Copia `integrations/homeassistant/status-sensors.yaml` del repositorio a
`/config/homelab-status-sensors.yaml` en Home Assistant.

Si no existe una sección template en configuration.yaml:

```yaml
template: !include homelab-status-sensors.yaml
```

Si ya utilizas `template: !include templates.yaml`, añade el contenido de
status-sensors.yaml como otra entrada de esa lista. No lo pongas bajo `sensor:`: son sensores de plantilla.
Si utilizas una carpeta con `!include_dir_merge_list`, coloca el archivo allí
junto a las plantillas existentes. No dupliques la clave template.

Comprueba la configuración y recarga las entidades de plantilla.
Los sensores resumen existentes conservan sus nombres y delimitadores.

## 3. Instalar las tarjetas

En el editor de una tarjeta manual pega el contenido de
`integrations/homeassistant/status-cards.yaml`. Es una tarjeta vertical con
cuatro tarjetas Markdown nativas, no un dashboard completo ni una integración HACS.

El flujo de Node-RED no cambia: solo publica sensor.homelab_informe y las cuatro
entidades nuevas se crean mediante las plantillas de Home Assistant.
Si una tarjeta completa de TrueNAS extrae hasta el final del informe, termina
esa extracción antes de `\n## Estado general` para no mezclar ambas secciones.

## Comprobaciones

- Los cuatro sensores aparecen tras recargar las plantillas.
- El informe nuevo incluye Estado general al final.
- Los datos ausentes se presentan como unknown, nunca como cero supuesto.
- generated_at conserva la fecha del informe aunque se publique varias veces.
- La fecha y vigencia son visibles en las tarjetas.
- Un fallo de extracción/publicación conserva el sensor anterior; la caducidad
  de 30 horas evita que siga mostrándose verde indefinidamente.

El publicador mantiene el límite de 32 KiB para el informe completo, incluida
la sección calculada; si se supera, falla sin truncar ni reemplazar el sensor.

## Informe sustituido por un marcador de redacción

La exportación de diagnóstico puede devolver `[Malformed diagnostic JSON redacted]`
aunque la web muestre el informe completo. Esto se comprobó en el homelab:
chat.history devolvió la misma sesión, con una copia anunciada y una respuesta
final completa con stopReason stop.

El publicador ahora lee chat.history mediante el Gateway, sin usar
sessions export-trajectory. Selecciona únicamente la respuesta final generada
dentro del intervalo de la ejecución. La CLI conserva la autenticación y los
controles de acceso del Gateway; no se desactiva la redacción ni se accede a SQLite.

Para recuperar un informe que ya se ve bien en la web:

```bash
cd /root/homelab-ai
git pull --ff-only
bash scripts/05-publicar-informe-ha.sh
```

No necesitas generar otra ejecución, reiniciar OpenClaw, cambiar las plantillas
ni reimportar Node-RED. El resultado debe mostrar published true y report_source
chat.history. Si el informe existente no contiene evidencia estructurada válida,
se publica su texto pero los estados correspondientes serán unknown.

Los marcadores Malformed/Oversized siguen rechazándose antes del POST. También
se rechazan respuestas truncadas, sesiones ajenas y candidatos ambiguos. Si la
consulta no devuelve el informe, se conserva el sensor y se comunica el error;
no se usa el resumen recortado ni una copia anunciada como sustituto.
La lectura real por esta vía se comprobó con el diagnóstico del homelab; la
publicación completa debe verificarse después de actualizar el script.

Referencia: [historial del Gateway](https://github.com/openclaw/openclaw/blob/main/src/gateway/server-methods/chat-history-handler.ts).
