import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { Adb, DeviceGoneError } from './adb'
import { commandLabel, normalizeCommand, readFlowFile, type FlowHeader } from './flows'
import { center, describeSelector, findAll, nodeAt, parseHierarchy, rotationOf, visibleFraction, type Selector, type UiNode } from './hierarchy'
import { isRootId, lintFlow } from './lint'
import { rawToPng } from './shots'
import { suggest } from './suggest'

export type LogLevel = 'adb' | 'info' | 'ok' | 'fail' | 'warn' | 'error' | 'step'

export type GestureKind = 'tap' | 'double' | 'long' | 'swipe'

export type StepStatus = 'pending' | 'running' | 'passed' | 'failed' | 'skipped' | 'warned'

export interface RunStats {
  steps: number
  done: number
  taps: number
  inputs: number
  checksOk: number
  checksFailed: number
}

export interface RepeatResult {
  status: 'passed' | 'failed' | 'stopped'
  ms: number
  error?: string
  /** Passo em que falhou. */
  step?: string
}

/** `serial`: o device do evento (o painel marca, porque roda um fluxo por device). */
export type RunEvent = { serial?: string } & (
  | { type: 'run-start'; runId: string; ref: string; file: string; steps: string[]; partial?: boolean; at: number }
  | { type: 'step-start'; stepId: string; depth: number; label: string; at: number }
  | { type: 'step-end'; stepId: string; depth: number; status: StepStatus; ms: number; error?: string; /** print da tela depois do passo */ shot?: string; at: number }
  | { type: 'log'; level: LogLevel; msg: string; depth?: number; at: number; manual?: boolean }
  | { type: 'stats'; stats: RunStats; at: number }
  /** Seletor melhor para um passo frágil, lido na tela logo antes do toque. */
  | { type: 'hint'; stepId: string; label: string; yaml: string; at: number }
  /** Progresso do "rodar N vezes". */
  | { type: 'repeat'; ref: string; times: number; active: boolean; results: RepeatResult[]; at: number }
  /** Toque/arraste no device, em pixels da tela (o espelho anima em cima). */
  | { type: 'gesture'; kind: GestureKind; x: number; y: number; x2?: number; y2?: number; ms?: number; at: number; manual?: boolean }
  | { type: 'run-end'; runId: string; status: 'passed' | 'failed' | 'stopped'; ms: number; error?: string; stats: RunStats; artifactsDir: string; at: number }
)

export interface RunOptions {
  runId: string
  ref: string
  file: string
  adb: Adb
  emit: (e: RunEvent) => void
  signal: AbortSignal
  artifactsDir: string
  env?: Record<string, string>
  appId?: string
  lookupTimeoutMs?: number
  /** Pasta do workspace: subfluxos (runFlow file) não saem dela. Padrão: pasta do fluxo. */
  rootDir?: string
  /** Roda só esse trecho (índices dos passos), na tela em que o celular está: sem onFlowStart nem onFlowComplete. */
  from?: number
  to?: number
  /** Guarda um print depois de cada passo (a tela de execução mostra). */
  stepShots?: boolean
}

class FlowFailure extends Error {}
class Stopped extends Error {}

interface Ctx {
  adb: Adb
  emit: (e: RunEvent) => void
  signal: AbortSignal
  appId?: string
  env: Record<string, string>
  screen: { w: number; h: number }
  /** Tela na orientação natural (a rotação do dump diz se largura e altura trocaram). */
  natural: { w: number; h: number }
  artifactsDir: string
  lookup: number
  stats: RunStats
  copiedText?: string
  /** Tela logo antes da última ação (para o settle saber se o app reagiu). */
  before?: string
  file: string
  /** Fluxo que o usuário mandou rodar: sugestões de passo só valem para o que está no editor. */
  mainFile: string
  /** Trecho a rodar; fora dele os passos ficam como pulados. */
  range?: { from: number; to: number }
  stepShots: boolean
  /** Prints em andamento: terminam em segundo plano para não atrasar os passos. */
  shots: Promise<unknown>[]
  lastShot?: string
  adbKeyboard?: boolean
  rootDir: string
}

const now = () => Date.now()

function sleep(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) return reject(new Stopped('parado'))
    const t = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => {
      clearTimeout(t)
      reject(new Stopped('parado'))
    }, { once: true })
  })
}

function log(ctx: Ctx, level: LogLevel, msg: string, depth = 0) {
  ctx.emit({ type: 'log', level, msg, depth, at: now() })
}

function pushStats(ctx: Ctx) {
  ctx.emit({ type: 'stats', stats: { ...ctx.stats }, at: now() })
}

// ---------- interpolação de ${VAR} ----------

function interpolate<T>(value: T, ctx: Ctx): T {
  if (typeof value === 'string') {
    return value.replace(/\$\{([^}]+)\}/g, (all, expr: string) => {
      const key = expr.trim()
      if (key === 'maestro.copiedText') return ctx.copiedText ?? ''
      return key in ctx.env ? ctx.env[key] : all
    }) as T
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, ctx)) as T
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, ctx)])) as T
  }
  return value
}

// ---------- tela ----------

