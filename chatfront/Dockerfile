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
EXPOSE 3000
# USER y HASH vienen del entorno (Coolify env vars, no el repo):
#   CHAT_USER  (ej: matiastx85)
#   CHAT_PASS_HASH (bcrypt; Caddy solo acepta bcrypt en basicauth)
CMD ["caddy", "run", "--config", "/etc/caddy/Caddyfile"]
