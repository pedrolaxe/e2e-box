/**
 * Roda fluxos sem a interface (bom para CI ou terminal).
 *
 *   e2e-box [arquivo.yaml|pasta|workspace:rel.yaml]... [-d serial]... [--all-devices] [-e CHAVE=valor]
 *
 * Pastas rodam todos os .yaml da raiz (subpastas são subfluxos; o config.yaml do Maestro não é fluxo).
 * Sem alvo, roda as pastas .e2e-box/ e .maestro/ da pasta atual. Sai com código 1 se algum falhar.
 * No repo: `pnpm e2e` (tsx). No npm: `npx e2e-box` (dist/cli.js, gerado por scripts/build-cli.mjs).
 */
import fs from 'node:fs'
import path from 'node:path'
import { Adb } from '../src/lib/adb'
import { findFlowDirs, loadConfig, ROOT } from '../src/lib/config'
import { runFlow, type RunEvent } from '../src/lib/engine'
import { isFlowFile, resolveRef } from '../src/lib/flows'
import { acquireLock, releaseLock } from '../src/lib/lock'

// O agente e os recursos ficam na pasta do e2e-box, mesmo rodando de dentro do repo do app.
process.env.E2E_BOX_HOME ??= path.resolve(__dirname, '..')

const c = { dim: '\x1b[2m', red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', blue: '\x1b[34m', orange: '\x1b[38;5;214m', reset: '\x1b[0m' }

function parseArgs(argv: string[]) {
  const targets: string[] = []
  const env: Record<string, string> = {}
  const serials: string[] = []
  let all = false
  let verbose = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-d' || a === '--device') serials.push(argv[++i])
    else if (a === '--all-devices') all = true
    else if (a === '-e' || a === '--env') {
      const [k, ...v] = argv[++i].split('=')
      env[k] = v.join('=')
    } else if (a === '-v' || a === '--verbose') verbose = true
    else targets.push(a)
  }
  return { targets, env, serials, all, verbose }
}

function expand(target: string): { ref: string; file: string; appId?: string; wsEnv?: Record<string, string>; rootDir?: string }[] {
  if (/^[\w-]+:/.test(target) && !/^[a-z]:[\\/]/i.test(target)) {
    const { ws, file } = resolveRef(target)
    return [{ ref: target, file, appId: ws.appId, wsEnv: ws.env, rootDir: ws.dir }]
  }
  const abs = path.resolve(target)
  const ws = loadConfig().workspaces.find((w) => abs === w.dir || abs.startsWith(w.dir + path.sep))
  if (fs.statSync(abs).isDirectory()) {
    return fs
      .readdirSync(abs)
      .filter(isFlowFile)
      .sort()
      .map((f) => ({ ref: path.relative(process.cwd(), path.join(abs, f)) || f, file: path.join(abs, f), appId: ws?.appId, wsEnv: ws?.env, rootDir: ws?.dir }))
  }
  return [{ ref: path.basename(abs), file: abs, appId: ws?.appId, wsEnv: ws?.env, rootDir: ws?.dir }]
}

/** Com mais de um celular, cada linha diz de qual é. */
function printer(verbose: boolean, prefix = '') {
  const say = (line: string) => console.log(prefix ? line.replace(/^(\n?)/, `$1${c.dim}[${prefix}]${c.reset} `) : line)
  return (e: RunEvent) => {
    const pad = (d = 0) => '  '.repeat(d + 1)
    switch (e.type) {
      case 'run-start':
        say(`\n${c.orange}▶ ${e.ref}${c.reset} ${c.dim}(${e.steps.length} passos, ${e.serial})${c.reset}`)
        break
      case 'step-end': {
        const icon = e.status === 'passed' ? `${c.green}✓` : e.status === 'failed' ? `${c.red}✕` : `${c.yellow}–`
        if (e.depth === 0 || e.status === 'failed' || verbose) {
          say(`${pad(e.depth)}${icon}${c.reset} ${e.stepId} ${c.dim}${e.ms}ms${c.reset}${e.error ? ` ${c.red}${e.error}${c.reset}` : ''}`)
        }
        break
      }
      case 'step-start':
        if (e.depth === 0 || verbose) say(`${pad(e.depth)}${c.dim}${e.label}${c.reset}`)
        break
      case 'log':
        if (e.level === 'warn') say(`${pad(e.depth)}${c.yellow}! ${e.msg}${c.reset}`)
        else if (verbose && e.level === 'adb') say(`${pad(e.depth)}${c.dim}${e.msg}${c.reset}`)
        else if (e.level === 'info' && e.msg.startsWith('evidências')) say(`${pad()}${c.blue}${e.msg}${c.reset}`)
        break
      case 'run-end': {
        const color = e.status !== 'passed' ? c.red : e.stats.checksOk ? c.green : c.yellow
        say(`${color}■ ${e.status}${c.reset} ${c.dim}${(e.ms / 1000).toFixed(1)}s · ${e.stats.taps} taps · ${e.stats.checksOk} checks${c.reset}`)
        break
      }
    }
  }
}

function usage(code: number, msg?: string): never {
  if (msg) console.error(`${c.red}${msg}${c.reset}`)
  console.log('uso: e2e-box [arquivo.yaml|pasta|workspace:rel.yaml]... [-d serial]... [--all-devices] [-e CHAVE=valor] [-v]')
  console.log(`${c.dim}sem alvo, roda as pastas .e2e-box/ e .maestro/ da pasta atual${c.reset}`)
  process.exit(code)
}

async function main() {
  const { targets, env, serials, all, verbose } = parseArgs(process.argv.slice(2))
  if (targets.includes('-h') || targets.includes('--help')) usage(0)
  if (targets.includes('-V') || targets.includes('--version')) {
    const pkg = JSON.parse(fs.readFileSync(path.join(process.env.E2E_BOX_HOME!, 'package.json'), 'utf8'))
    console.log(pkg.version)
    process.exit(0)
  }
  if (!targets.length) {
    // Sem alvo: as pastas de fluxos do repo (.e2e-box/ e .maestro/), como no CI do app.
    targets.push(...findFlowDirs(ROOT).map((d) => path.relative(process.cwd(), d) || '.'))
    if (!targets.length) usage(2, 'Nenhuma pasta .e2e-box/ ou .maestro/ aqui; informe um arquivo ou pasta.')
    console.log(`${c.dim}fluxos de ${targets.join(', ')}${c.reset}`)
  }
  const online = (await new Adb().devices()).filter((d) => d.state === 'device').map((d) => d.serial)
  const devices = all ? online : serials.length ? serials : online.slice(0, 1)
  const missing = devices.filter((d) => !online.includes(d))
  if (!devices.length || missing.length) {
    console.error(`${c.red}${missing.length ? `Device fora do adb: ${missing.join(', ')}` : 'Nenhum device Android conectado (adb devices).'}${c.reset}`)
    process.exit(2)
  }
  const cfg = loadConfig()
  const flows = targets.flatMap(expand)
  if (!flows.length) usage(2, `Nenhum fluxo .yaml em ${targets.join(', ')}.`)
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  // Nada começa se algum celular estiver ocupado: rodar junto derrubaria o agente do outro.
  try {
    for (const device of devices) acquireLock(device, 'cli', flows.map((f) => f.ref).join(', '))
  } catch (e) {
    devices.forEach(releaseLock)
    console.error(`${c.red}${(e as Error).message}${c.reset}`)
    process.exit(2)
  }

  /** Um celular roda os fluxos em sequência; os celulares rodam em paralelo. */
  const runOn = async (device: string) => {
    const emit = printer(verbose, devices.length > 1 ? device : '')
    const results: { device: string; ref: string; status: string }[] = []
    for (const f of flows) {
      const runId = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19)
      const adb = new Adb(device, (cmd) => emit({ type: 'log', level: 'adb', msg: cmd, at: Date.now() }))
      const status = await runFlow({
        runId,
        ref: f.ref,
        file: f.file,
        adb,
        emit,
        signal: controller.signal,
        artifactsDir: path.join(cfg.runsDir, `${runId}-cli-${device.replace(/[^\w-]/g, '_')}`),
        env: { ...(f.wsEnv ?? {}), ...env },
        appId: f.appId,
        rootDir: f.rootDir,
        lookupTimeoutMs: cfg.lookupTimeoutMs,
      })
      results.push({ device, ref: f.ref, status })
      if (status === 'stopped') break
      // Sem o celular os próximos fluxos só repetiriam a mesma falha.
      if (status === 'failed' && (await adb.goneError())) break
    }
    return results
  }

  let results: { device: string; ref: string; status: string }[]
  try {
    results = (await Promise.all(devices.map(runOn))).flat()
  } finally {
    devices.forEach(releaseLock)
  }
  const expected = flows.length * devices.length
  const passed = results.filter((r) => r.status === 'passed').length
  console.log(`\n${passed < expected ? c.red : c.green}${passed}/${expected} fluxos passaram${c.reset}`)
  process.exit(passed < expected ? 1 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(2)
})