function setScreen(ctx: Ctx, screen: { w: number; h: number }) {
  if (screen.w !== ctx.screen.w || screen.h !== ctx.screen.h) log(ctx, 'info', `tela girou: ${screen.w}x${screen.h}`)
  ctx.screen = screen
}

/** Lê a tela e acompanha a rotação: pontos em % e elementos "dentro da tela" dependem dela. */
async function readXml(ctx: Ctx, quiet = false): Promise<string> {
  const xml = await ctx.adb.dumpHierarchy({ quiet })
  const rotation = rotationOf(xml)
  if (rotation != null) {
    const { w, h } = ctx.natural
    setScreen(ctx, rotation % 2 ? { w: h, h: w } : { w, h })
  }
  return xml
}

/** Antes de cada passo: o usuário ou o app pode ter girado a tela. */
async function refreshScreen(ctx: Ctx) {
  try {
    if (ctx.adb.fast) await readXml(ctx, true)
    else setScreen(ctx, await ctx.adb.screenSize())
  } catch (e) {
    if (e instanceof DeviceGoneError) throw e
    // Outra falha de leitura aparece no próprio passo, se ele precisar da tela.
  }
}

function toSelector(arg: unknown): Selector {
  if (typeof arg === 'string' || typeof arg === 'number') return { text: String(arg) }
  if (!arg || typeof arg !== 'object') throw new FlowFailure('Seletor vazio')
  const a = arg as Record<string, unknown>
  const sel: Selector = {}
  if (a.text != null) sel.text = String(a.text)
  if (a.id != null) sel.id = String(a.id)
  if (a.index != null) sel.index = Number(a.index)
  for (const k of ['enabled', 'checked', 'focused', 'selected'] as const) if (a[k] != null) sel[k] = Boolean(a[k])
  for (const k of ['below', 'above', 'leftOf', 'rightOf', 'childOf', 'containsChild'] as const) if (a[k] != null) sel[k] = toSelector(a[k])
  if (a.element != null) Object.assign(sel, toSelector(a.element))
  return sel
}

async function findNow(ctx: Ctx, sel: Selector, quiet = false): Promise<UiNode | undefined> {
  const nodes = parseHierarchy(await readXml(ctx, quiet))
  return findAll(nodes, sel, ctx.screen)[sel.index ?? 0]
}

/**
 * Espera a tela parar de mudar: com o agente, lê a tela até duas leituras seguidas iguais
 * (no máximo maxMs). Sem o agente cada leitura custa segundos, então faz a pausa fixa de antes.
 */
/** Guarda a tela antes de uma ação: o settle usa para saber se o app já reagiu. */
async function markBefore(ctx: Ctx) {
  ctx.before = ctx.adb.fast ? await ctx.adb.dumpHierarchy({ quiet: true }).catch(() => undefined) : undefined
}

/** Máximo de espera pela splash do Android sair da frente ao abrir o app. */
const SPLASH_MS = 30000
/** Tela sem mudar por esse tempo = estável. */
const QUIET_MS = 300
/** Sem nenhuma mudança desde a ação: espera até isso pelo app reagir antes de seguir. */
const REACTION_MS = 1000

async function settle(ctx: Ctx, fallbackMs: number, maxMs = 2500) {
  const before = ctx.before
  ctx.before = undefined
  if (!ctx.adb.fast) return sleep(fallbackMs, ctx.signal)
  // Duas leituras iguais logo depois do toque não bastam: o app (navegação do React Native)
  // pode ainda nem ter começado a reagir. Compara com a tela de antes da ação.
  const start = now()
  let last = await ctx.adb.dumpHierarchy({ quiet: true })
  let changed = before === undefined || last !== before
  let quietSince = now()
  while (now() - start < maxMs) {
    if (changed && now() - quietSince >= QUIET_MS) return
    if (!changed && now() - start >= REACTION_MS) return
    await sleep(100, ctx.signal)
    const xml = await ctx.adb.dumpHierarchy({ quiet: true })
    if (xml !== last) {
      last = xml
      changed = true
      quietSince = now()
    }
  }
}

async function waitVisible(ctx: Ctx, sel: Selector, timeoutMs: number): Promise<UiNode | undefined> {
  const deadline = now() + timeoutMs
  let first = true
  do {
    const n = await findNow(ctx, sel, !first)
    first = false
    if (n) return n
    if (now() >= deadline) break
    await sleep(ctx.adb.fast ? 100 : 250, ctx.signal)
  } while (now() < deadline)
  return undefined
}

async function waitNotVisible(ctx: Ctx, sel: Selector, timeoutMs: number): Promise<boolean> {
  const deadline = now() + timeoutMs
  let first = true
  do {
    if (!(await findNow(ctx, sel, !first))) return true
    first = false
    await sleep(ctx.adb.fast ? 100 : 250, ctx.signal)
  } while (now() < deadline)
  return false
}

function parsePoint(p: unknown, ctx: Ctx): { x: number; y: number } {
  const [xs, ys] = String(p).split(',').map((s) => s.trim())
  const conv = (s: string, total: number) => (s.endsWith('%') ? Math.round((parseFloat(s) / 100) * total) : Math.round(parseFloat(s)))
  const x = conv(xs, ctx.screen.w)
  const y = conv(ys, ctx.screen.h)
  if (!Number.isFinite(x) || !Number.isFinite(y)) throw new FlowFailure(`Ponto inválido: ${p}`)
  return { x, y }
}

