import fs from 'node:fs'
import path from 'node:path'
import { parseAllDocuments } from 'yaml'
import { loadConfig, type Workspace } from './config'
import { repairFlow } from './lint'

export type Command = { name: string; arg: unknown }

export interface FlowHeader {
  appId?: string
  name?: string
  tags?: string[]
  env?: Record<string, string>
  onFlowStart?: unknown[]
  onFlowComplete?: unknown[]
}

export interface ParsedFlow {
  header: FlowHeader
  commands: unknown[]
}

export class FlowParseError extends Error {}

/** Lê um YAML no formato do Maestro: cabeçalho (`appId`, `env`...) + `---` + lista de comandos. */
export function parseFlow(text: string): ParsedFlow {
  const docs = parseAllDocuments(repairFlow(text))
  for (const d of docs) {
    if (d.errors.length) throw new FlowParseError(d.errors.map((e) => e.message).join('\n'))
  }
  const values = docs.map((d) => d.toJS()).filter((v) => v != null)
  if (values.length === 1 && Array.isArray(values[0])) return { header: {}, commands: values[0] }
  if (values.length === 1) return { header: values[0] as FlowHeader, commands: [] }
  const [header, commands] = values
  if (!Array.isArray(commands)) throw new FlowParseError('Depois do `---` deve vir uma lista de comandos (cada um começando com "- ").')
  return { header: (header ?? {}) as FlowHeader, commands }
}

export function readFlowFile(file: string): ParsedFlow {
  return parseFlow(fs.readFileSync(file, 'utf8'))
}

/** `- "scroll"` vira { name: 'scroll' }; `- tapOn: X` vira { name: 'tapOn', arg: X }. */
export function normalizeCommand(raw: unknown): Command {
  if (typeof raw === 'string') return { name: raw, arg: null }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const keys = Object.keys(raw)
    if (keys.length === 1) return { name: keys[0], arg: (raw as Record<string, unknown>)[keys[0]] }
  }
  throw new FlowParseError(`Comando inválido: ${JSON.stringify(raw)}`)
}

const quote = (s: unknown) => `"${String(s)}"`

function selectorLabel(arg: unknown): string {
  if (typeof arg === 'string' || typeof arg === 'number') return quote(arg)
  if (!arg || typeof arg !== 'object') return ''
  const a = arg as Record<string, unknown>
  if (a.point) return `@${a.point}`
  const parts: string[] = []
  if (a.text != null) parts.push(quote(a.text))
  if (a.id != null) parts.push(`#${a.id}`)
  if (a.index != null) parts.push(`[${a.index}]`)
  if (a.element != null) parts.push(selectorLabel(a.element))
  return parts.join(' ')
}

export function commandLabel(raw: unknown): string {
  const { name, arg } = normalizeCommand(raw)
  if (arg && typeof arg === 'object' && 'label' in arg && (arg as { label?: string }).label) return String((arg as { label: string }).label)
  switch (name) {
    case 'runFlow': {
      if (typeof arg === 'string') return `runFlow ${arg}`
      const a = arg as Record<string, unknown>
      const target = a.file ? String(a.file) : `${(a.commands as unknown[])?.length ?? 0} comandos`
      const when = a.when as Record<string, unknown> | undefined
      const cond = when?.visible != null ? ` · se visível "${when.visible}"` : when?.notVisible != null ? ` · se não visível "${when.notVisible}"` : ''
      return `runFlow ${target}${cond}`
    }
    case 'inputText':
    case 'pressKey':
    case 'openLink':
    case 'takeScreenshot':
      return `${name} ${quote(typeof arg === 'object' && arg ? Object.values(arg)[0] : arg)}`
    case 'extendedWaitUntil': {
      const a = (arg ?? {}) as Record<string, unknown>
      return a.visible != null ? `extendedWaitUntil visível ${selectorLabel(a.visible)}` : `extendedWaitUntil não visível ${selectorLabel(a.notVisible)}`
    }
    default: {
      const s = arg == null ? '' : selectorLabel(arg)
      if (s) return `${name} ${s}`
      if (arg != null && typeof arg !== 'object') return `${name} ${arg}`
      if (arg && typeof arg === 'object') {
        const json = JSON.stringify(arg)
        return `${name} ${json.length > 60 ? json.slice(0, 57) + '…' : json}`
      }
      return name
    }
  }
}

export function outline(text: string): { labels: string[]; error?: string; appId?: string } {
  try {
    const { header, commands } = parseFlow(text)
    return { labels: commands.map(commandLabel), appId: header.appId }
  } catch (e) {
    return { labels: [], error: (e as Error).message }
  }
}

// ---- arquivos dos workspaces ----

export interface FlowFile {
  ref: string
  workspace: string
  rel: string
  name: string
  subflow: boolean
}

function walk(dir: string, base = dir): string[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name.startsWith('.') || e.name === 'node_modules') return []
    const p = path.join(dir, e.name)
    if (e.isDirectory()) return walk(p, base)
    return /\.ya?ml$/i.test(e.name) ? [path.relative(base, p).split(path.sep).join('/')] : []
  })
}

export function listFlows(): { workspaces: (Workspace & { files: FlowFile[] })[] } {
  const cfg = loadConfig()
  return {
    workspaces: cfg.workspaces.map((ws) => ({
      ...ws,
      files: walk(ws.dir)
        .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
        .map((rel) => ({
          ref: `${ws.id}:${rel}`,
          workspace: ws.id,
          rel,
          name: path.basename(rel).replace(/\.ya?ml$/i, ''),
          subflow: rel.includes('/'),
        })),
    })),
  }
}

export function resolveRef(ref: string): { ws: Workspace; file: string } {
  const i = ref.indexOf(':')
  const wsId = ref.slice(0, i)
  const rel = ref.slice(i + 1)
  const ws = loadConfig().workspaces.find((w) => w.id === wsId)
  if (!ws || i < 0) throw new Error(`Workspace desconhecido em "${ref}"`)
  const file = path.resolve(ws.dir, rel)
  if (!file.startsWith(path.resolve(ws.dir) + path.sep)) throw new Error('Caminho fora do workspace')
  if (!/\.ya?ml$/i.test(file)) throw new Error('O fluxo precisa ser .yaml ou .yml')
  return { ws, file }
}
