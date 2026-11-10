'use client'

import { useEffect, useRef, useState } from 'react'

interface WorkspaceOption {
  id: string
  name: string
  appId?: string
}

interface Suggestion {
  repo: string
  dir: string
  appId?: string
  hasFlows: boolean
}

interface Props {
  workspaces: WorkspaceOption[]
  initialWorkspace: string
  /** Nome do fluxo aberto com alterações não salvas (serão salvas antes de abrir o novo). */
  unsavedFlow?: string
  onClose: () => void
  onCreate: (workspace: string, name: string) => Promise<void>
}

const VALID = /^[\w\-/. ]+$/
const NEW_WS = '__novo__'

function slug(name: string) {
  return name.trim().replace(/\\/g, '/').replace(/\.ya?ml$/i, '').replace(/\s+/g, '-')
}

export function NewFlowModal({ workspaces, initialWorkspace, unsavedFlow, onClose, onCreate }: Props) {
  const [workspace, setWorkspace] = useState(initialWorkspace)
  const [name, setName] = useState('')
  const [subflow, setSubflow] = useState(false)
  const [wsName, setWsName] = useState('')
  const [wsDir, setWsDir] = useState('')
  const [wsAppId, setWsAppId] = useState('')
  const [suggestions, setSuggestions] = useState<Suggestion[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
  const wsNameRef = useRef<HTMLInputElement>(null)
  const creatingWs = workspace === NEW_WS

  // A página re-renderiza a cada tique do relógio: guarda o onClose num ref para o foco
  // inicial e o listener do Esc não rodarem de novo (o que roubaria o foco dos campos).
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  useEffect(() => {
    inputRef.current?.focus()
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (!creatingWs) return
    wsNameRef.current?.focus()
    if (suggestions.length) return
    fetch('/api/workspaces')
      .then((r) => r.json())
      .then((d) => setSuggestions(d.suggestions ?? []))
      .catch(() => undefined)
  }, [creatingWs, suggestions.length])

  /** Escolher um repo sugerido preenche pasta, appId e (se vazio) o nome. */
  const pickDir = (dir: string) => {
    setWsDir(dir)
    const s = suggestions.find((x) => x.dir === dir)
    if (!s) return
    if (s.appId) setWsAppId(s.appId)
    if (!wsName) setWsName(s.repo)
  }

  const base = slug(name)
  const rel = base ? `${subflow && !base.startsWith('subflows/') ? 'subflows/' : ''}${base}.yaml` : ''
  const ws = workspaces.find((w) => w.id === workspace)
  const invalid = base && (!VALID.test(base) || base.includes('..')) ? 'Use letras, números, "-", "_" e "/" para pastas.' : null
  const wsIncomplete = creatingWs && (!wsName.trim() || !wsDir.trim())

  const submit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!rel || invalid || wsIncomplete || busy) return
    setBusy(true)
    setError(null)
    try {
      let target = workspace
      if (creatingWs) {
        const res = await fetch('/api/workspaces', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: wsName, dir: wsDir, appId: wsAppId.trim() || undefined }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'não consegui criar o workspace')
        target = data.id
        setWorkspace(target)
      }
      await onCreate(target, rel)
    } catch (err) {
      setError((err as Error).message)
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <form className="modal card" onSubmit={submit} role="dialog" aria-modal="true" aria-labelledby="new-flow-title">
        <div className="modal-head">
          <h2 id="new-flow-title">Novo fluxo</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">×</button>
        </div>

        <label className="field">
          <span>Workspace</span>
          <select value={workspace} onChange={(e) => setWorkspace(e.target.value)}>
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
            <option value={NEW_WS}>+ novo workspace…</option>
          </select>
        </label>

        {creatingWs && (
          <fieldset className="ws-new">
            <label className="field">
              <span>Nome do workspace</span>
              <input ref={wsNameRef} value={wsName} placeholder="ex.: Now App" onChange={(e) => setWsName(e.target.value)} />
            </label>
            <label className="field">
              <span>Pasta dos fluxos</span>
              <input
                value={wsDir}
                list="ws-dirs"
                placeholder="../meu-repo/.maestro"
                onChange={(e) => pickDir(e.target.value)}
              />
              <datalist id="ws-dirs">
                {suggestions.map((s) => (
                  <option key={s.dir} value={s.dir}>
                    {s.repo}
                    {s.appId ? ` · ${s.appId}` : ''}
                    {s.hasFlows ? ' · já tem fluxos' : ''}
                  </option>
                ))}
              </datalist>
              <small>Relativa ao e2e-box. A pasta é criada se não existir.</small>
            </label>
            <label className="field">
              <span>appId (Android)</span>
              <input value={wsAppId} placeholder="app.empresa.produto" onChange={(e) => setWsAppId(e.target.value)} />
            </label>
          </fieldset>
        )}

        <label className="field">
          <span>Nome do fluxo</span>
          <input
            ref={inputRef}
            value={name}
            placeholder="ex.: login, abrir-sacola"
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
          />
        </label>

        <label className="check-field">
          <input type="checkbox" checked={subflow} onChange={(e) => setSubflow(e.target.checked)} />
          <span>Subfluxo (vai para <code>subflows/</code>, chamado por <code>runFlow</code>)</span>
        </label>

        <div className="modal-preview">
          <div>
            <span>arquivo</span> <b>{rel ? `${creatingWs ? wsDir || '…' : ''}${creatingWs ? '/' : ''}${rel}` : '—'}</b>
          </div>
          <div>
            <span>appId</span> <b>{(creatingWs ? wsAppId : ws?.appId) || 'com.exemplo.app'}</b>
          </div>
        </div>

        {unsavedFlow && <div className="modal-note">As alterações em {unsavedFlow} serão salvas antes de abrir o novo fluxo.</div>}
        {(invalid || error) && <div className="modal-error">{invalid ?? error}</div>}

        <div className="modal-actions">
          <button type="button" className="btn" onClick={onClose}>cancelar</button>
          <button type="submit" className="btn run" disabled={!rel || !!invalid || wsIncomplete || busy}>
            {busy ? 'criando…' : creatingWs ? 'criar workspace e fluxo' : 'criar fluxo'}
          </button>
        </div>
      </form>
    </div>
  )
}
