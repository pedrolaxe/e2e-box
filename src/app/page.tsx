'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Bots, botFor, type BotId } from '@/components/Bots'
import { NewFlowModal } from '@/components/NewFlowModal'
import { RunDetail } from '@/components/RunDetail'
import { Phone, type Gesture } from '@/components/Phone'
import type { RepeatResult, RunEvent, RunStats, StepStatus } from '@/lib/engine'
import { useI18n } from '@/lib/i18n'
import { LANGS } from '@/lib/lang'
import { lintFlow, repairFlow, stepAt, withSeparator, type FlowIssue } from '@/lib/lint'

interface FlowFile {
  ref: string
  workspace: string
  rel: string
  name: string
  subflow: boolean
  lastRun: RunSummary | null
}
interface WorkspaceInfo {
  id: string
  name: string
  appId?: string
  files: FlowFile[]
}
interface RunSummary {
  runId: string
  ref: string
  status: 'running' | 'passed' | 'failed' | 'stopped'
  startedAt: number
  ms?: number
  error?: string
  checks?: number
  partial?: string
}
interface DeviceInfo {
  devices: { serial: string; state: string; model?: string }[]
  serial: string | null
  runningSerials?: string[]
  /** Outro processo (a CLI) rodando neste celular. */
  busy?: string
  info?: { model?: string; android?: string; transport?: string; battery: { level: number; charging: boolean } | null; screen: { w: number; h: number } | null }
}
interface LogLine {
  at: number
  level: string
  msg: string
  depth: number
  manual?: boolean
}
interface Step {
  label: string
  status: StepStatus
  ms?: number
  error?: string
}

const EMPTY_STATS: RunStats = { steps: 0, done: 0, taps: 0, inputs: 0, checksOk: 0, checksFailed: 0 }
/** Fluxo que passou sem conferir nada aparece em outra cor. */
const dotClass = (r: { status: string; checks?: number; partial?: string | boolean } | null | undefined) =>
  r?.status === 'passed' && r.checks === 0 && !r.partial ? 'unchecked' : (r?.status ?? '')
const secs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

