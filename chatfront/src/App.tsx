import { useCallback, useEffect, useRef, useState } from 'react'
import {
  chatStream,
  fileToBase64,
  listModels,
  DEFAULT_SETTINGS,
  type ChatMessage,
  type Settings,
} from './lib/ollama'

// ---------------------------------------------------------------------------
// Tipos + persistencia local
// ---------------------------------------------------------------------------

interface Conversation {
  id: string
  title: string
  createdAt: number
  messages: ChatMessage[]
}

const LS_SETTINGS = 'chatlocal:settings'
const LS_CONVS = 'chatlocal:conversations'

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    // Merge con defaults: settings guardadas de versiones previas pueden
    // no tener los campos nuevos (o tener algunos removidos).
    return raw ? { ...fallback, ...(JSON.parse(raw) as Partial<T>) } : fallback
  } catch {
    return fallback
  }
}

const uid = () => Math.random().toString(36).slice(2) + Date.now().toString(36)

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

export default function App() {
  const [settings, setSettings] = useState<Settings>(() =>
    loadJSON(LS_SETTINGS, DEFAULT_SETTINGS),
  )
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    loadJSON(LS_CONVS, []),
  )
  const [activeId, setActiveId] = useState<string | null>(null)
  const [models, setModels] = useState<string[]>([])
  const [modelsError, setModelsError] = useState<string | null>(null)
  const [input, setInput] = useState('')
  const [image, setImage] = useState<string | null>(null)
  const [streaming, setStreaming] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameText, setRenameText] = useState('')
  const abortRef = useRef<AbortController | null>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  const active = conversations.find((c) => c.id === activeId) ?? null

  // Persistencia
  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    localStorage.setItem(LS_CONVS, JSON.stringify(conversations))
  }, [conversations])

  // Cargar modelos al cambiar servidor/credenciales
  useEffect(() => {
    let cancelled = false
    setModelsError(null)
    listModels(settings)
      .then((m) => {
        if (cancelled) return
        setModels(m)
        if (!settings.model && m.length > 0) {
          setSettings((s) => ({ ...s, model: m[0] }))
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setModels([])
          setModelsError(e instanceof Error ? e.message : 'No se pudo conectar')
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.baseUrl, settings.accessClientId, settings.accessClientSecret])

  // Scroll al fondo con cada chunk
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.messages])

  const newConversation = useCallback(() => {
    const conv: Conversation = {
      id: uid(),
      title: 'Nueva conversación',
      createdAt: Date.now(),
      messages: [],
    }
    setConversations((prev) => [conv, ...prev])
    setActiveId(conv.id)
  }, [])

  const deleteConversation = (id: string) => {
    if (!confirm('¿Eliminar esta conversación?')) return
    setConversations((prev) => prev.filter((c) => c.id !== id))
    if (activeId === id) setActiveId(null)
  }

  const send = async () => {
    const text = input.trim()
    if ((!text && !image) || streaming) return
    if (!settings.model) {
      alert('Elegí un modelo (⚙️ Configuración)')
      setShowSettings(true)
      return
    }

    let convId = activeId
    if (!convId) {
      const conv: Conversation = {
        id: uid(),
        title: text.slice(0, 40) || 'Imagen',
        createdAt: Date.now(),
        messages: [],
      }
      setConversations((prev) => [conv, ...prev])
      convId = conv.id
      setActiveId(convId)
    }

    const userMsg: ChatMessage = {
      role: 'user',
      content: text,
      ...(image ? { images: [image] } : {}),
    }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }

    const id = convId
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              title: c.messages.length === 0 ? c.title === 'Nueva conversación' ? text.slice(0, 40) || 'Imagen' : c.title : c.title,
              messages: [...c.messages, userMsg, assistantMsg],
            }
          : c,
      ),
    )
    setInput('')
    setImage(null)
    setStreaming(true)

    const abort = new AbortController()
    abortRef.current = abort

    // Historial sin el placeholder vacío del assistant
    const history = [...(conversations.find((c) => c.id === id)?.messages ?? []), userMsg]

    try {
      await chatStream(settings, settings.model, history, (chunk) => {
        setConversations((prev) =>
          prev.map((c) => {
            if (c.id !== id) return c
            const msgs = [...c.messages]
            const last = msgs[msgs.length - 1]
            msgs[msgs.length - 1] = { ...last, content: last.content + chunk }
            return { ...c, messages: msgs }
          }),
        )
      }, abort.signal)
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Error'
      setConversations((prev) =>
        prev.map((c) => {
          if (c.id !== id) return c
          const msgs = [...c.messages]
          const last = msgs[msgs.length - 1]
          msgs[msgs.length - 1] = { ...last, content: last.content + `\n\n⚠️ ${msg}` }
          return { ...c, messages: msgs }
        }),
      )
    } finally {
      setStreaming(false)
      abortRef.current = null
    }
  }

  const stop = () => abortRef.current?.abort()

  const attachImage = async (file: File | undefined) => {
    if (!file) return
    setImage(await fileToBase64(file))
  }

  return (
    <div className="flex h-screen">
      {/* Sidebar: conversaciones */}
      <aside className="flex w-64 flex-col border-r border-eva-border bg-eva-surface">
        <div className="flex items-center justify-between p-3">
          <h1 className="text-sm font-bold">💬 ChatLocal</h1>
          <button
            onClick={() => setShowSettings(true)}
            className="rounded px-2 py-1 text-eva-text-muted hover:bg-eva-surface-alt"
            title="Configuración"
          >
            ⚙️
          </button>
        </div>
        <button
          onClick={newConversation}
          className="mx-3 mb-2 rounded-lg bg-eva-primary px-3 py-2 text-sm font-medium text-white hover:bg-eva-primary-dark"
        >
          + Nueva conversación
        </button>
        <div className="flex-1 overflow-y-auto px-3 pb-3">
          {conversations.map((c) => (
            <div
              key={c.id}
              className={`group mb-1 flex cursor-pointer items-center gap-1 rounded-lg px-2 py-2 text-sm ${
                c.id === activeId
                  ? 'bg-eva-primary/20 text-eva-text'
                  : 'text-eva-text-muted hover:bg-eva-surface-alt'
              }`}
              onClick={() => setActiveId(c.id)}
            >
              {renamingId === c.id ? (
                <input
                  autoFocus
                  className="w-full rounded bg-eva-background px-1 py-0.5 text-sm outline-none"
                  value={renameText}
                  onChange={(e) => setRenameText(e.target.value)}
                  onBlur={() => {
                    setConversations((prev) =>
                      prev.map((x) => (x.id === c.id ? { ...x, title: renameText || x.title } : x)),
                    )
                    setRenamingId(null)
                  }}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                />
              ) : (
                <span className="flex-1 truncate">{c.title}</span>
              )}
              <button
                className="hidden px-1 text-eva-text-faint hover:text-eva-text group-hover:block"
                title="Renombrar"
                onClick={(e) => {
                  e.stopPropagation()
                  setRenamingId(c.id)
                  setRenameText(c.title)
                }}
              >
                ✏️
              </button>
              <button
                className="hidden px-1 text-eva-text-faint hover:text-eva-error group-hover:block"
                title="Eliminar"
                onClick={(e) => {
                  e.stopPropagation()
                  deleteConversation(c.id)
                }}
              >
                🗑️
              </button>
            </div>
          ))}
          {conversations.length === 0 && (
            <p className="px-2 py-4 text-center text-xs text-eva-text-faint">
              Sin conversaciones aún
            </p>
          )}
        </div>
        <div className="border-t border-eva-border p-2 text-[11px] text-eva-text-faint">
          {settings.baseUrl.replace(/^https?:\/\//, '')} · {settings.model || 'sin modelo'}
        </div>
      </aside>

      {/* Chat */}
      <main className="flex flex-1 flex-col">
        {/* Mensajes */}
        <div className="flex-1 overflow-y-auto p-4">
          {!active && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-eva-text-faint">
              <p className="text-4xl">💬</p>
              <p>Creá una conversación nueva para empezar</p>
              {modelsError && (
                <p className="text-sm text-eva-error">
                  No conecta con el servidor: {modelsError} (revisá ⚙️ Configuración)
                </p>
              )}
            </div>
          )}
          {active?.messages.map((m, i) => (
            <div
              key={i}
              className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
            >
              <div
                className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user'
                    ? 'bg-eva-primary text-white'
                    : 'bg-eva-surface-alt text-eva-text'
                }`}
              >
                {m.images?.map((img, j) => (
                  <img
                    key={j}
                    src={`data:image/jpeg;base64,${img}`}
                    alt=""
                    className="mb-2 max-h-48 rounded-lg"
                  />
                ))}
                {m.content || (streaming && i === active.messages.length - 1 ? '…' : '')}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-eva-border bg-eva-surface p-3">
          {image && (
            <div className="mb-2 flex items-center gap-2">
              <img
                src={`data:image/jpeg;base64,${image}`}
                alt=""
                className="h-12 w-12 rounded-lg object-cover"
              />
              <button
                onClick={() => setImage(null)}
                className="text-xs text-eva-error hover:underline"
              >
                Quitar imagen
              </button>
            </div>
          )}
          <div className="flex items-end gap-2">
            <input
              ref={fileRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(e) => attachImage(e.target.files?.[0])}
            />
            <button
              onClick={() => fileRef.current?.click()}
              className="rounded-lg px-2 py-2 text-eva-text-muted hover:bg-eva-surface-alt"
              title="Adjuntar imagen (modelo de visión)"
            >
              📎
            </button>
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  void send()
                }
              }}
              placeholder="Escribí tu mensaje… (Enter envía, Shift+Enter nueva línea)"
              rows={2}
              className="flex-1 resize-none rounded-lg border border-eva-border bg-eva-background px-3 py-2 text-sm outline-none focus:border-eva-primary"
            />
            {streaming ? (
              <button
                onClick={stop}
                className="rounded-lg bg-eva-error px-4 py-2 text-sm font-medium text-white"
              >
                ■ Detener
              </button>
            ) : (
              <button
                onClick={() => void send()}
                className="rounded-lg bg-eva-primary px-4 py-2 text-sm font-medium text-white hover:bg-eva-primary-dark"
              >
                Enviar
              </button>
            )}
          </div>
        </div>
      </main>

      {/* Modal de configuración */}
      {showSettings && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4"
          onClick={() => setShowSettings(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-eva-border bg-eva-surface p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="mb-4 text-base font-semibold">⚙️ Configuración</h2>
            <div className="space-y-3">
              <div>
                <label className="mb-1 block text-xs text-eva-text-muted">Servidor Ollama</label>
                <input
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2 text-sm outline-none focus:border-eva-primary"
                  value={settings.baseUrl}
                  onChange={(e) => setSettings((s) => ({ ...s, baseUrl: e.target.value }))}
                  placeholder="https://ollama.mgtsolutions.uk"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-eva-text-muted">
                  Access Client ID (Cloudflare Zero Trust → Service Auth → Service Token)
                </label>
                <input
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2 text-sm outline-none focus:border-eva-primary"
                  value={settings.accessClientId}
                  onChange={(e) => setSettings((s) => ({ ...s, accessClientId: e.target.value }))}
                  placeholder="xxxx.access"
                  autoComplete="off"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs text-eva-text-muted">
                  Access Client Secret
                </label>
                <input
                  type="password"
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2 text-sm outline-none focus:border-eva-primary"
                  value={settings.accessClientSecret}
                  onChange={(e) => setSettings((s) => ({ ...s, accessClientSecret: e.target.value }))}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
                <p className="mt-1 text-[11px] text-eva-text-faint">
                  Solo necesarios porque el dominio está detrás de Cloudflare Access. Se guardan
                  solo en este navegador (localStorage).
                </p>
              </div>
              <div>
                <label className="mb-1 block text-xs text-eva-text-muted">Modelo</label>
                <select
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2 text-sm outline-none focus:border-eva-primary"
                  value={settings.model}
                  onChange={(e) => setSettings((s) => ({ ...s, model: e.target.value }))}
                >
                  {settings.model === '' && <option value="">(elegir…)</option>}
                  {models.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                  {settings.model && !models.includes(settings.model) && (
                    <option value={settings.model}>{settings.model} (no listado)</option>
                  )}
                </select>
                {modelsError && (
                  <p className="mt-1 text-xs text-eva-error">{modelsError}</p>
                )}
                {models.length > 0 && (
                  <p className="mt-1 text-xs text-eva-success">
                    ✔ {models.length} modelo{models.length !== 1 ? 's' : ''} disponibles
                  </p>
                )}
              </div>
            </div>
            <button
              onClick={() => setShowSettings(false)}
              className="mt-5 w-full rounded-lg bg-eva-primary px-4 py-2 text-sm font-medium text-white hover:bg-eva-primary-dark"
            >
              Listo
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