/** Centro da parte do elemento que está dentro da tela (itens cortados num carrossel). */
function visibleCenter(node: UiNode, ctx: Ctx) {
  const b = node.bounds
  return center({ x1: Math.max(0, b.x1), y1: Math.max(0, b.y1), x2: Math.min(ctx.screen.w - 1, b.x2), y2: Math.min(ctx.screen.h - 1, b.y2) })
}

/** Passo frágil: lê o elemento sob o toque e sugere um seletor que não dependa da posição. */
async function hintFor(ctx: Ctx, stepId: string, depth: number, point: { x: number; y: number }) {
  try {
    const nodes = parseHierarchy(await readXml(ctx, true))
    const { suggestions } = suggest(nodes, nodeAt(nodes, point.x, point.y), point.x, point.y, ctx.screen)
    const best = suggestions.find((s) => s.yaml.startsWith('- tapOn') && !s.yaml.includes('point:'))
    if (!best) return
    log(ctx, 'warn', `passo frágil: troque por ${best.label}`, depth)
    if (ctx.file === ctx.mainFile) ctx.emit({ type: 'hint', stepId, label: best.label, yaml: best.yaml, at: now() })
  } catch (e) {
    if (e instanceof DeviceGoneError) throw e
  }
}

const clamp = (v: number, max: number) => Math.round(Math.min(max * 0.95, Math.max(max * 0.05, v)))

async function tap(ctx: Ctx, x: number, y: number, kind: 'tap' | 'double' | 'long' = 'tap') {
  await markBefore(ctx)
  ctx.stats.taps++
  ctx.emit({ type: 'gesture', kind, x, y, at: now() })
  if (kind === 'long') await ctx.adb.shell(`input swipe ${x} ${y} ${x} ${y} 1000`)
  else await ctx.adb.shell(`input tap ${x} ${y}`)
  if (kind === 'double') await ctx.adb.shell(`input tap ${x} ${y}`)
  pushStats(ctx)
}

async function swipe(ctx: Ctx, from: { x: number; y: number }, to: { x: number; y: number }, ms = 400) {
  await markBefore(ctx)
  ctx.emit({ type: 'gesture', kind: 'swipe', x: from.x, y: from.y, x2: to.x, y2: to.y, ms, at: now() })
  await ctx.adb.shell(`input swipe ${from.x} ${from.y} ${to.x} ${to.y} ${ms}`)
}

const DIRECTIONS: Record<string, [string, string]> = {
  UP: ['50%,80%', '50%,20%'],
  DOWN: ['50%,20%', '50%,80%'],
  LEFT: ['90%,50%', '10%,50%'],
  RIGHT: ['10%,50%', '90%,50%'],
}

// ---------- teclado ----------

const KEYS: Record<string, number> = {
  enter: 66, back: 4, home: 3, backspace: 67, delete: 67, tab: 61, space: 62, escape: 111,
  'volume up': 24, 'volume down': 25, power: 26, 'lock': 26, 'remote dpad up': 19, 'remote dpad down': 20,
  'remote dpad left': 21, 'remote dpad right': 22, 'remote dpad center': 23, search: 84, 'app switch': 187,
}

function shellQuote(s: string) {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Digita no campo focado. `hidden`: o texto veio de variável (ex.: ${SENHA}) e não aparece
 * no log nem no report.json, só "•••".
 */
async function typeText(ctx: Ctx, text: string, hidden = false, counted = false): Promise<void> {
  if (!hidden) return typeTextRaw(ctx, text, hidden, counted)
  try {
    await typeTextRaw(ctx, text, hidden, counted)
  } catch (e) {
    // A mensagem do adb traz o comando inteiro (com a senha): devolve uma sem o texto.
    if (e instanceof Stopped || e instanceof DeviceGoneError) throw e
    throw new FlowFailure('falhou ao digitar texto oculto (variável)')
  }
}

async function typeTextRaw(ctx: Ctx, text: string, hidden: boolean, counted: boolean): Promise<void> {
  if (!counted) {
    ctx.stats.inputs++
    pushStats(ctx)
  }
  const shown = (s: string) => (hidden ? '•'.repeat(Math.min(8, s.length || 3)) : s)
  const shell = (cmd: string, logAs: string) => {
    ctx.adb.onCommand?.(`adb shell ${logAs}`)
    return ctx.adb.shell(cmd, { quiet: true })
  }
  if (/^[\x20-\x7e]*$/.test(text)) {
    for (let i = 0; i < text.length; i += 40) {
      const chunk = text.slice(i, i + 40)
      await shell(`input text ${shellQuote(chunk.replace(/ /g, '%s'))}`, `input text ${hidden ? shown(chunk) : shellQuote(chunk.replace(/ /g, '%s'))}`)
    }
    return
  }
  // Acento e outros caracteres: o agente escreve direto no campo focado.
  if (await ctx.adb.setText(text)) {
    ctx.adb.onCommand?.(`adb agent settext ${shown(text)}`)
    return
  }
  if (ctx.adbKeyboard === undefined) {
    const ime = await ctx.adb.shell('settings get secure default_input_method', { quiet: true }).catch(() => '')
    ctx.adbKeyboard = ime.includes('adbkeyboard')
  }
  if (ctx.adbKeyboard) {
    const b64 = Buffer.from(text, 'utf8').toString('base64')
    await shell(`am broadcast -a ADB_INPUT_B64 --es msg ${b64}`, `am broadcast -a ADB_INPUT_B64 --es msg ${hidden ? shown(b64) : b64}`)
    return
  }
  const ascii = text.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^\x20-\x7e]/g, '')
  log(ctx, 'warn', `sem o agente, o "input text" do adb não digita acentos: enviando "${shown(ascii)}"`)
  await typeTextRaw(ctx, ascii, hidden, true)
}

