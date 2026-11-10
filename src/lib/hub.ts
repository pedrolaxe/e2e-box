import fs from 'node:fs'
import path from 'node:path'
import { Adb } from './adb'
import { loadConfig } from './config'
import { runFlow, type RepeatResult, type RunEvent } from './engine'
import { resolveRef } from './flows'
import { acquireLock, releaseLock } from './lock'

export interface RunSummary {
  runId: string
  ref: string
  status: 'running' | 'passed' | 'failed' | 'stopped'
  startedAt: number
  ms?: number
  error?: string
  serial?: string
  /** Quantos passos conferiram algo; 0 em fluxo que passou merece aviso. */
  checks?: number
  /** Só um trecho do fluxo ("passo 3", "do passo 3 em diante"): não conta como resultado do fluxo. */
  partial?: string
}

export interface StartOptions {
  times?: number
  from?: number
  to?: number
}

type Listener = (e: RunEvent) => void

interface DeviceRun {
  summary: RunSummary
  controller: AbortController
  events: RunEvent[]
}

interface RepeatState {
  ref: string
  times: number
  active: boolean
  results: RepeatResult[]
}

interface HubState {
  /** Device aberto no painel; cada device tem a sua execução. */
  serial?: string
  /** Foi escolhido ou já rodou fluxo: se sair do adb, o painel espera ele voltar em vez de pular para outro. */
  pinned?: boolean
  runs: Map<string, DeviceRun>
  repeats: Map<string, RepeatState>
  manual: RunEvent[]
  listeners: Set<Listener>
}

/**
 * Device escolhido, execução de cada device e quem está ouvindo os eventos.
 * Só o estado fica em globalThis (sobrevive ao hot reload do dev); os métodos são sempre os do
 * código atual. Guardar a instância inteira fazia o `start` seguir chamando o engine antigo.
 */
class Hub {
  constructor(private s: HubState) {}

  get serial() {
    return this.s.serial
  }
  set serial(v: string | undefined) {
    this.s.serial = v
  }

  /** Recebe só os eventos de um device. */
  subscribe(serial: string, fn: Listener) {
    const listener: Listener = (e) => {
      if (e.serial === serial) fn(e)
    }
    this.s.listeners.add(listener)
    return () => this.s.listeners.delete(listener)
  }

  /** Eventos para quem conecta agora (repete a execução atual/última do device). */
  replay(serial: string): RunEvent[] {
    const repeat = this.s.repeats.get(serial)
    const progress: RunEvent[] = repeat ? [{ type: 'repeat', ...repeat, results: [...repeat.results], at: Date.now(), serial }] : []
    return [...(this.s.runs.get(serial)?.events ?? []), ...progress, ...this.s.manual.filter((e) => e.serial === serial).slice(-200)]
  }

  emit(e: RunEvent, serial = this.serial) {
    const tagged = { ...e, serial }
    if (e.type !== 'gesture' && e.type !== 'repeat') {
      // Gesto é só animação ao vivo e a repetição tem replay próprio: nenhum entra no relatório.
      if (e.type === 'log' && e.manual) {
        this.s.manual.push(tagged)
        if (this.s.manual.length > 500) this.s.manual.splice(0, 250)
      } else if (serial) {
        this.s.runs.get(serial)?.events.push(tagged)
      }
    }
    for (const l of this.s.listeners) l(tagged)
  }

  adb(onCommand?: (cmd: string) => void) {
    return new Adb(this.serial, onCommand)
  }

  /** Adb para ações manuais (botões, gravador): loga como manual. */
  manualAdb() {
    return this.adb((cmd) => this.emit({ type: 'log', level: 'adb', msg: cmd, at: Date.now(), manual: true }))
  }

  choose(serial: string) {
    this.s.serial = serial
    this.s.pinned = true
  }

  /** Device aberto, se estiver disponível. */
  async ensureSerial() {
    const devices = await new Adb().devices()
    if (this.serial && devices.some((d) => d.serial === this.serial && d.state === 'device')) return this.serial
    if (this.s.pinned) return undefined
    this.serial = devices.find((d) => d.state === 'device')?.serial
    return this.serial
  }

  isRunning(serial: string | undefined) {
    if (!serial) return false
    return this.s.runs.get(serial)?.summary.status === 'running' || !!this.s.repeats.get(serial)?.active
  }

  /** O device aberto no painel está rodando um fluxo. */
  get running() {
    return this.isRunning(this.serial)
  }

  get runningSerials() {
    return [...this.s.runs.keys()].filter((s) => this.isRunning(s))
  }

  private newRunId(runsDir: string) {
    const base = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
    const taken = new Set([...this.s.runs.values()].map((r) => r.summary.runId))
    let id = base
    for (let n = 2; taken.has(id) || fs.existsSync(path.join(runsDir, id)); n++) id = `${base}-${n}`
    return id
  }

