# DEPLOY — Stack IA completo (paso 4 del plan)

Resumen: 3 servicios en el VPS, 2 dominios nuevos, 1 app de Cloudflare Access.

## 1. Coolify: vision-tagger (ollama + tagger)

- Repo: `activadores-app` (este plan vive en `app-activadores`).
- Nueva app → **Docker Compose** → **Base Directory**: `tools/vision-tagger`.
- Env vars (ver `tools/vision-tagger/.env.example`):
  - `INSFORGE_URL=https://insforge.mgtsolutions.uk`
  - `INSFORGE_API_KEY=<admin key>` (carpeta `.insforge/` del repo o el dashboard de InsForge)
  - `MARCAS_PROPIAS` (opcional, tiene default)
- Deploy. Una vez corriendo, **descargar los modelos una sola vez**:

  ```bash
  docker exec <contenedor-ollama> ollama pull qwen2.5vl:3b
  docker exec <contenedor-ollama> ollama pull qwen2.5:3b-instruct
  ```

- Validación: en el contenedor `tagger` correr `node tagger.mjs --limit 10` y revisar
  `foto_tags` en InsForge (10 filas nuevas con `scene`, `marcas`, etc.). Si está OK,
  dejar el batch nocturno (2 AM) correr solo.

## 2. Coolify: dominio para Ollama

- En la app Docker Compose, servicio `ollama` → poner dominio `ollama.mgtsolutions.uk`
  (puerto interno 11434).
- El puerto 11434 **nunca** se expone directo: solo vía el dominio + Cloudflare Access.

## 3. Coolify: ChatLocal

- Repo: `chatlocal` (repo propio).
- Nueva app → **Nixpacks** (detecta Vite automáticamente). Es SPA: `is_spa: true`.
- Dominio: `chat.mgtsolutions.uk`.

## 4. Cloudflare

- DNS: registros CNAME `chat` y `ollama` → VPS (proxied, nube naranja).
- **Access** → Applications → una app que cubra `chat.mgtsolutions.uk` y
  `ollama.mgtsolutions.uk` con los emails autorizados (una sola app sirve para ambos).
- Para clientes API externos (VS Code Continue, apps móviles): crear **Service Token**
  (Access → Service Auth) y usarlo como "Token API" en la configuración de ChatLocal
  o como header `Authorization: Bearer <token>`.

## 5. Verificación

1. `https://chat.mgtsolutions.uk` → pide email OTP de Cloudflare Access → chat carga.
2. `⚙️ Configuración`: el selector de modelos lista `qwen2.5vl:3b` y `qwen2.5:3b-instruct`.
3. Mandar un mensaje → respuesta con streaming.
4. Adjuntar una foto de góndola → el modelo de visión describe la escena.
5. Al día siguiente (post-batch 2 AM): `foto_tags` tiene ~590 filas.