// ---------- evidências ----------

async function saveScreenshot(ctx: Ctx, name: string) {
  fs.mkdirSync(ctx.artifactsDir, { recursive: true })
  // Sempre dentro da pasta da execução: só o nome do arquivo, sem pastas nem "..".
  const safe = path.basename(name).replace(/[^\w.-]/g, '_').replace(/^\.+/, '') || 'screenshot'
  const file = path.join(ctx.artifactsDir, safe.endsWith('.png') ? safe : `${safe}.png`)
  fs.writeFileSync(file, await ctx.adb.screencap(false))
  return file
}

/** Comandos que só leem a tela: o print do passo anterior continua valendo. */
const READ_ONLY = new Set(['assertVisible', 'assertNotVisible', 'assertTrue', 'copyTextFrom'])

/**
 * Print da tela depois do passo. Espera a captura, para ser mesmo deste passo (em segundo plano ela
 * pegava o efeito do seguinte); a transferência e o PNG ficam para depois, sem atrasar o fluxo.
 */
async function captureStep(ctx: Ctx, stepId: string, command: string): Promise<string | undefined> {
  if (!ctx.stepShots) return undefined
  if (READ_ONLY.has(command) && ctx.lastShot) return ctx.lastShot
  const name = `step-${stepId}.png`
  const remote = `/data/local/tmp/e2e-box-shot-${stepId}`
  try {
    await ctx.adb.shell(`screencap ${remote}`, { quiet: true })
  } catch {
    return undefined // celular fora do ar aparece no próximo passo
  }
  ctx.lastShot = name
  ctx.shots.push(
    ctx.adb
      .run(['exec-out', 'cat', remote], { quiet: true })
      .then(async (raw) => {
        await ctx.adb.shell(`rm -f ${remote}`, { quiet: true })
        fs.mkdirSync(ctx.artifactsDir, { recursive: true })
        fs.writeFileSync(path.join(ctx.artifactsDir, name), await rawToPng(raw))
      })
      .catch(() => undefined),
  )
  return name
}

// ---------- comandos ----------

const UNSUPPORTED = new Set([
  'evalScript', 'runScript', 'setLocation', 'travel', 'addMedia', 'startRecording', 'stopRecording',
  'setAirplaneMode', 'toggleAirplaneMode', 'assertWithAI', 'assertNoDefectsWithAI', 'extractTextWithAI', 'clearKeychain',
])

/** appId vai para o shell do device (am/pm/monkey): só aceita nome de pacote Android. */
function checkAppId(appId: string | undefined): string {
  if (!appId) throw new FlowFailure('Sem appId (defina `appId:` no topo do fluxo)')
  if (!/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(appId)) throw new FlowFailure(`appId inválido: ${appId}`)
  return appId
}

function randomText(kind: string, len = 8) {
  const letters = 'abcdefghijklmnopqrstuvwxyz'
  const pick = (chars: string, n: number) => Array.from({ length: n }, () => chars[crypto.randomInt(chars.length)]).join('')
  switch (kind) {
    case 'inputRandomEmail': return `e2e.${pick(letters, 6)}@example.com`
    case 'inputRandomNumber': return pick('0123456789', len)
    case 'inputRandomPersonName': return `Teste ${pick(letters, 1).toUpperCase()}${pick(letters, 5)}`
    default: return pick(letters, len)
  }
}

async function checkCondition(ctx: Ctx, when: Record<string, unknown> | undefined): Promise<boolean> {
  if (!when) return true
  if (when.platform != null && String(when.platform).toLowerCase() !== 'android') return false
  if (when.visible != null) {
    // Com o agente a tela já está estável quando chega aqui: basta uma janela curta.
    if (!(await waitVisible(ctx, toSelector(when.visible), ctx.adb.fast ? 700 : 2000))) return false
  }
  if (when.notVisible != null) {
    if (await findNow(ctx, toSelector(when.notVisible))) return false
  }
  if (when.true != null) {
    const v = String(when.true).trim()
    if (!v || v === 'false' || v === '0' || v.startsWith('${')) return false
  }
  return true
}

