/**
 * vision-tagger — tagea fotos de visitas con Ollama (qwen2.5vl) y guarda
 * los resultados en la tabla `foto_tags` de InsForge (PostgREST).
 *
 * CERO dependencias npm (fetch nativo de Node 20).
 *
 * Flujo:
 *   1. Lee visita_fotos activos (admin key — anon da 403 en storage/listado)
 *   2. Resuelve la key real del bucket (fotos/... | migracion/... directos)
 *   3. Saltea las ya tageadas (foto_tags.storage_path UNIQUE)
 *   4. Descarga la foto (URL pública directa del bucket, binary-safe)
 *   5. POST a Ollama /api/chat (format: json) con taxonomía cerrada
 *   6. Upsert en foto_tags (patch-then-post si merge-duplicates no anda)
 *   7. Retry ×2 por foto; si falla queda pendiente para la próxima corrida
 *
 * Modos:
 *   --once        Una pasada y sale (batch manual / cron externo)
 *   --limit N     Procesa solo N fotos (validación)
 *   --dry-run     Lista qué procesaría sin llamar a Ollama ni escribir
 *   --reprocess   Re-tagea TODO (ignora las ya procesadas)
 *   (sin flags)   Loop: batch diario a BATCH_START_HOUR + watch cada
 *                 WATCH_INTERVAL_MIN minutos para fotos nuevas
 *
 * Env:
 *   INSFORGE_URL        https://insforge.mgtsolutions.uk
 *   INSFORGE_API_KEY    admin key (mismo patrón que edge functions)
 *   OLLAMA_HOST         http://ollama:11434 (red docker) u otra
 *   OLLAMA_MODEL        qwen2.5vl:3b (default)
 *   MARCAS_PROPIAS      CSV, default: CANCILLER,DILEMA,ESTANCIA MENDOZA,...
 *   WATCH_INTERVAL_MIN  30 (default)
 *   BATCH_START_HOUR    2 (default; hora de BATCH diario, TZ local del container)
 *   BUCKET              ActivadoresApp (default)
 */

const INSFORGE_URL = (process.env.INSFORGE_URL || '').replace(/\/$/, '')
const API_KEY = process.env.INSFORGE_API_KEY || ''
const OLLAMA_HOST = (process.env.OLLAMA_HOST || 'http://ollama:11434').replace(/\/$/, '')
const MODEL = process.env.OLLAMA_MODEL || 'qwen2.5vl:3b'
const BUCKET = process.env.BUCKET || 'ActivadoresApp'
const WATCH_MS = (Number(process.env.WATCH_INTERVAL_MIN) || 30) * 60_000
const BATCH_HOUR = Number(process.env.BATCH_START_HOUR ?? 2)
const MARCAS_PROPIAS = (
  process.env.MARCAS_PROPIAS ||
  'CANCILLER,DILEMA,ESTANCIA MENDOZA,FINCA MAGNOLIA,TORO,NATIVO,LOS HELECHOS'
).split(',').map((s) => s.trim()).filter(Boolean)

const ARGS = new Set(process.argv.slice(2))
const LIMIT_IDX = process.argv.indexOf('--limit')
const LIMIT = LIMIT_IDX >= 0 ? Number(process.argv[LIMIT_IDX + 1]) || 0 : 0

if (!INSFORGE_URL || !API_KEY) {
  console.error('Faltan INSFORGE_URL / INSFORGE_API_KEY')
  process.exit(1)
}

