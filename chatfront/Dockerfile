# chatfront: build del SPA + Caddy con basic_auth y proxy /api → ollama
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /app/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 3000
# CHAT_USER y CHAT_PASS_HASH_B64 vienen del entorno (Coolify env vars).
ENTRYPOINT ["/entrypoint.sh"]