async function runSubflow(ctx: Ctx, arg: unknown, depth: number, stepId: string) {
  const a = (typeof arg === 'string' ? { file: arg } : arg) as Record<string, unknown>
  if (!(await checkCondition(ctx, a.when as Record<string, unknown>))) return 'skipped' as const
  const parentEnv = ctx.env
  const parentFile = ctx.file
  try {
    let commands = (a.commands as unknown[]) ?? []
    if (a.file) {
      const file = path.resolve(path.dirname(ctx.file), String(a.file))
      if (!file.startsWith(ctx.rootDir + path.sep) || !/\.ya?ml$/i.test(file)) {
        throw new FlowFailure(`Subfluxo fora do workspace: ${a.file}`)
      }
      if (!fs.existsSync(file)) throw new FlowFailure(`Subfluxo não encontrado: ${a.file}`)
      const sub = readFlowFile(file)
      ctx.env = { ...ctx.env, ...(sub.header.env ?? {}) }
      ctx.file = file
      commands = sub.commands
    }
    ctx.env = { ...ctx.env, ...((a.env as Record<string, string>) ?? {}) }
    await runCommands(ctx, commands, depth + 1, stepId)
  } finally {
    ctx.env = parentEnv
    ctx.file = parentFile
  }
  return 'passed' as const
}

