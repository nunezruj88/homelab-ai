FROM node:24-bookworm-slim
WORKDIR /app
COPY --chown=node:node server.mjs ./server.mjs
USER node
CMD ["node", "server.mjs"]
