# Imagen OpenClaw + cliente Docker.
# Necesaria porque el MCP de Proxmox (akmalovaa/proxmox-mcp) es stdio-only:
# OpenClaw lo lanza como subproceso vía `docker run`, y la imagen oficial
# de OpenClaw no trae el cliente `docker` instalado.

FROM openclaw/openclaw:latest
USER root
RUN apt-get update && \
    apt-get install -y --no-install-recommends docker.io && \
    rm -rf /var/lib/apt/lists/*
USER node
