// Cliente Ollama mínimo (sin SDK): /api/tags y /api/chat con streaming NDJSON.
// Soporta Cloudflare Access: se envían los headers del Service Token
// (CF-Access-Client-Id / CF-Access-Client-Secret) cuando están configurados.

export interface Settings {
  baseUrl: string
  /** Cloudflare Access Service Token — Client ID (Zero Trust → Service Auth). */
  accessClientId: string
  /** Cloudflare Access Service Token — Client Secret. */
  accessClientSecret: string
  model: string
}

export const DEFAULT_SETTINGS: Settings = {
  // '' = mismo origen (el Caddy del stack proxea /api/* → ollama interno)
  baseUrl: '',
  accessClientId: '',
  accessClientSecret: '',
  model: '',
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system'
  content: string
  /** Imágenes adjuntas (base64 sin prefijo data:). Solo para modelos de visión. */
  images?: string[]
}

const headers = (s: Settings): HeadersInit => ({
  'Content-Type': 'application/json',
  ...(s.accessClientId && s.accessClientSecret
    ? {
        'CF-Access-Client-Id': s.accessClientId,
        'CF-Access-Client-Secret': s.accessClientSecret,
      }
    : {}),
})

const base = (s: Settings) => s.baseUrl.replace(/\/$/, '')

/** Modelos disponibles en el servidor. */
export async function listModels(s: Settings): Promise<string[]> {
  const res = await fetch(`${base(s)}/api/tags`, { headers: headers(s) })
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
  model: string,
  messages: ChatMessage[],
  onChunk: (text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${base(s)}/api/chat`, {
    method: 'POST',
    headers: headers(s),
    body: JSON.stringify({ model, messages, stream: true }),
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

/** file → base64 (sin prefijo data:), para adjuntar imágenes. */
export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      resolve(result.split(',')[1] ?? '')
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}
