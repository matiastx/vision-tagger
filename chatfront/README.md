# ChatLocal

Chat web propio para usar el Ollama del VPS (`qwen2.5:3b-instruct` para texto, `qwen2.5vl:3b` con imágenes). Reemplaza a Open WebUI. Parte del plan `PLAN-TAGS-Y-GALERIA.md` (paso 1c).

## Stack

React 18 + Vite 5 + TypeScript + Tailwind 3.4 (tema Eva01-dark, mismas convenciones del backoffice). Sin backend: conversaciones y settings en `localStorage`.

## Features v1

- ⚙️ Configuración in-page: URL del servidor (default `https://ollama.mgtsolutions.uk`), token opcional (Service Token de Cloudflare Access), selector de modelo (cargado desde `GET /api/tags`).
- Chat con **streaming** NDJSON (`POST /api/chat`), con botón Detener.
- Conversaciones múltiples: crear / renombrar / eliminar.
- Adjuntar imagen 📎 (para modelos de visión).

## Dev

```bash
npm install
npm run dev
```

## Deploy (Coolify)

Igual que el backoffice: app tipo **Nixpacks** (SPA, `is_spa: true`), dominio `chat.mgtsolutions.uk`. Ver `DEPLOY.md`.