const DBH = {
  apikey: API_KEY,
  Authorization: `Bearer ${API_KEY}`,
  'Content-Type': 'application/json',
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** PostgREST GET contra /api/database/records/{tabla}. */
async function dbGet(path) {
  const res = await fetch(`${INSFORGE_URL}/api/database/records/${path}`, { headers: DBH })
  if (!res.ok) throw new Error(`DB GET ${path}: HTTP ${res.status} ${await res.text()}`)
  return res.json()
}

/** Fotos pendientes de tagear (activas con storage_path real). 443 filas → liviano en JS. */
async function fetchPending(reprocess) {
  const all = (
    await dbGet('visita_fotos?select=id,storage_path,photo_kind&deleted_at=is.null&order=created_at.asc&limit=5000')
  ).filter((f) => typeof f.storage_path === 'string' && /^(fotos|migracion)\//.test(f.storage_path))

  if (reprocess) return all
  // Solo cuentan como "hechas" las filas SIN error — las fallidas se reintentan solas
  const tagged = await dbGet('foto_tags?select=storage_path&error=is.null&limit=5000')
  const done = new Set((tagged || []).map((t) => t.storage_path))
  return all.filter((f) => !done.has(f.storage_path))
}

/** Descarga binaria de una foto del bucket público. */
async function downloadPhoto(storagePath) {
  const url = `${INSFORGE_URL}/api/storage/buckets/${BUCKET}/objects/${storagePath}`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Download ${storagePath}: HTTP ${res.status}`)
  const buf = Buffer.from(await res.arrayBuffer())
  return buf.toString('base64')
}

const PROMPT = (marcas) => `Sos un auditor visual de merchandising en puntos de venta (Argentina). Analizá la foto y devolvé SOLO un JSON con este esquema exacto:
{
  "scene": "gondola|puntera|estanteria|exhibidor|isla|caja|degustacion|otro",
  "envases": ["botella","tetra_brick","lata","sachet","doypack","frasco","carton","bolsa","otro"],
  "marcas": ["<marcas propias visibles>"],
  "otras_marcas": ["<otras marcas/competencia visibles>"],
  "pop": true/false,
  "pop_detalle": "<qué material POP se ve, o vacío>",
  "promo": true/false,
  "promo_detalle": "<qué promo/offer se ve, o vacío>",
  "tags": ["<etiquetas libres en español: gondola_completa, gondola_desabastecida, puntera_completa, puntera_incompleta, exhibidor_armado, degustacion_montada, producto_frenteado, precios_visibles, etc>"],
  "descripcion": "<una oración breve en español describiendo la escena>"
}
Marcas propias (reconocer por logo/etiqueta, escribir exactamente así): ${marcas.join(', ')}.
Reglas: arrays vacíos si no hay; pop/promo nullean a false si no se ven; no inventes marcas; respondé SOLO el JSON sin texto extra.`

/** Normaliza la respuesta del modelo a la shape de foto_tags. */
function normalizeTags(raw) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()).map((s) => s.trim()) : [])
  const bool = (v) => (v === true ? true : v === false ? false : null)
  const txt = (v) => (typeof v === 'string' ? v.trim() || null : null)
  const scenes = ['gondola', 'puntera', 'estanteria', 'exhibidor', 'isla', 'caja', 'degustacion', 'otro']
  return {
    scene: scenes.includes(raw.scene) ? raw.scene : null,
    envases: arr(raw.envases),
    marcas: arr(raw.marcas),
    otras_marcas: arr(raw.otras_marcas),
    pop: bool(raw.pop),
    pop_detalle: txt(raw.pop_detalle),
    promo: bool(raw.promo),
    promo_detalle: txt(raw.promo_detalle),
    tags: arr(raw.tags),
    descripcion: txt(raw.descripcion),
  }
}

/** Llama a Ollama /api/chat con la imagen y devuelve el JSON parseado. */
async function tagWithOllama(base64) {
  const res = await fetch(`${OLLAMA_HOST}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      format: 'json',
      stream: false,
      messages: [
        { role: 'user', content: PROMPT(MARCAS_PROPIAS), images: [base64] },
      ],
      options: { temperature: 0.1 },
    }),
  })
  if (!res.ok) throw new Error(`Ollama: HTTP ${res.status} ${await res.text()}`)
  const json = await res.json()
  const content = json?.message?.content ?? ''
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Ollama no devolvió JSON')
  return JSON.parse(match[0])
}

/** Upsert en foto_tags. PostgREST merge-duplicates a veces falla → patch-then-post. */
async function upsertTags(foto, tags) {
  const row = {
    foto_id: foto.id,
    storage_path: foto.storage_path,
    photo_kind: foto.photo_kind ?? null,
    model: MODEL,
    raw: tags,
    processed_at: new Date().toISOString(),
    ...normalizeTags(tags),
  }
  // Intento upsert nativo
  const up = await fetch(`${INSFORGE_URL}/api/database/records/foto_tags`, {
    method: 'POST',
    headers: { ...DBH, Prefer: 'resolution=merge-duplicates,return=minimal' },
    body: JSON.stringify(row),
  })
  if (up.ok || up.status === 201) return
  // Fallback: PATCH por UNIQUE(storage_path); si 0 filas → POST
  const patch = await fetch(
    `${INSFORGE_URL}/api/database/records/foto_tags?storage_path=eq.${encodeURIComponent(foto.storage_path)}`,
    { method: 'PATCH', headers: { ...DBH, Prefer: 'return=representation' }, body: JSON.stringify(row) },
  )
  if (patch.ok) {
    const patched = await patch.json().catch(() => [])
    if (Array.isArray(patched) && patched.length > 0) return
  }
  const post = await fetch(`${INSFORGE_URL}/api/database/records/foto_tags`, {
    method: 'POST',
    headers: { ...DBH, Prefer: 'return=minimal' },
    body: JSON.stringify(row),
  })
  if (!post.ok) throw new Error(`Upsert foto_tags: HTTP ${post.status} ${await post.text()}`)
}

