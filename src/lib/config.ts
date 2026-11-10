import fs from 'node:fs'
import path from 'node:path'

export interface Workspace {
  id: string
  name: string
  /** Pasta dos fluxos (absoluta depois de carregar). */
  dir: string
  appId?: string
  env?: Record<string, string>
}

export interface Config {
  root: string
  workspaces: Workspace[]
  runsDir: string
  lookupTimeoutMs: number
}

export const ROOT = process.env.E2E_BOX_ROOT ?? process.cwd()

export function loadConfig(): Config {
  const file = path.join(ROOT, 'e2e-box.config.json')
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {}
  // Variáveis locais (usuário/senha de teste) ficam fora do git: { "env": { "<workspace>": { "CHAVE": "valor" } } }
  const localFile = path.join(ROOT, 'e2e-box.local.json')
  const local = fs.existsSync(localFile) ? JSON.parse(fs.readFileSync(localFile, 'utf8')) : {}
  const workspaces: Workspace[] = (raw.workspaces ?? [{ id: 'exemplos', name: 'Exemplos', dir: './flows' }]).map(
    (w: Workspace) => ({ ...w, dir: path.resolve(ROOT, w.dir), env: { ...(w.env ?? {}), ...(local.env?.[w.id] ?? {}) } }),
  )
  return {
    root: ROOT,
    workspaces,
    runsDir: path.resolve(ROOT, raw.runsDir ?? './runs'),
    lookupTimeoutMs: raw.lookupTimeoutMs ?? 7000,
  }
}

const CONFIG_FILE = () => path.join(ROOT, 'e2e-box.config.json')

/** Adiciona um workspace ao e2e-box.config.json (pasta guardada relativa ao projeto). */
export function addWorkspace(ws: { id: string; name: string; dir: string; appId?: string }) {
  const file = CONFIG_FILE()
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : { workspaces: [] }
  raw.workspaces = [...(raw.workspaces ?? []), ws]
  fs.writeFileSync(file, JSON.stringify(raw, null, 2) + '\n')
}

/** appId Android de um app Expo/React Native (app.json → expo.android.package). */
export function detectAppId(repoDir: string): string | undefined {
  try {
    const app = JSON.parse(fs.readFileSync(path.join(repoDir, 'app.json'), 'utf8'))
    return app.expo?.android?.package ?? app.android?.package
  } catch {
    return undefined
  }
}