  /** Roda `times` vezes em sequência, com o celular travado até a última terminar. */
  async start(ref: string, env: Record<string, string> = {}, { times = 1, from, to }: StartOptions = {}) {
    const serial = await this.ensureSerial()
    if (!serial) throw new Error(this.serial ? `Celular ${this.serial} desconectado` : 'Nenhum device Android conectado (adb devices vazio)')
    if (this.isRunning(serial)) throw new Error('Já tem um fluxo rodando neste celular')
    resolveRef(ref)
    acquireLock(serial, 'painel', ref)
    this.s.pinned = true
    this.s.manual = this.s.manual.filter((e) => e.serial !== serial)

    const repeat: RepeatState | undefined = times > 1 ? { ref, times, active: true, results: [] } : undefined
    if (repeat) {
      this.s.repeats.set(serial, repeat)
      this.emitRepeat(serial, repeat)
    } else {
      this.s.repeats.delete(serial)
    }
    const first = this.launch(serial, ref, env, { from, to })
    void (async () => {
      try {
        let run = first
        for (let i = 1; ; i++) {
          await run.done
          if (!repeat) return
          repeat.results.push(resultOf(run.run))
          this.emitRepeat(serial, repeat)
          const stopped = !repeat.active || run.run.summary.status === 'stopped'
          if (i >= times || stopped || (await new Adb(serial).goneError())) return
          run = this.launch(serial, ref, env)
        }
      } finally {
        releaseLock(serial)
        if (repeat) {
          repeat.active = false
          this.emitRepeat(serial, repeat)
        }
      }
    })()
    return first.run.summary
  }

  private emitRepeat(serial: string, r: RepeatState) {
    this.emit({ type: 'repeat', ...r, results: [...r.results], at: Date.now() }, serial)
  }

  /** Uma execução: `done` resolve quando o relatório estiver salvo. */
  private launch(serial: string, ref: string, env: Record<string, string>, { from, to }: StartOptions = {}) {
    const { ws, file } = resolveRef(ref)
    const cfg = loadConfig()
    const runId = this.newRunId(cfg.runsDir)
    const artifactsDir = path.join(cfg.runsDir, runId)
    const controller = new AbortController()
    const partial = from == null ? undefined : from === to ? `passo ${from + 1}` : `do passo ${from + 1} em diante`
    const summary: RunSummary = { runId, ref, status: 'running', startedAt: Date.now(), serial, partial }
    const run: DeviceRun = { summary, controller, events: [] }
    this.s.runs.set(serial, run)

    const adb = new Adb(serial, (cmd) => this.emit({ type: 'log', level: 'adb', msg: cmd, at: Date.now() }, serial))
    const done = runFlow({
      runId, ref, file, adb, artifactsDir,
      emit: (e) => this.emit(e, serial),
      signal: controller.signal,
      env: { ...(ws.env ?? {}), ...env },
      appId: ws.appId,
      rootDir: ws.dir,
      lookupTimeoutMs: cfg.lookupTimeoutMs,
      from,
      to,
      stepShots: true,
    })
      .catch((e) => {
        this.emit({ type: 'run-end', runId, status: 'failed', ms: Date.now() - summary.startedAt, error: (e as Error).message, stats: { steps: 0, done: 0, taps: 0, inputs: 0, checksOk: 0, checksFailed: 0 }, artifactsDir, at: Date.now() }, serial)
      })
      .finally(() => {
        const end = run.events.findLast((e) => e.type === 'run-end')
        if (end?.type === 'run-end') Object.assign(summary, { status: end.status, ms: end.ms, error: end.error, checks: end.stats.checksOk })
        else summary.status = 'failed'
        saveRun(cfg.runsDir, summary, run.events)
      })
    return { run, done }
  }

  stop() {
    if (!this.serial) return
    const repeat = this.s.repeats.get(this.serial)
    if (repeat) repeat.active = false
    this.s.runs.get(this.serial)?.controller.abort()
  }
}

/** Resultado de uma volta do "rodar N vezes", com o passo que falhou. */
function resultOf(run: DeviceRun): RepeatResult {
  const { status, ms, error } = run.summary
  const result: RepeatResult = { status: status === 'running' ? 'failed' : status, ms: ms ?? 0, error }
  const failed = run.events.findLast((e) => e.type === 'step-end' && e.status === 'failed' && e.depth === 0)
  const start = run.events.find((e) => e.type === 'run-start')
  if (status === 'failed') {
    const index = failed?.type === 'step-end' ? Number(failed.stepId) : NaN
    result.step = start?.type === 'run-start' && Number.isInteger(index) ? start.steps[index] : 'pré-condição'
  }
  return result
}

const KEEP_STEP_SHOTS = 30

function saveRun(runsDir: string, summary: RunSummary, events: RunEvent[]) {
  const dir = path.join(runsDir, summary.runId)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify({ ...summary, events }, null, 2))
  const indexFile = path.join(runsDir, 'index.json')
  const index: RunSummary[] = fs.existsSync(indexFile) ? JSON.parse(fs.readFileSync(indexFile, 'utf8')) : []
  index.unshift(summary)
  fs.writeFileSync(indexFile, JSON.stringify(index.slice(0, 200), null, 2))
  // Um print por passo pesa: só as execuções recentes guardam (a falha.png fica em todas).
  for (const old of index.slice(KEEP_STEP_SHOTS)) {
    const oldDir = path.join(runsDir, old.runId)
    if (!fs.existsSync(oldDir)) continue
    for (const f of fs.readdirSync(oldDir)) if (/^step-.*\.png$/.test(f)) fs.rmSync(path.join(oldDir, f), { force: true })
  }
}

export function listRuns(): RunSummary[] {
  const file = path.join(loadConfig().runsDir, 'index.json')
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : []
}

const g = globalThis as unknown as { __e2eBoxHubState?: HubState }
const state = (g.__e2eBoxHubState ??= { runs: new Map(), repeats: new Map(), manual: [], listeners: new Set() })
// Estado de antes de existir uma execução por device (hot reload).
state.runs ??= new Map()
state.repeats ??= new Map()
export const hub = new Hub(state)