async function api<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json ? { 'content-type': 'application/json' } : undefined,
    body: init?.json ? JSON.stringify(init.json) : init?.body,
  })
  const data = await res.json()
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`)
  return data
}

export default function Home() {
  const { t, lang, setLang } = useI18n()
  const time = (at: number) => new Date(at).toLocaleTimeString(t.locale, { hour12: false })
  /** Efeitos de longa duração (SSE, polling) leem o idioma atual sem reconectar. */
  const tRef = useRef(t)
  tRef.current = t
  // 0 até montar: o relógio só aparece no cliente (evita divergência de hidratação).
  const [now, setNow] = useState(0)
  const [device, setDevice] = useState<DeviceInfo | null>(null)
  const [watched, setWatched] = useState<string | null>(null)
  /** undefined até a primeira leitura: abrir a página sem celular não é "desconectou". */
  const lastOnline = useRef<string | null | undefined>(undefined)
  const [workspaces, setWorkspaces] = useState<WorkspaceInfo[]>([])
  const [runs, setRuns] = useState<RunSummary[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [saved, setSaved] = useState('')
  const [parseError, setParseError] = useState<string | undefined>()
  const [tab, setTab] = useState<'yaml' | 'log' | 'adb'>('yaml')
  const [env, setEnv] = useState('')
  const [logs, setLogs] = useState<LogLine[]>([])
  const [steps, setSteps] = useState<Step[]>([])
  const [stats, setStats] = useState<RunStats>(EMPTY_STATS)
  const [runActive, setRunning] = useState(false)
  const [repeat, setRepeat] = useState<{ times: number; active: boolean; results: RepeatResult[] } | null>(null)
  const running = runActive || !!repeat?.active
  const [lastRun, setLastRun] = useState<{ status: string; ms: number; error?: string; runId: string; ref: string; checks?: number; partial?: boolean } | null>(null)
  const partialRun = useRef(false)
  const [detailRun, setDetailRun] = useState<string | null>(null)
  /** Posição do cursor no editor, para rodar o passo em que ele está. */
  const [cursorPos, setCursorPos] = useState<number | null>(null)
  /** Seletor melhor para cada passo frágil, por stepId (chega durante a execução). */
  const [hints, setHints] = useState<Record<string, { label: string; yaml: string }>>({})
  const [runRef, setRunRef] = useState<string | null>(null)
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [gesture, setGesture] = useState<Gesture | null>(null)
  const gestureId = useRef(0)
  const [newFlowWs, setNewFlowWs] = useState<string | null>(null)
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  const [toast, setToast] = useState<{ msg: string; kind: 'error' | 'info' } | null>(null)
  const botActive = useRef<Record<BotId, number>>({ reader: 0, tapper: 0, typer: 0, checker: 0 })
  const checkerFailAt = useRef(0)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const gutterRef = useRef<HTMLPreElement>(null)
  const logRef = useRef<HTMLDivElement>(null)
  const cursor = useRef<number | null>(null)
  const dirty = content !== saved

  const notify = useCallback((msg: string, kind: 'error' | 'info' = 'error') => {
    setToast({ msg, kind })
    setTimeout(() => setToast((t) => (t?.msg === msg ? null : t)), 4000)
  }, [])

  useEffect(() => {
    setTheme(document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
  }, [])

  const toggleTheme = () => {
    const next = theme === 'dark' ? 'light' : 'dark'
    document.documentElement.dataset.theme = next
    setTheme(next)
    try {
      localStorage.setItem('e2e-box:theme', next)
    } catch {}
  }

  useEffect(() => {
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 300)
    return () => clearInterval(t)
  }, [])

  const loadFlows = useCallback(async () => {
    const data = await api<{ workspaces: WorkspaceInfo[]; runs: RunSummary[] }>('/api/flows')
    setWorkspaces(data.workspaces)
    setRuns(data.runs)
    return data.workspaces
  }, [])

  const loadDevice = useCallback(async () => {
    const next = await api<DeviceInfo>('/api/device').catch(() => null)
    setDevice(next)
    return next
  }, [])

  const openFlow = useCallback(async (ref: string) => {
    try {
      const data = await api<{ content: string; error?: string }>(`/api/flows/file?ref=${encodeURIComponent(ref)}`)
      setSelected(ref)
      setContent(data.content)
      setSaved(data.content)
      setParseError(data.error)
      cursor.current = null
      setCursorPos(null)
      setTab('yaml')
      try {
        localStorage.setItem('e2e-box:flow', ref)
      } catch {}
    } catch (e) {
      notify((e as Error).message)
    }
  }, [notify])

  useEffect(() => {
    // Sem celular, procura mais rápido: ele volta sozinho quando reconectar.
    let alive = true
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      const next = await loadDevice()
      const serial = next?.serial ?? null
      if (lastOnline.current && !serial) notify(tRef.current.deviceDisconnected)
      else if (lastOnline.current === null && serial) notify(tRef.current.deviceConnected, 'info')
      lastOnline.current = serial
      if (alive) timer = setTimeout(poll, serial ? 6000 : 2000)
    }
    poll()
    loadFlows().then((ws) => {
      let ref: string | null = null
      try {
        ref = localStorage.getItem('e2e-box:flow')
      } catch {}
      const all = ws.flatMap((w) => w.files)
      const pick = all.find((f) => f.ref === ref) ?? all.find((f) => !f.subflow)
      if (pick) openFlow(pick.ref)
    })
    return () => {
      alive = false
      clearTimeout(timer)
    }
  }, [loadDevice, loadFlows, openFlow, notify])

  // Só troca ao escolher outro celular: se ele desconectar, a falha continua na tela.
  useEffect(() => {
    if (device?.serial) setWatched(device.serial)
  }, [device?.serial])

  // Eventos da execução (SSE) do celular aberto; cada um tem a sua execução.
  useEffect(() => {
    if (!watched) return
    setRunning(false)
    setRunRef(null)
    setStartedAt(null)
    setSteps([])
    setStats(EMPTY_STATS)
    setLastRun(null)
    setRepeat(null)
    setHints({})
    setLogs([])
    const es = new EventSource(`/api/events?serial=${encodeURIComponent(watched)}`)
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as RunEvent | { type: 'hello'; running: boolean }
      switch (e.type) {
        case 'hello':
          setRunning(e.running)
          break
        case 'run-start':
          setRunning(true)
          setRunRef(e.ref)
          partialRun.current = !!e.partial
          setStartedAt(e.at)
          setSteps(e.steps.map((label) => ({ label, status: 'pending' })))
          setStats({ ...EMPTY_STATS, steps: e.steps.length })
          setLastRun(null)
          setHints({})
          setRepeat((r) => (r?.active ? r : null))
          setLogs([{ at: e.at, level: 'info', msg: tRef.current.runningLog(e.ref, e.serial ?? ''), depth: 0 }])
          break
        case 'step-start':
          if (e.depth === 0) setSteps((s) => s.map((x, i) => (String(i) === e.stepId ? { ...x, status: 'running' } : x)))
          break
        case 'step-end':
          if (e.depth === 0) setSteps((s) => s.map((x, i) => (String(i) === e.stepId ? { ...x, status: e.status, ms: e.ms, error: e.error } : x)))
          break
        case 'stats':
          setStats(e.stats)
          break
        case 'hint':
          setHints((h) => ({ ...h, [e.stepId]: { label: e.label, yaml: e.yaml } }))
          break
        case 'repeat':
          setRepeat({ times: e.times, active: e.active, results: e.results })
          break
        case 'gesture':
          // Também acende o Tapper, mesmo antes da linha do adb chegar no log.
          botActive.current.tapper = Date.now()
          setGesture({ id: ++gestureId.current, kind: e.kind, x: e.x, y: e.y, x2: e.x2, y2: e.y2, ms: e.ms })
          break
        case 'log': {
          const bot = botFor(e.level, e.msg)
          if (bot) botActive.current[bot] = Date.now()
          if (e.level === 'fail') checkerFailAt.current = Date.now()
          setLogs((l) => {
            const next = [...l, { at: e.at, level: e.level, msg: e.msg, depth: e.depth ?? 0, manual: e.manual }]
            return next.length > 3000 ? next.slice(-2000) : next
          })
          break
        }
        case 'run-end':
          setRunning(false)
          setStats(e.stats)
          setLastRun({ status: e.status, ms: e.ms, error: e.error, runId: e.runId, ref: '', checks: e.stats.checksOk, partial: partialRun.current })
          setSteps((s) => s.map((x) => (x.status === 'running' ? { ...x, status: e.status === 'stopped' ? 'skipped' : 'failed' } : x)))
          setLogs((l) => [...l, { at: e.at, level: e.status === 'passed' ? 'ok' : 'fail', msg: `${tRef.current.runEndLog(e.status, e.stats.done, e.stats.steps, secs(e.ms))}${e.error ? ` · ${e.error}` : ''}`, depth: 0 }])
          loadFlows()
          break
      }
    }
    return () => es.close()
  }, [loadFlows, watched])

  useEffect(() => {
    const el = logRef.current
    if (el && el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight
  }, [logs, tab])

  const save = useCallback(async () => {
    if (!selected) return
    try {
      // Falta de `---` não é motivo para recusar: o arquivo já sai certo.
      const fixed = repairFlow(content)
      const res = await api<{ error?: string }>('/api/flows/file', { method: 'PUT', json: { ref: selected, content: fixed } })
      if (fixed !== content) setContent(fixed)
      setSaved(fixed)
      setParseError(res.error)
      const fragile = lintFlow(fixed).length
      if (!res.error && fragile) notify(t.savedFragile(fragile), 'info')
      return !res.error
    } catch (e) {
      notify((e as Error).message)
      return false
    }
  }, [selected, content, notify, t])

  const run = useCallback(async (times = 1, range?: { from: number; to?: number }) => {
    if (!selected || running) return
    if (dirty && !(await save())) return notify(t.fixYamlFirst)
    const vars = Object.fromEntries(
      env.split(/[\s,;]+/).filter((p) => p.includes('=')).map((p) => [p.slice(0, p.indexOf('=')), p.slice(p.indexOf('=') + 1)]),
    )
    try {
      await api('/api/run', { method: 'POST', json: { ref: selected, env: vars, times, ...range } })
      setTab('log')
    } catch (e) {
      notify((e as Error).message)
    }
  }, [selected, running, dirty, save, env, notify, t])

  const stop = () => api('/api/run', { method: 'DELETE' })

  const issues = useMemo(() => lintFlow(content, lang), [content, lang])
  const cursorStep = useMemo(() => (cursorPos == null ? null : stepAt(content, cursorPos)), [content, cursorPos])

  /** Leva o cursor do editor até o passo. */
  const goToIssue = (issue: FlowIssue) => {
    setTab('yaml')
    requestAnimationFrame(() => {
      const t = textareaRef.current
      if (!t) return
      t.focus()
      t.setSelectionRange(issue.start, issue.end)
      t.scrollTop = (issue.line - 3) * parseFloat(getComputedStyle(t).lineHeight || '20')
    })
  }

  /** Troca o passo pelo seletor sugerido, mantendo a indentação dele. */
  const applyHint = (issue: FlowIssue, yaml: string) => {
    setContent((c) => {
      const column = issue.start - (c.lastIndexOf('\n', issue.start - 1) + 1)
      const pad = ' '.repeat(Math.max(0, column - 2))
      const body = yaml.replace(/^- /, '').split('\n').map((l, i) => (i ? pad + l : l)).join('\n')
      return c.slice(0, issue.start) + body + c.slice(issue.end)
    })
  }

  /** Chamado pelo modal; erros sobem para o modal mostrar. */
  const createFlow = async (workspace: string, name: string) => {
    const { ref } = await api<{ ref: string }>('/api/flows/file', { method: 'POST', json: { workspace, name } })
    if (dirty) await save()
    setNewFlowWs(null)
    await loadFlows()
    await openFlow(ref)
    notify(t.flowCreated(name), 'info')
  }

  /** Insere um passo na linha depois do cursor (ou no fim). */
  const insert = useCallback((yaml: string) => {
    setTab('yaml')
    setContent((current) => {
      const c = withSeparator(current)
      // Passo nunca entra no cabeçalho, mesmo com o cursor lá em cima.
      const separator = c.match(/^---\s*$/m)
      const headerEnd = separator?.index != null ? separator.index + separator[0].length : 0
      const pos = Math.max(cursor.current ?? c.length, headerEnd)
      const lineEnd = c.indexOf('\n', pos)
      const at = lineEnd === -1 ? c.length : lineEnd + 1
      const before = c.slice(0, at)
      const sep = before.length && !before.endsWith('\n') ? '\n' : ''
      cursor.current = at + sep.length + yaml.length
      return before + sep + yaml + '\n' + c.slice(at)
    })
  }, [])

  // Avisa antes de fechar a aba com YAML não salvo.
  useEffect(() => {
    if (!dirty) return
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const stopRecording = useCallback(async () => {
    if (dirty && (await save())) notify(t.recordingSaved, 'info')
  }, [dirty, save, notify, t])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        save()
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault()
        run()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save, run])

  const lineCount = content.split('\n').length
  const visibleLogs = tab === 'adb' ? logs.filter((l) => l.level === 'adb') : logs
  const selectedFile = workspaces.flatMap((w) => w.files).find((f) => f.ref === selected)
  const battery = device?.info?.battery
  const elapsed = running && startedAt ? now - startedAt : lastRun?.ms
  const unchecked = !running && lastRun?.status === 'passed' && lastRun.checks === 0 && !lastRun.partial
  const status = running ? 'live' : unchecked ? 'warn' : lastRun?.status === 'passed' ? 'ok' : lastRun?.status === 'failed' ? 'bad' : ''
  const repeatFailures = Object.entries(
    (repeat?.results ?? []).reduce<Record<string, number>>((acc, r) => {
      if (r.status === 'failed') acc[r.step ?? t.unknownStep] = (acc[r.step ?? t.unknownStep] ?? 0) + 1
      return acc
    }, {}),
  )
  const failedStep = steps.find((s) => s.status === 'failed')

  const flowsByWs = useMemo(() => workspaces, [workspaces])

  return (
    <div className="app">
      <header className="header">
        <img className="logo" src="/icon.svg" alt="" aria-hidden="true" />
        <h1 className="brand">e2e-box</h1>
        <label className="device-field">
          <span>{t.device}</span>
          {device?.devices.length ? (
            <select
              className="device"
              value={device.serial ?? ''}
              onChange={async (e) => {
                await api('/api/device', { method: 'POST', json: { serial: e.target.value } }).catch((err) => notify(err.message))
                loadDevice()
              }}
            >
              {!device.serial && <option value="" disabled>{t.choose}</option>}
              {device.devices.map((d) => (
                <option key={d.serial} value={d.serial}>
                  {d.model ?? d.serial}{d.state !== 'device' ? ` (${d.state})` : ''}{device.runningSerials?.includes(d.serial) ? t.runningSuffix : ''}
                </option>
              ))}
            </select>
          ) : (
            <b>{t.noneConnected}</b>
          )}
        </label>
        {device?.info && <span className="meta">Android {device.info.android}, {device.info.transport ?? 'adb'}</span>}
        <div className="spacer" />
        {device?.busy && <span className="busy-note" title={device.busy}>{device.busy}</span>}
        {battery && (
          <span className="battery" title={battery.charging ? t.charging : t.onBattery}>
            <span className="cell">
              <span className="fill" style={{ display: 'block', width: `${battery.level}%`, background: battery.level < 20 ? 'var(--red)' : undefined }} />
            </span>
            {battery.charging ? '⚡' : ''}
            {battery.level}%
          </span>
        )}
        <div className="lang-switch" role="group" aria-label={t.language}>
          {LANGS.map((l) => (
            <button key={l.id} className={lang === l.id ? 'on' : ''} aria-pressed={lang === l.id} onClick={() => setLang(l.id)} title={l.name} lang={l.id}>
              {l.short}
            </button>
          ))}
        </div>
        <button className="icon-btn square" onClick={toggleTheme} title={theme === 'dark' ? t.useLight : t.useDark} aria-label={theme === 'dark' ? t.useLight : t.useDark}>
          {theme === 'dark' ? '☀' : '☾'}
        </button>
      </header>

      <section className="card run-strip" aria-label={t.currentRun}>
        <div className="run-line">
          <span className={`pill ${status}`}>
            <span className="dot" />
            {running ? t.pillRunning : lastRun ? (unchecked ? t.pillUnchecked : lastRun.status === 'passed' ? t.pillPassed : lastRun.status === 'stopped' ? t.pillStopped : t.pillFailed) : t.pillReady}
          </span>
          <div className="run-name">
            <b>{runRef ? runRef.split(':')[1] : t.noRunYet}</b>
            {runRef && <span>{secs(elapsed)}</span>}
          </div>
          <dl className="metrics">
            <div><dt>{t.mSteps}</dt><dd>{stats.done}<small>/{stats.steps || steps.length}</small></dd></div>
            <div><dt>{t.mTaps}</dt><dd>{stats.taps}</dd></div>
            <div><dt>{t.mInputs}</dt><dd>{stats.inputs}</dd></div>
            <div className={unchecked ? 'warn' : ''} title={unchecked ? t.noChecksTitle : t.checksTitle}><dt>{t.mChecks}</dt><dd>{stats.checksOk}</dd></div>
            <div className={stats.checksFailed || failedStep ? 'bad' : ''}><dt>{t.mFailures}</dt><dd>{stats.checksFailed + (failedStep && !stats.checksFailed ? 1 : 0)}</dd></div>
          </dl>
          <Bots active={botActive.current} failAt={checkerFailAt.current} now={now} />
        </div>
        <div className="progress" aria-hidden="true">
          {steps.map((s, i) => (
            <i key={i} className={s.status} title={s.label} />
          ))}
        </div>
        {lastRun?.error && !running && <p className="run-error" title={lastRun.error}>{lastRun.error}</p>}
      </section>

      <section className="body">
        <div className="col">
          <nav className="card sidebar" aria-label={t.flows}>
            {flowsByWs.map((ws) => {
              const flowButton = (f: FlowFile) => (
                <button
                  key={f.ref}
                  className={`flow ${f.subflow ? 'sub' : ''} ${f.ref === selected ? 'active' : ''}`}
                  aria-current={f.ref === selected ? 'true' : undefined}
                  onClick={() => (dirty && !window.confirm(t.discardChanges) ? null : openFlow(f.ref))}
                  title={f.rel}
                >
                  <span className={`sdot ${running && runRef === f.ref ? 'running' : dotClass(f.lastRun)}`} />
                  <span className="name">{f.subflow ? f.rel.replace(/^subflows\//, '').replace(/\.ya?ml$/i, '') : f.name}</span>
                </button>
              )
              const subflows = ws.files.filter((f) => f.subflow)
              return (
                <div key={ws.id} className="ws">
                  <div className="ws-title">
                    <h2 title={ws.appId}>{ws.name}</h2>
                    <button className="icon-btn" onClick={() => setNewFlowWs(ws.id)} title={t.newFlowIn(ws.name)} aria-label={t.newFlowIn(ws.name)}>+</button>
                  </div>
                  {ws.files.length === 0 && <p className="side-empty">{t.noFlows}</p>}
                  {ws.files.filter((f) => !f.subflow).map(flowButton)}
                  {subflows.length > 0 && <div className="ws-sub">{t.subflows}</div>}
                  {subflows.map(flowButton)}
                </div>
              )
            })}
          </nav>
          <div className="card runs">
            <div className="ws-title"><h2>{t.runs}</h2></div>
            {runs.length === 0 && <p className="side-empty">{t.noRuns}</p>}
            {runs.map((r) => (
              <button
                key={r.runId}
                className="run-row"
                title={r.error ?? t.viewRun(secs(r.ms))}
                onClick={() => setDetailRun(r.runId)}
              >
                <span className={`sdot ${dotClass(r)}`} />
                <span className="name">{r.ref.split(':')[1]?.replace(/\.ya?ml$/i, '')}{r.partial ? `, ${r.partial}` : ''}</span>
                <span className="when">{new Date(r.startedAt).toLocaleTimeString(t.locale, { hour: '2-digit', minute: '2-digit' })}</span>
              </button>
            ))}
          </div>
        </div>

        <div className="col">
          <div className="card main">
            <div className="tabs">
              <button className={`tab ${tab === 'yaml' ? 'on' : ''}`} onClick={() => setTab('yaml')}>
                {selectedFile ? selectedFile.rel.split('/').pop() : 'flow.yaml'}
                {dirty && <span className="dirty"> ●</span>}
              </button>
              <button className={`tab ${tab === 'log' ? 'on' : ''}`} onClick={() => setTab('log')}>Log</button>
              <button className={`tab ${tab === 'adb' ? 'on' : ''}`} onClick={() => setTab('adb')}>adb</button>
              <div className="right">
                {running ? (
                  <button className="btn stop" onClick={stop}>{t.stop}</button>
                ) : (
                  <>
                    <button className="btn" disabled={!selected || !device?.serial} onClick={() => run(5)} title={t.run5Title}>5x</button>
                    <button className="btn run" disabled={!selected || !device?.serial} onClick={() => run()} title={device?.serial ? 'Ctrl+Enter' : t.connectDevice}>{t.run}</button>
                  </>
                )}
              </div>
            </div>
            <div className="toolbar">
              {tab === 'yaml' ? (
                <>
                  <input className="env" aria-label={t.envLabel} placeholder={t.envPlaceholder} value={env} onChange={(e) => setEnv(e.target.value)} />
                  <button className="btn" disabled={!dirty} onClick={save} title="Ctrl+S">{t.save}</button>
                  {!running && cursorStep != null && (
                    <span className="toolbar-end">
                      <button className="btn" disabled={!device?.serial} onClick={() => run(1, { from: cursorStep, to: cursorStep })} title={t.runStepTitle}>{t.runStep(cursorStep + 1)}</button>
                      <button className="btn" disabled={!device?.serial} onClick={() => run(1, { from: cursorStep })} title={t.runFromTitle}>{t.runFrom}</button>
                    </span>
                  )}
                </>
              ) : (
                <>
                  <span className="toolbar-note">{t.lines(visibleLogs.length)}</span>
                  <span className="toolbar-end"><button className="btn" onClick={() => setLogs([])}>{t.clear}</button></span>
                </>
              )}
            </div>
            {tab === 'yaml' && selected && issues.length > 0 && (
              <details className="lint">
                <summary>⚠ {t.fragile(issues.length)}</summary>
                {issues.map((issue) => (
                  <div key={issue.start} className="lint-row">
                    <button className="lint-line" onClick={() => goToIssue(issue)} title={t.goToStep}>L{issue.line}</button>
                    <span className="lint-msg">{issue.message}</span>
                    {hints[issue.path] ? (
                      <button className="chip" onClick={() => applyHint(issue, hints[issue.path].yaml)} title={hints[issue.path].yaml}>{t.replaceWith(hints[issue.path].label)}</button>
                    ) : issue.canSuggest ? (
                      <span className="lint-tip">{t.runForHint}</span>
                    ) : null}
                  </div>
                ))}
              </details>
            )}
            {tab === 'yaml' ? (
              selected ? (
                <div className="editor">
                  <pre className="gutter" ref={gutterRef}>
                    {Array.from({ length: lineCount }, (_, i) => i + 1).join('\n')}
                  </pre>
                  <textarea
                    ref={textareaRef}
                    aria-label={t.yamlContent}
                    value={content}
                    spellCheck={false}
                    onChange={(e) => setContent(e.target.value)}
                    onSelect={(e) => {
                      cursor.current = e.currentTarget.selectionEnd
                      setCursorPos(e.currentTarget.selectionEnd)
                    }}
                    onScroll={(e) => {
                      if (gutterRef.current) gutterRef.current.scrollTop = e.currentTarget.scrollTop
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Tab') {
                        e.preventDefault()
                        const t = e.currentTarget
                        const { selectionStart: s, selectionEnd: en } = t
                        setContent(content.slice(0, s) + '  ' + content.slice(en))
                        requestAnimationFrame(() => t.setSelectionRange(s + 2, s + 2))
                      }
                    }}
                  />
                  {parseError && <div className="parse-error">{t.invalidYaml} {parseError}</div>}
                </div>
              ) : (
                <div className="empty">{t.pickFlow}</div>
              )
            ) : (
              <div className="log" ref={logRef}>
                {visibleLogs.length === 0 && <div className="empty">{t.noLog}</div>}
                {visibleLogs.map((l, i) => (
                  <div key={i} className={`ln ${l.level} ${l.manual ? 'manual' : ''}`}>
                    <span className="t">{time(l.at)}</span>
                    <span className="bar" />
                    <span className="m" style={{ paddingLeft: l.depth * 14 }}>
                      {l.manual ? t.you : ''}
                      {l.msg}
                    </span>
                  </div>
                ))}
                {running && <span className="cursor" />}
              </div>
            )}
          </div>
          <div className="card queue">
            <div className="queue-head">
              <span>{t.queue}</span>
              <span>
                {steps.filter((s) => s.status === 'passed').length}/{steps.length}
              </span>
            </div>
            {repeat && (
              <div className="repeat-bar">
                <div className="repeat-sum">
                  <b>{repeat.active ? t.repeatRunning(Math.min(repeat.results.length + 1, repeat.times), repeat.times) : t.repeatRounds(repeat.results.length, repeat.times)}</b>
                  <span>{t.repeatSummary(repeat.results.filter((r) => r.status === 'passed').length, repeat.results.filter((r) => r.status === 'failed').length)}</span>
                  <span className="repeat-dots">
                    {repeat.results.map((r, i) => (
                      <span key={i} className={`sdot ${r.status}`} title={r.error ?? secs(r.ms)} />
                    ))}
                  </span>
                </div>
                {repeatFailures.map(([step, count]) => (
                  <div key={step} className="repeat-fail" title={step}>{t.failedAt(count, step)}</div>
                ))}
              </div>
            )}
            <div className="queue-list">
              {steps.length === 0 && <div className="q"><span className="label" style={{ color: 'var(--muted)' }}>{t.noSteps}</span></div>}
              {steps.map((s, i) => (
                <div key={i} className={`q ${s.status}`}>
                  <span className={`check ${s.status}`}>{s.status === 'passed' ? '✓' : s.status === 'failed' ? '✕' : s.status === 'warned' || s.status === 'skipped' ? '–' : ''}</span>
                  <span className="n">{i + 1}</span>
                  <span className="label">{s.label}</span>
                  {s.error && <span className="err" title={s.error}>{s.error}</span>}
                  <span className="ms">{secs(s.ms)}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="col">
          <Phone serial={device?.serial ?? null} running={running} flowRef={selected} gesture={gesture} onStopRecording={stopRecording} onInsert={insert} onError={(m) => notify(m)} />
        </div>
      </section>

      {newFlowWs && (
        <NewFlowModal
          workspaces={workspaces}
          initialWorkspace={newFlowWs}
          unsavedFlow={dirty ? selectedFile?.rel : undefined}
          onClose={() => setNewFlowWs(null)}
          onCreate={createFlow}
        />
      )}
      {detailRun && <RunDetail runId={detailRun} onClose={() => setDetailRun(null)} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.msg}</div>}
    </div>
  )
}