async function execCommand(ctx: Ctx, name: string, rawArg: unknown, depth: number, stepId: string): Promise<'passed' | 'skipped' | 'warned'> {
  const arg = name === 'runFlow' || name === 'repeat' || name === 'retry' ? rawArg : interpolate(rawArg, ctx)
  const obj = (arg && typeof arg === 'object' ? arg : {}) as Record<string, unknown>
  const timeout = (fallback = ctx.lookup) => Number(obj.timeout ?? fallback)

  switch (name) {
    case 'launchApp': {
      const appId = checkAppId((typeof arg === 'string' ? arg : (obj.appId as string)) ?? ctx.appId)
      if (obj.stopApp !== false) await ctx.adb.shell(`am force-stop ${appId}`)
      if (obj.clearState) await ctx.adb.shell(`pm clear ${appId}`)
      if (obj.clearState || obj.permissions) {
        const pkg = await ctx.adb.shell(`dumpsys package ${appId}`, { quiet: true })
        const denied = [...new Set([...pkg.matchAll(/(android\.permission\.[A-Z_]+): granted=false/g)].map((m) => m[1]))]
        for (const p of denied) await ctx.adb.shell(`pm grant ${appId} ${p}`).catch(() => undefined)
      }
      await markBefore(ctx)
      await ctx.adb.shell(`monkey -p ${appId} -c android.intent.category.LAUNCHER 1`)
      await settle(ctx, 1500, 5000)
      // Elementos do app já aparecem na hierarquia com a splash na frente, e um toque ali se perde.
      const deadline = now() + SPLASH_MS
      while ((await ctx.adb.splashShowing(appId)) && now() < deadline) await sleep(200, ctx.signal)
      return 'passed'
    }
    case 'stopApp':
    case 'killApp': {
      const appId = checkAppId((typeof arg === 'string' ? arg : (obj.appId as string)) ?? ctx.appId)
      await ctx.adb.shell(`am force-stop ${appId}`)
      return 'passed'
    }
    case 'clearState': {
      const appId = checkAppId((typeof arg === 'string' ? arg : (obj.appId as string)) ?? ctx.appId)
      await ctx.adb.shell(`pm clear ${appId}`)
      return 'passed'
    }
    case 'tapOn':
    case 'doubleTapOn':
    case 'longPressOn': {
      const kind = name === 'doubleTapOn' ? 'double' : name === 'longPressOn' ? 'long' : 'tap'
      const repeat = Number((obj.repeat as number) ?? 1)
      let point: { x: number; y: number }
      if (obj.point != null) {
        point = parsePoint(obj.point, ctx)
      } else {
        const sel = toSelector(arg)
        const node = await waitVisible(ctx, sel, timeout())
        if (!node) {
          if (obj.optional) {
            log(ctx, 'warn', `opcional: não achei ${describeSelector(sel)}`, depth)
            return 'warned'
          }
          throw new FlowFailure(`Elemento não encontrado: ${describeSelector(sel)}`)
        }
        point = visibleCenter(node, ctx)
      }
      if (name === 'tapOn' && (obj.point != null || isRootId(obj.id))) await hintFor(ctx, stepId, depth, point)
      for (let i = 0; i < repeat; i++) {
        await tap(ctx, point.x, point.y, kind)
        if (obj.delay) await sleep(Number(obj.delay), ctx.signal)
      }
      await settle(ctx, 400)
      return 'passed'
    }
    case 'inputText': {
      // Texto vindo de ${VAR} (usuário, senha) não vai para o log.
      const raw = typeof rawArg === 'object' && rawArg ? (rawArg as { text?: unknown }).text : rawArg
      await markBefore(ctx)
      await typeText(ctx, String(typeof arg === 'object' && arg ? obj.text : arg), String(raw).includes('${'))
      await settle(ctx, 200)
      return 'passed'
    }
    case 'inputRandomText':
    case 'inputRandomEmail':
    case 'inputRandomNumber':
    case 'inputRandomPersonName': {
      const text = randomText(name, Number(obj.length ?? 8))
      log(ctx, 'info', `texto gerado: ${text}`, depth)
      await typeText(ctx, text)
      return 'passed'
    }
    case 'eraseText': {
      const n = Number(typeof arg === 'number' ? arg : (obj.charactersToErase ?? 50))
      await markBefore(ctx)
      await ctx.adb.shell(`input keyevent 123 ${Array(n).fill(67).join(' ')}`)
      return 'passed'
    }
    case 'copyTextFrom': {
      const sel = toSelector(arg)
      const node = await waitVisible(ctx, sel, timeout())
      if (!node) throw new FlowFailure(`Elemento não encontrado: ${describeSelector(sel)}`)
      ctx.copiedText = node.text || node.desc
      log(ctx, 'info', `copiado: "${ctx.copiedText}"`, depth)
      return 'passed'
    }
    case 'pasteText':
      await typeText(ctx, ctx.copiedText ?? '')
      return 'passed'
    case 'pressKey': {
      const key = String(typeof arg === 'object' && arg ? obj.key : arg)
      const code = KEYS[key.toLowerCase()] ?? (/^\d+$/.test(key) ? Number(key) : undefined)
      if (code == null) throw new FlowFailure(`Tecla desconhecida: ${key}`)
      await markBefore(ctx)
      await ctx.adb.shell(`input keyevent ${code}`)
      await settle(ctx, 300)
      return 'passed'
    }
    case 'back':
      await markBefore(ctx)
      await ctx.adb.shell('input keyevent 4')
      await settle(ctx, 300)
      return 'passed'
    case 'hideKeyboard':
      await markBefore(ctx)
      if (await ctx.adb.keyboardShown()) {
        await ctx.adb.shell('input keyevent 4')
      } else {
        // Com teclado físico não há o que fechar, mas o campo segue focado, e em React Native o
        // primeiro toque fora dele só tira o foco: o botão seguinte não reagiria.
        await ctx.adb.clearFocus()
        log(ctx, 'info', 'teclado já estava fechado', depth)
      }
      await settle(ctx, 300)
      return 'passed'
    case 'scroll':
      await swipe(ctx, parsePoint('50%,75%', ctx), parsePoint('50%,30%', ctx), 500)
      await settle(ctx, 400)
      return 'passed'
    case 'swipe': {
      const ms = Number(obj.duration ?? 400)
      if (obj.start != null && obj.end != null) {
        await swipe(ctx, parsePoint(obj.start, ctx), parsePoint(obj.end, ctx), ms)
      } else {
        const dir = DIRECTIONS[String(obj.direction ?? arg).toUpperCase()]
        if (!dir) throw new FlowFailure(`swipe sem start/end ou direction válida`)
        let [s, e] = dir.map((p) => parsePoint(p, ctx))
        if (obj.from != null) {
          const node = await waitVisible(ctx, toSelector(obj.from), timeout())
          if (!node) throw new FlowFailure(`Elemento não encontrado: ${describeSelector(toSelector(obj.from))}`)
          // Arrasta a partir do elemento (ex.: um carrossel), metade da distância e sem sair da tela.
          const c = visibleCenter(node, ctx)
          e = { x: clamp(c.x + (e.x - s.x) / 2, ctx.screen.w), y: clamp(c.y + (e.y - s.y) / 2, ctx.screen.h) }
          s = c
        }
        await swipe(ctx, s, e, ms)
      }
      await settle(ctx, 400)
      return 'passed'
    }
    case 'scrollUntilVisible': {
      const sel = toSelector(obj.element ?? arg)
      const dir = String(obj.direction ?? 'DOWN').toUpperCase()
      const minVisible = Number(obj.visibilityPercentage ?? 100) / 100
      const swipeDir = { DOWN: 'UP', UP: 'DOWN', LEFT: 'RIGHT', RIGHT: 'LEFT' }[dir] ?? 'UP'
      const [from, to] = DIRECTIONS[swipeDir].map((p) => parsePoint(p, ctx))
      const shorten = (a: number, b: number) => Math.round(a + (b - a) * 0.6)
      const deadline = now() + timeout(20000)
      let lastXml = ''
      let sameCount = 0
      while (true) {
        const xml = await readXml(ctx)
        const node = findAll(parseHierarchy(xml), sel, ctx.screen)[sel.index ?? 0]
        if (node && visibleFraction(node, ctx.screen) >= Math.min(minVisible, 0.99)) break
        if (xml === lastXml && ++sameCount >= 2) throw new FlowFailure(`Fim da rolagem e não achei ${describeSelector(sel)}`)
        if (xml !== lastXml) sameCount = 0
        lastXml = xml
        if (now() > deadline) throw new FlowFailure(`Timeout rolando até ${describeSelector(sel)}`)
        await swipe(ctx, from, { x: shorten(from.x, to.x), y: shorten(from.y, to.y) }, Number(obj.speed ? 2000 / Number(obj.speed) * 10 : 500))
        await settle(ctx, 350, 1500)
      }
      return 'passed'
    }
    case 'assertVisible': {
      const sel = toSelector(arg)
      const node = await waitVisible(ctx, sel, timeout())
      if (!node) {
        ctx.stats.checksFailed++
        pushStats(ctx)
        log(ctx, 'fail', `checker: FAIL não está visível ${describeSelector(sel)}`, depth)
        throw new FlowFailure(`Esperava ver ${describeSelector(sel)}`)
      }
      ctx.stats.checksOk++
      pushStats(ctx)
      log(ctx, 'ok', `checker: OK · visível ${describeSelector(sel)}`, depth)
      return 'passed'
    }
    case 'assertNotVisible': {
      const sel = toSelector(arg)
      if (!(await waitNotVisible(ctx, sel, timeout()))) {
        ctx.stats.checksFailed++
        pushStats(ctx)
        log(ctx, 'fail', `checker: FAIL continua visível ${describeSelector(sel)}`, depth)
        throw new FlowFailure(`Não esperava ver ${describeSelector(sel)}`)
      }
      ctx.stats.checksOk++
      pushStats(ctx)
      log(ctx, 'ok', `checker: OK · não visível ${describeSelector(sel)}`, depth)
      return 'passed'
    }
    case 'assertTrue': {
      const v = String(typeof arg === 'object' && arg ? obj.condition : arg).trim()
      const ok = !!v && v !== 'false' && v !== '0' && !v.includes('${')
      if (!ok) {
        ctx.stats.checksFailed++
        throw new FlowFailure(`assertTrue falhou: ${v}`)
      }
      ctx.stats.checksOk++
      return 'passed'
    }
    case 'extendedWaitUntil': {
      const t = timeout(10000)
      if (obj.visible != null) {
        if (!(await waitVisible(ctx, toSelector(obj.visible), t))) throw new FlowFailure(`Timeout esperando ${describeSelector(toSelector(obj.visible))}`)
      } else if (obj.notVisible != null) {
        if (!(await waitNotVisible(ctx, toSelector(obj.notVisible), t))) throw new FlowFailure(`Timeout esperando sumir ${describeSelector(toSelector(obj.notVisible))}`)
      } else {
        return 'passed'
      }
      // Falha se a tela não chegar lá: confere tanto quanto um assert.
      ctx.stats.checksOk++
      pushStats(ctx)
      log(ctx, 'ok', `checker: OK · ${obj.visible != null ? 'apareceu' : 'sumiu'} ${describeSelector(toSelector(obj.visible ?? obj.notVisible))}`, depth)
      return 'passed'
    }
    case 'waitForAnimationToEnd': {
      if (ctx.adb.fast) {
        await settle(ctx, 0, timeout(5000))
        return 'passed'
      }
      const deadline = now() + timeout(5000)
      let last = ''
      while (now() < deadline) {
        const hash = crypto.createHash('md5').update(await ctx.adb.screencap()).digest('hex')
        if (hash === last) break
        last = hash
        await sleep(300, ctx.signal)
      }
      return 'passed'
    }
    case 'wait': // extensão do e2e-box: `- wait: 1000`
      await sleep(Number(typeof arg === 'number' ? arg : (obj.ms ?? 1000)), ctx.signal)
      return 'passed'
    case 'takeScreenshot': {
      const file = await saveScreenshot(ctx, String(typeof arg === 'string' ? arg : (obj.path ?? `shot-${now()}`)))
      log(ctx, 'info', `screenshot salvo: ${path.basename(file)}`, depth)
      return 'passed'
    }
    case 'openLink': {
      const link = String(typeof arg === 'string' ? arg : obj.link)
      await markBefore(ctx)
      await ctx.adb.shell(`am start -a android.intent.action.VIEW -d ${shellQuote(link)}`)
      await settle(ctx, 1000, 5000)
      return 'passed'
    }
    case 'runFlow':
      return runSubflow(ctx, arg, depth, stepId)
    case 'repeat': {
      const times = obj.times != null ? Number(interpolate(obj.times, ctx)) : Infinity
      const whileCond = obj.while as Record<string, unknown> | undefined
      for (let i = 0; i < times && i < 1000; i++) {
        if (whileCond && !(await checkCondition(ctx, interpolate(whileCond, ctx)))) break
        if (!whileCond && times === Infinity) throw new FlowFailure('repeat precisa de `times` ou `while`')
        await runCommands(ctx, (obj.commands as unknown[]) ?? [], depth + 1, `${stepId}.r${i}`)
      }
      return 'passed'
    }
    case 'retry': {
      const max = Number(obj.maxRetries ?? 1)
      for (let i = 0; ; i++) {
        try {
          if (obj.file) await runSubflow(ctx, { file: obj.file }, depth, `${stepId}.t${i}`)
          else await runCommands(ctx, (obj.commands as unknown[]) ?? [], depth + 1, `${stepId}.t${i}`)
          return 'passed'
        } catch (e) {
          if (e instanceof Stopped || e instanceof DeviceGoneError || i >= max) throw e
          log(ctx, 'warn', `retry ${i + 1}/${max}: ${(e as Error).message}`, depth)
        }
      }
    }
    default:
      if (UNSUPPORTED.has(name)) {
        log(ctx, 'warn', `"${name}" ainda não é suportado no e2e-box, pulei`, depth)
        return 'warned'
      }
      throw new FlowFailure(`Comando desconhecido: ${name}`)
  }
}

