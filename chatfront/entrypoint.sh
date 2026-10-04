#!/bin/sh
# Decodifica el hash bcrypt (enviado en base64 para no tener que escapar $ en
# docker-compose) y lo deja en /caddy/env para el Caddyfile.
CHAT_PASS_HASH=$(printf '%s' "$CHAT_PASS_HASH_B64" | base64 -d)
export CHAT_PASS_HASH=$CHAT_PASS_HASH
# Sustituimos el placeholder del Caddyfile
esc=$(printf '%s' "$CHAT_PASS_HASH" | sed 's/[$&/]/\\&/g')
sed -i "s/@CHAT_PASS_HASH@/$esc/" /etc/caddy/Caddyfile
# shellcheck disable=SC2039
sed -i "s/@CHAT_USER@/$CHAT_USER/" /etc/caddy/Caddyfile
exec caddy run --config /etc/caddy/Caddyfile
