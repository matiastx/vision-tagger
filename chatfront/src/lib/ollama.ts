// Cliente Ollama mínimo (sin SDK): /api/tags y /api/chat con streaming NDJSON.
// Auth: credenciales del login (Basic Auth de Caddy sobre /api/*).

export interface Settings {
  /** Default: mismo origen (el Caddy del stack proxea /api/* → ollama interno). */
  baseUrl: string
  model: string
}

export const DEFAULT_SETTINGS: Settings = {
  baseUrl: '',
  model: '',
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Imágenes adjuntas (base64 sin prefijo data:). Solo para modelos de visión. */
  images?: string[]
}

export interface ChatAuth {
  user: string
  password: string
}

/** Modelos tendrán esto en el nombre (para detectar el que tiene visión). */
export const VISION_MODEL_HINT = 'vl'

/** Dado un listado, devuelve el primer modelo con capacidad de visión. */
export function firstVisionModel(models: string[]): string | null {
  return models.find((m) => m.toLowerCase().includes(VISION_MODEL_HINT)) ?? null
}

/** Dado un listado, devuelve el primer modelo de texto puro. */
export function firstTextModel(models: string[]): string | null {
  return models.find((m) => !m.toLowerCase().includes(VISION_MODEL_HINT)) ?? null
}

const headers = (s: Settings, auth: ChatAuth | null): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(auth ? { Authorization: `Basic ${btoa(`${auth.user}:${auth.password}`)}` } : {}),
})

const base = (s: Settings) => s.baseUrl.replace(/\/$/, '')

/** Modelos disponibles en el servidor (valida credenciales si las hay). */
export async function listModels(s: Settings, auth: ChatAuth | null): Promise<string[]> {
  const res = await fetch(`${base(s)}/api/tags`, { headers: headers(s, auth) })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  const json = (await res.json()) as { models?: { name: string }[] }
  return (json.models ?? []).map((m) => m.name)
}

/**
 * Chat con streaming. onChunk recibe cada fragmento de texto incremental.
 * Devuelve el texto completo al finalizar.
 */
export async function chatStream(
  s: Settings,
  auth: ChatAuth | null,
  model: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${base(s)}/api/chat`, {
    method: 'POST',
    headers: headers(s, auth),
    // num_ctx 8192: el default 4096 es demasiado chico — saltaba
    // "4097 tokens exceeds 4096" con imagenes + historial.
    body: JSON.stringify({ model, messages, stream: true, options: { num_ctx: 8192 } }),
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    // NDJSON: un objeto JSON por línea
    let idx: number
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).trim()
      buffer = buffer.slice(idx + 1)
      if (!line) continue
      try {
        const json = JSON.parse(line) as {
          message?: { content?: string }
          done?: boolean
        }
        const chunk = json.message?.content
        if (chunk) onChunk(chunk)
      } catch {
        /* línea parcial — se completa en el próximo chunk */
      }
    }
  }
}

/** file → base64 (sin prefijo data:).
 *  Si es imagen: downscales a max-width 1024 ┘ prefill CPU de qwen2.5vl
 *  en 3 vCPU ~60s/turn a 1344px; a 1024px baja ~3-4x (evita que el proxy
 *  cierre por timeout 499). */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      const reader = new FileReader()
      reader.onload = () => {
        const result = String(reader.result)
        resolve(result.split(',')[1] ?? '')
      }
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
      return
    }
    // Imagen → downscale via canvas
    const img = new Image()
    img.onload = () => {
      const maxDim = 1024
      let { width, height } = img
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const cv = document.createElement('canvas')
      cv.width = width
      cv.height = height
      cv.getContext('2d')?.drawImage(img, 0, 0, width, height)
      const dataUrl = cv.toDataURL('image/jpeg', 0.85)
      resolve(dataUrl.split(',')[1] ?? '')
      URL.revokeObjectURL(img.src)
    }
    img.onerror = (e) => reject(e)
    img.src = URL.createObjectURL(file)
  })
}