async function runCommands(ctx: Ctx, commands: unknown[], depth: number, parentId: string) {
  for (let i = 0; i < commands.length; i++) {
    if (ctx.signal.aborted) throw new Stopped('parado')
    const stepId = parentId ? `${parentId}.${i}` : String(i)
    const { name, arg } = normalizeCommand(commands[i])
    const label = commandLabel(commands[i])
    const started = now()
    if (depth === 0 && ctx.range && (i < ctx.range.from || i > ctx.range.to)) {
      ctx.emit({ type: 'step-end', stepId, depth, status: 'skipped', ms: 0, at: started })
      continue
    }
    ctx.emit({ type: 'step-start', stepId, depth, label, at: started })
    log(ctx, 'step', `fun> ${label}`, depth)
    try {
      await refreshScreen(ctx)
      const status = await execCommand(ctx, name, arg, depth, stepId)
      const ms = now() - started
      const shot = depth === 0 ? await captureStep(ctx, stepId, name) : undefined
      ctx.emit({ type: 'step-end', stepId, depth, status, ms, shot, at: now() })
    } catch (e) {
      const optional = arg && typeof arg === 'object' && (arg as { optional?: boolean }).optional
      if (optional && !(e instanceof Stopped) && !(e instanceof DeviceGoneError)) {
        log(ctx, 'warn', `opcional falhou: ${(e as Error).message}`, depth)
        ctx.emit({ type: 'step-end', stepId, depth, status: 'warned', ms: now() - started, error: (e as Error).message, at: now() })
        continue
      }
      ctx.emit({ type: 'step-end', stepId, depth, status: 'failed', ms: now() - started, error: (e as Error).message, shot: depth === 0 ? 'falha.png' : undefined, at: now() })
      throw e
    } finally {
      if (depth === 0) {
        ctx.stats.done++
        pushStats(ctx)
      }
    }
  }
}

