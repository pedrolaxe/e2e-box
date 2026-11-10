import fs from 'node:fs'
import path from 'node:path'
import { addWorkspace, detectAppId, findFlowDirs, loadConfig } from '@/lib/config'

export const dynamic = 'force-dynamic'

// Pastas irmãs que não viram sugestão (além da do próprio e2e-box).
const SKIP = new Set(['node_modules'])

/**
 * Sugestões: repos vizinhos ao e2e-box, apontando para a pasta de fluxos que já existe
 * (<repo>/.e2e-box ou <repo>/.maestro; sem nenhuma, .maestro), com appId detectado.
 */
export async function GET() {
  const cfg = loadConfig()
  const parent = path.dirname(cfg.root)
  const used = new Set(cfg.workspaces.map((w) => w.dir))
  const suggestions = fs
    .readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !SKIP.has(e.name) && path.join(parent, e.name) !== cfg.root)
    .map((e) => {
      const repo = path.join(parent, e.name)
      const found = findFlowDirs(repo)[0]
      return {
        repo: e.name,
        dir: `../${e.name}/${found ? path.basename(found) : '.maestro'}`,
        appId: detectAppId(repo),
        hasFlows: !!found,
      }
    })
    .filter((s) => !used.has(path.resolve(cfg.root, s.dir)))
    .sort((a, b) => Number(!!b.appId) - Number(!!a.appId) || Number(b.hasFlows) - Number(a.hasFlows) || a.repo.localeCompare(b.repo))
  return Response.json({ suggestions })
}

export async function POST(req: Request) {
  const { name, dir, appId } = (await req.json()) as { name?: string; dir?: string; appId?: string }
  const cfg = loadConfig()
  const title = String(name ?? '').trim()
  const rel = String(dir ?? '').trim().replace(/\\/g, '/')
  if (!title) return Response.json({ error: 'Dê um nome ao workspace' }, { status: 400 })
  if (!rel) return Response.json({ error: 'Informe a pasta dos fluxos' }, { status: 400 })
  if (appId && !/^[a-zA-Z][\w]*(\.[a-zA-Z][\w]*)+$/.test(appId)) {
    return Response.json({ error: 'appId inválido (ex.: app.empresa.produto)' }, { status: 400 })
  }
  // Só pastas dentro da pasta de repos (a que contém o e2e-box): nada de caminho absoluto ou fora dela.
  const base = path.dirname(cfg.root)
  const abs = path.resolve(cfg.root, rel)
  if (path.isAbsolute(rel) || !abs.startsWith(base + path.sep)) {
    return Response.json({ error: `A pasta precisa ficar dentro de ${base}` }, { status: 400 })
  }
  if (cfg.workspaces.some((w) => w.dir === abs)) return Response.json({ error: 'Essa pasta já é um workspace' }, { status: 409 })
  if (!fs.existsSync(path.dirname(abs))) {
    return Response.json({ error: `A pasta ${path.dirname(abs)} não existe` }, { status: 400 })
  }
  const slug = title.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'workspace'
  let id = slug
  for (let i = 2; cfg.workspaces.some((w) => w.id === id); i++) id = `${slug}-${i}`
  fs.mkdirSync(abs, { recursive: true })
  addWorkspace({ id, name: title, dir: rel, ...(appId ? { appId } : {}) })
  return Response.json({ id })
}