async function processOne(foto, idx, total) {
  const label = `[${idx + 1}/${total}] ${foto.storage_path}`
  let lastErr = null
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const t0 = Date.now()
      const base64 = await downloadPhoto(foto.storage_path)
      const tags = await tagWithOllama(base64)
      await upsertTags(foto, tags)
      console.log(`${label} ✔ ${normalizeTags(tags).scene ?? '?'} (${((Date.now() - t0) / 1000).toFixed(1)}s)`)
      return true
    } catch (err) {
      lastErr = err
      console.warn(`${label} intento ${attempt} falló: ${err.message}`)
      await sleep(2000)
    }
  }
  // Registrar el error en foto_tags para auditarlo después (la próxima corrida
  // con --reprocess cubre errores; la normal lo saltea por storage_path presente).
  try {
    await fetch(`${INSFORGE_URL}/api/database/records/foto_tags`, {
      method: 'POST',
      headers: { ...DBH, Prefer: 'resolution=merge-duplicates,return=minimal' },
      body: JSON.stringify({
        foto_id: foto.id,
        storage_path: foto.storage_path,
        photo_kind: foto.photo_kind ?? null,
        model: MODEL,
        error: String(lastErr?.message ?? lastErr),
        processed_at: new Date().toISOString(),
      }),
    })
  } catch {
    /* best effort — queda pendiente para la próxima corrida */
  }
  return false
}

async function runPass({ reprocess = false, dryRun = false } = {}) {
  const pending = await fetchPending(reprocess)
  const list = LIMIT > 0 ? pending.slice(0, LIMIT) : pending
  console.log(`[${new Date().toISOString()}] Pendientes: ${pending.length}${LIMIT ? ` (procesando ${list.length})` : ''}`)
  if (dryRun) {
    for (const f of list) console.log(`  dry-run ${f.storage_path}`)
    return { ok: 0, fail: 0 }
  }
  let ok = 0
  let fail = 0
  for (let i = 0; i < list.length; i++) {
    if (await processOne(list[i], i, list.length)) ok++
    else fail++
  }
  console.log(`[${new Date().toISOString()}] Pasada: ${ok} ok, ${fail} fallaron`)
  return { ok, fail }
}

/** ms hasta la próxima corrida: la próxima BATCH_HOUR local. */
function msUntilNextBatch() {
  const now = new Date()
  const next = new Date(now)
  next.setHours(BATCH_HOUR, 0, 0, 0)
  if (next <= now) next.setDate(next.getDate() + 1)
  return next - now
}

async function main() {
  console.log(`vision-tagger | ollama=${OLLAMA_HOST} model=${MODEL} | insforge=${INSFORGE_URL}`)

  if (ARGS.has('--dry-run')) {
    await runPass({ dryRun: true })
    return
  }
  if (ARGS.has('--once') || ARGS.has('--limit') || ARGS.has('--batch')) {
    await runPass({ reprocess: ARGS.has('--reprocess') })
    return
  }

  // Modo daemon: batch nocturno a BATCH_HOUR + watch cada WATCH para nuevas
  console.log(`Daemon: batch diario ${BATCH_HOUR}:00 + watch cada ${WATCH_MS / 60000} min`)
  setTimeout(() => {
    runPass({ reprocess: ARGS.has('--reprocess') }).catch((e) => console.error('batch error:', e))
    setInterval(() => runPass().catch((e) => console.error('batch error:', e)), 24 * 3600_000)
  }, msUntilNextBatch())
  setInterval(() => runPass().catch((e) => console.error('watch error:', e)), WATCH_MS)
}

main().catch((e) => {
  console.error('FATAL:', e)
  process.exit(1)
})
