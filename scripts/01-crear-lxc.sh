#!/bin/bash
# Ejecutar en el HOST Proxmox (no dentro de ningún LXC/VM).
# Ajusta las variables antes de ejecutar.
set -euo pipefail

CTID=200
HOSTNAME="ia-stack"
IP="10.8.1.101/24"
GW="10.8.1.1"
BRIDGE="vmbr0"
CORES=4
MEMORY=8192
SWAP=512
DISK_GB=32
STORAGE="local-lvm"
TEMPLATE_STORAGE="local"

echo ">> Actualizando lista de templates..."
pveam update

TEMPLATE=$(pveam available | grep debian-12 | awk '{print $2}' | sort -V | tail -1)
if [ -z "$TEMPLATE" ]; then
  echo "No se encontró ningún template de Debian 12. Revisa 'pveam available' manualmente."
  exit 1
fi
echo ">> Usando template: $TEMPLATE"

if [ ! -f "/var/lib/vz/template/cache/${TEMPLATE}" ]; then
  pveam download "$TEMPLATE_STORAGE" "$TEMPLATE"
fi

echo ">> Creando LXC $CTID..."
pct create "$CTID" "${TEMPLATE_STORAGE}:vztmpl/${TEMPLATE}" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$MEMORY" --swap "$SWAP" \
  --net0 "name=eth0,bridge=${BRIDGE},ip=${IP},gw=${GW}" \
  --rootfs "${STORAGE}:${DISK_GB}" \
  --unprivileged 0 \
  --features nesting=1,keyctl=1 \
  --onboot 1

pct start "$CTID"

echo ">> LXC $CTID creado y arrancado. Verificando red..."
sleep 5
pct exec "$CTID" -- ip a show eth0
pct exec "$CTID" -- ping -c 3 "${GW}"

echo ">> Listo. Entra con: pct enter $CTID"