export async function runFlow(opts: RunOptions): Promise<'passed' | 'failed' | 'stopped'> {
  const started = now()
  const { header, commands } = readFlowFile(opts.file)
  const h = header as FlowHeader
  const partial = opts.from != null || opts.to != null
  const range = partial ? { from: opts.from ?? 0, to: Math.min(opts.to ?? commands.length - 1, commands.length - 1) } : undefined
  const stats: RunStats = { steps: range ? Math.max(0, range.to - range.from + 1) : commands.length, done: 0, taps: 0, inputs: 0, checksOk: 0, checksFailed: 0 }
  const ctx: Ctx = {
    adb: opts.adb,
    emit: opts.emit,
    signal: opts.signal,
    appId: h.appId ?? opts.appId,
    env: { ...(opts.env ?? {}), ...(h.env ?? {}) },
    screen: { w: 0, h: 0 },
    natural: { w: 0, h: 0 },
    artifactsDir: opts.artifactsDir,
    lookup: opts.lookupTimeoutMs ?? 7000,
    stats,
    file: opts.file,
    mainFile: opts.file,
    range,
    stepShots: !!opts.stepShots,
    shots: [],
    rootDir: path.resolve(opts.rootDir ?? path.dirname(opts.file)),
  }
  opts.emit({ type: 'run-start', runId: opts.runId, ref: opts.ref, file: opts.file, steps: commands.map(commandLabel), partial, serial: opts.adb.serial, at: started })

  let status: 'passed' | 'failed' | 'stopped' = 'passed'
  let error: string | undefined
  let gone = false
  try {
    ctx.natural = await opts.adb.naturalSize()
    ctx.screen = await opts.adb.screenSize()
    log(ctx, 'info', `tela ${ctx.screen.w}x${ctx.screen.h} · app ${ctx.appId ?? '(sem appId)'}`)
    for (const issue of lintFlow(fs.readFileSync(opts.file, 'utf8'))) log(ctx, 'warn', `passo frágil (linha ${issue.line}): ${issue.message}`)
    if (h.onFlowStart?.length && !partial) {
      try {
        await runCommands(ctx, h.onFlowStart, 1, 'start')
      } catch (e) {
        if (e instanceof FlowFailure) throw new FlowFailure(`Pré-condição não atendida: ${e.message}`)
        throw e
      }
      // A pré-condição prepara o terreno: o que ela confere não conta como conferir o fluxo.
      stats.checksOk = 0
      pushStats(ctx)
    }
    await runCommands(ctx, commands, 0, '')
  } catch (e) {
    status = e instanceof Stopped ? 'stopped' : 'failed'
    error = (e as Error).message
    gone = e instanceof DeviceGoneError
  } finally {
    if (h.onFlowComplete?.length && status !== 'stopped' && !gone && !partial) {
      await runCommands(ctx, h.onFlowComplete, 1, 'complete').catch(() => undefined)
    }
  }

  if (status === 'failed') {
    log(ctx, 'error', `falhou: ${error}`)
    if (!gone) try {
      await saveScreenshot(ctx, 'falha')
      fs.writeFileSync(path.join(ctx.artifactsDir, 'falha-hierarquia.xml'), await opts.adb.dumpHierarchy())
      log(ctx, 'info', `evidências em ${ctx.artifactsDir}`)
    } catch {
      /* sem device: segue sem evidência */
    }
  }
  await Promise.all(ctx.shots)
  if (status === 'passed' && stats.checksOk === 0 && !partial) {
    log(ctx, 'warn', 'passou sem conferir nada: os toques aconteceram, mas nenhum passo verifica o resultado (use assertVisible)')
  }
  opts.emit({ type: 'run-end', runId: opts.runId, status, ms: now() - started, error, stats: { ...stats }, artifactsDir: opts.artifactsDir, at: now() })
  return status
}
