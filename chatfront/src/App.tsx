import { useCallback, useEffect, useRef, useState } from 'react'
import {
  chatStream,
  fileToBase64,
  firstTextModel,
  firstVisionModel,
  listModels,
  DEFAULT_SETTINGS,
  type ChatAuth,
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
const LS_AUTH = 'chatlocal:auth'
const LS_LOCKOUT = 'chatlocal:lockout-until'
const MAX_ATTEMPTS = 3
const LOCK_MS = 60 * 60 * 1000 // 1 hora

const loadJSON = <T,>(key: string, fallback: T): T => {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw) as T
    // Merge con defaults solo para objetos (settings/auth). Si es array
    // (conversaciones), devolverlo tal cual: transformarlo en objeto rompe
    // .find/.map y la página queda negra (bug F5).
    if (Array.isArray(parsed)) return parsed
    return { ...(fallback as object), ...(parsed as object) } as T
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
  const [auth, setAuth] = useState<ChatAuth | null>(() => loadJSON(LS_AUTH, null as ChatAuth | null))
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

  // Login local
  const [loginUser, setLoginUser] = useState('')
  const [loginPass, setLoginPass] = useState('')
  const [loginError, setLoginError] = useState<string | null>(null)
  const [loginLoading, setLoginLoading] = useState(false)
  const [attempts, setAttempts] = useState(0)
  const [lockedUntil, setLockedUntil] = useState<number>(() =>
    Number(localStorage.getItem(LS_LOCKOUT) ?? 0),
  )

  const active = conversations.find((c) => c.id === activeId) ?? null
  const locked = lockedUntil > Date.now()
  const locksLeft = Math.max(0, MAX_ATTEMPTS - attempts)

  // Persistencia
  useEffect(() => {
    localStorage.setItem(LS_SETTINGS, JSON.stringify(settings))
  }, [settings])
  useEffect(() => {
    localStorage.setItem(LS_CONVS, JSON.stringify(conversations))
  }, [conversations])
  useEffect(() => {
    if (auth) localStorage.setItem(LS_AUTH, JSON.stringify(auth))
    else localStorage.removeItem(LS_AUTH)
  }, [auth])
  useEffect(() => {
    localStorage.setItem(LS_LOCKOUT, String(lockedUntil))
  }, [lockedUntil])

  // Cargar modelos al conectar
  useEffect(() => {
    if (!auth) return
    let cancelled = false
    setModelsError(null)
    listModels(settings, auth)
      .then((m) => {
        if (cancelled) return
        setModels(m)
        // Default: modelo de texto (no el de visión) — más rápido y sin
        // problemas de multimodal al iniciar. Si hay imagen se switchea.
        if (!settings.model && m.length > 0) {
          const pref = firstTextModel(m) ?? m[0]
          setSettings((s) => ({ ...s, model: pref }))
        }
      })
      .catch((e) => {
        if (!cancelled) {
          setModels([])
          setModelsError(e instanceof Error ? e.message : 'No se pudo conectar')
          // Token caducado → volver al login
          if (/HTTP 401/.test(String(e))) setAuth(null)
        }
      })
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auth])

  // Scroll al fondo con cada chunk
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [active?.messages])

  const doLogin = async (e: React.FormEvent) => {
    e.preventDefault()
    if (locked || loginLoading) return
    setLoginLoading(true)
    setLoginError(null)
    try {
      const cand = { user: loginUser.trim(), password: loginPass }
      await listModels(settings, cand) // valida contra `/api/tags`
      setAuth(cand)
      setAttempts(0)
      setLockedUntil(0)
    } catch (err) {
      const failed = attempts + 1
      setAttempts(failed)
      if (failed >= MAX_ATTEMPTS) {
        const until = Date.now() + LOCK_MS
        setLockedUntil(until)
        const mm = Math.ceil(LOCK_MS / 60000)
        setLoginError(`Demasiados intentos. Te bloqueé por ${mm} min.`)
      } else {
        setLoginError(
          `Credenciales inválidas (${err instanceof Error ? err.message : ''}). Te quedan ${MAX_ATTEMPTS - failed} intento(s).`,
        )
      }
    } finally {
      setLoginLoading(false)
    }
  }

  const logout = () => {
    setAuth(null)
    setModels([])
    setModelsError(null)
    setActiveId(null)
    setLoginUser('')
    setLoginPass('')
    setLoginError(null)
    setAttempts(0)
  }

  const newConversation = useCallback(() => {
    const conv: Conversation = { id: uid(), title: 'Nueva conversación', createdAt: Date.now(), messages: [] }
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
      setShowSettings(true)
      return
    }

    // Si hay imagen, garantizar modelo de visión (evita multiples 400 por
    // multimodal con modelos de texto-no-vision)
    let modelToUse = settings.model
    if (image) {
      const vision = firstVisionModel(models)
      if (vision && modelToUse !== vision) {
        modelToUse = vision
        setSettings((s) => ({ ...s, model: vision }))
      }
    }

    // Si tenemos imagen y el modelo de visión no está en RAM todavía, el
    // primer mensaje puede llegar a 60+s. Con keep_alive=30m del server,
    // solo pasa la primera vez tras una pausa larga.
    if (image) {
      setModelNotice('⏳ Subiendo y procesando imagen… la primera respuesta puede tardar ~1 min si el modelo está frío.')
    }

    let convId = activeId
    if (!convId) {
      const conv: Conversation = { id: uid(), title: text.slice(0, 40) || 'Imagen', createdAt: Date.now(), messages: [] }
      setConversations((prev) => [conv, ...prev])
      convId = conv.id
      setActiveId(convId)
    }

    const userMsg: ChatMessage = { role: 'user', content: text, ...(image ? { images: [image] } : {}) }
    const assistantMsg: ChatMessage = { role: 'assistant', content: '' }

    const id = convId
    setConversations((prev) =>
      prev.map((c) =>
        c.id === id
          ? {
              ...c,
              title: c.messages.length === 0 ? (text.slice(0, 40) || 'Imagen') : c.title,
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
    const history = [...(conversations.find((c) => c.id === id)?.messages ?? []), userMsg]

    try {
      await chatStream(settings, auth, modelToUse, history, (chunk) => {
        // Limpiar el aviso cuando llega el primer chunk
        setModelNotice((cur) => (cur?.startsWith('⏳') ? null : cur))
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
    // Bug anterior: mandar foto al modelo de texto → "Multimodal data
    // provided, but model does not support multimodal requests". Auto-cambiar
    // al modelo de visión si va con imagen (y avisar al usuario).
    const vision = firstVisionModel(models)
    if (vision) {
      const current = settings.model
      if (current !== vision) {
        setSettings((s) => ({ ...s, model: vision }))
        setModelNotice(`📷 Foto adjunta: mejor uso ${vision} (visión).`)
        setTimeout(() => setModelNotice(null), 5000)
        // Pre-cargar en RAM ahora para que la respuesta no espere 60-90s
        // de carga fría más tarde. Fire-and-forget.
        void chatStream(
          settings,
          auth,
          vision,
          [{ role: 'user', content: 'ok' }],
          () => {},
        ).catch(() => {})
      }
    }
  }

  // Aviso temporal al conmutar modelo por la imagen
  const [modelNotice, setModelNotice] = useState<string | null>(null)

  const removeImage = () => {
    setImage(null)
    // Volver al modelo de texto si había uno elegido / recordado
    const text = firstTextModel(models)
    if (text && settings.model !== text) setSettings((s) => ({ ...s, model: text }))
  }

  // -------------------------------------------------------------------------
  // Login
  // -------------------------------------------------------------------------
  if (!auth) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-eva-background px-4"
        style={{
          backgroundImage:
            'radial-gradient(circle at top, rgba(124,92,252,0.18), transparent 55%), radial-gradient(circle at bottom right, rgba(74,222,128,0.08), transparent 55%)',
        }}
      >
        <div className="w-full max-w-sm rounded-2xl border border-eva-border bg-eva-surface/80 p-8 shadow-2xl backdrop-blur">
          <div className="mb-6 text-center">
            <p className="mb-2 text-4xl">💬</p>
            <h1 className="text-xl font-bold">ChatLocal</h1>
            <p className="mt-1 text-sm text-eva-text-muted">IA local · tus datos se quedan acá</p>
          </div>

          {locked ? (
            <div className="rounded-lg border border-eva-error/40 bg-eva-error/10 p-4 text-center">
              <p className="text-sm font-medium text-eva-error">Bloqueado por 1 hora</p>
              <p className="mt-1 text-xs text-eva-text-muted">
                Demasiados intentos con contraseña incorrecta. Volvé más tarde.
              </p>
            </div>
          ) : (
            <form onSubmit={doLogin} className="space-y-4">
              <div>
                <label className="mb-1 block text-xs font-medium text-eva-text-muted">Usuario</label>
                <input
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2.5 text-sm outline-none transition focus:border-eva-primary"
                  value={loginUser}
                  onChange={(e) => setLoginUser(e.target.value)}
                  autoFocus
                  autoComplete="username"
                  placeholder="usuario"
                />
              </div>
              <div>
                <label className="mb-1 block text-xs font-medium text-eva-text-muted">Contraseña</label>
                <input
                  type="password"
                  className="w-full rounded-lg border border-eva-border bg-eva-background px-3 py-2.5 text-sm outline-none transition focus:border-eva-primary"
                  value={loginPass}
                  onChange={(e) => setLoginPass(e.target.value)}
                  autoComplete="current-password"
                  placeholder="••••••••••"
                />
              </div>
              {loginError && (
                <div className="rounded-lg border border-eva-error/40 bg-eva-error/10 px-3 py-2 text-xs text-eva-error">
                  {loginError}
                </div>
              )}
              {attempts > 0 && !locked && (
                <p className="text-center text-[11px] text-eva-text-faint">
                  {locksLeft} intento{locksLeft !== 1 ? 's' : ''} restantes antes del bloqueo
                </p>
              )}
              <button
                type="submit"
                disabled={loginLoading || !loginUser.trim() || !loginPass}
                className="w-full rounded-lg bg-eva-primary px-4 py-2.5 text-sm font-semibold text-white shadow-lg shadow-eva-primary/30 transition hover:bg-eva-primary-dark disabled:opacity-50"
              >
                {loginLoading ? 'Entrando…' : 'Entrar'}
              </button>
            </form>
          )}
        </div>
      </div>
    )
  }

  // -------------------------------------------------------------------------
  // Chat (autenticado)
  // -------------------------------------------------------------------------
  return (
    <div className="flex h-screen">
      {/* Sidebar */}
      <aside className="flex w-64 flex-col border-r border-eva-border bg-eva-surface">
        <div className="flex items-center justify-between p-3">
          <h1 className="text-sm font-bold">💬 ChatLocal</h1>
          <div className="flex gap-1">
            <button
              onClick={() => setShowSettings(true)}
              className="rounded px-2 py-1 text-eva-text-muted hover:bg-eva-surface-alt"
              title="Configuración"
            >
              ⚙️
            </button>
            <button
              onClick={logout}
              className="rounded px-2 py-1 text-eva-text-muted hover:bg-eva-surface-alt"
              title="Cerrar sesión"
            >
              ⏏
            </button>
          </div>
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
                c.id === activeId ? 'bg-eva-primary/20 text-eva-text' : 'text-eva-text-muted hover:bg-eva-surface-alt'
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
            <p className="px-2 py-4 text-center text-xs text-eva-text-faint">Sin conversaciones aún</p>
          )}
        </div>
        <div className="border-t border-eva-border p-2 text-[11px] text-eva-text-faint">
          {settings.model || 'sin modelo'}
        </div>
      </aside>

      {/* Chat */}
      <main className="flex flex-1 flex-col">
        <div className="flex-1 overflow-y-auto p-4">
          {!active && (
            <div className="flex h-full flex-col items-center justify-center gap-2 text-eva-text-faint">
              <p className="text-4xl">💬</p>
              <p>Creá una conversación nueva para empezar</p>
              {modelsError && (
                <p className="text-sm text-eva-error">No conecta con el servidor: {modelsError}</p>
              )}
            </div>
          )}
          {active?.messages.map((m, i) => (
            <div key={i} className={`mb-3 flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div
                className={`max-w-[75%] whitespace-pre-wrap rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
                  m.role === 'user' ? 'bg-eva-primary text-white' : 'bg-eva-surface-alt text-eva-text'
                }`}
              >
                {m.images?.map((img, j) => (
                  <img key={j} src={`data:image/jpeg;base64,${img}`} alt="" className="mb-2 max-h-48 rounded-lg" />
                ))}
                {m.content || (streaming && i === active.messages.length - 1 ? '…' : '')}
              </div>
            </div>
          ))}
          <div ref={bottomRef} />
        </div>

        {/* Input */}
        <div className="border-t border-eva-border bg-eva-surface p-3">
          {modelNotice && (
            <p className="mb-2 rounded border border-eva-info/30 bg-eva-info-bg px-2 py-1 text-[11px] text-eva-info">
              {modelNotice}
            </p>
          )}
          {image && (
            <div className="mb-2 flex items-center gap-2">
              <img src={`data:image/jpeg;base64,${image}`} alt="" className="h-12 w-12 rounded-lg object-cover" />
              <button onClick={removeImage} className="text-xs text-eva-error hover:underline">
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
              title="Adjuntar imagen (qwen2.5vl)"
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
              <button onClick={stop} className="rounded-lg bg-eva-error px-4 py-2 text-sm font-medium text-white">
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
                  placeholder="(vacío = mismo servidor que la página)"
                />
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
                {modelsError && <p className="mt-1 text-xs text-eva-error">{modelsError}</p>}
                {models.length > 0 && (
                  <p className="mt-1 text-xs text-eva-success">✔ {models.length} modelo{models.length !== 1 ? 's' : ''} disponibles</p>
                )}
              </div>
              <p className="text-[11px] text-eva-text-faint">
                Los datos se guardan solo en este navegador (localStorage). La sesión cierra con ⏏.
              </p>
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
