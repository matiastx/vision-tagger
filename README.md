# vision-tagger

Tagger IA de las fotos de visitas usando **Ollama local** en el VPS (gratis). Escribe en la tabla `foto_tags` de InsForge. Parte del plan `PLAN-TAGS-Y-GALERIA.md` (fase 1a/1b).

## Arquitectura

```
┌─────────────┐  GET fotos (admin key)         ┌──────────────┐
│  InsForge   │ ──────────────────────────────▶│   tagger     │
│ (database + │                                │  (cero deps, │
│  storage)   │◀────────── upsert foto_tags ◀──│  Node 20)    │
└─────────────┘                                └──────┬───────┘
        ▲ URL pública directa de cada foto            │ POST /api/chat
        │                                             ▼
                                              ┌──────────────┐
                                              │    ollama    │
                                              │ qwen2.5vl:3b │
                                              └──────────────┘
```

- El tagger corre **batch diario a las 2:00 AM** (TZ Córdoba) + **watch cada 30 min** para fotos nuevas.
- Idempotente por `foto_tags.storage_path UNIQUE` — las corridas no duplican.
- Retry ×2 por foto; si falla queda fila con `error` (auditable).
- Sin GPU: ~8-15 s/foto en CPU (VPS).

## Deploy en Coolify

1. Crear app **Docker Compose** apuntando a este directorio (`tools/vision-tagger`).
   Si el repo es el de la app, en Coolify poner **Base Directory** = `tools/vision-tagger`.
2. Env vars: `INSFORGE_URL`, `INSFORGE_API_KEY`, `MARCAS_PROPIAS` (ver `.env.example`).
3. Deploy. Luego, una sola vez, bajar los modelos dentro del contenedor `ollama`:

   ```bash
   docker exec <ollama-container> ollama pull qwen2.5vl:3b
   docker exec <ollama-container> ollama pull qwen2.5:3b-instruct
   ```

4. Coolify → servicio `ollama` → asignar dominio `ollama.mgtsolutions.uk`
   (lo consume ChatLocal y clientes API externos, detrás de Cloudflare Access).

## Uso manual (validación)

```bash
# dentro del contenedor tagger (coolify terminal) o `docker compose exec tagger sh`
node tagger.mjs --limit 10     # mini-batch de validación
node tagger.mjs --dry-run      # qué procesaría, sin escribir ni llamar a Ollama
node tagger.mjs --once         # una pasada completa
node tagger.mjs --once --reprocess   # re-tagea TODO (ignora las ya procesadas)
```

VPS: `cpus: "2"` en tagger y `6`/`8g` en ollama → no satura el backoffice mientras corre el batch nocturno.

## Precisión

El campo `raw jsonb` guarda la respuesta cruda del modelo. Si `qwen2.5vl:3b` confunde logos/marcas, se puede re-tagear desde el PC local (RTX 3090) con modelos 7B/32B usando el mismo script (`OLLAMA_HOST=http://localhost:11434` + `--once --reprocess`).
