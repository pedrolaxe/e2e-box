import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '@/lib/config'
import { outline, resolveRef } from '@/lib/flows'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const ref = new URL(req.url).searchParams.get('ref') ?? ''
  try {
    const { file } = resolveRef(ref)
    const content = fs.readFileSync(file, 'utf8')
    return Response.json({ ref, file, content, ...outline(content) })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 404 })
  }
}

/** Salva o conteúdo do fluxo. */
export async function PUT(req: Request) {
  const { ref, content } = await req.json()
  try {
    const { file } = resolveRef(ref)
    fs.writeFileSync(file, content)
    return Response.json({ ok: true, ...outline(content) })
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 })
  }
}

/** Cria um fluxo novo a partir de um modelo. */
export async function POST(req: Request) {
  const { workspace, name } = await req.json()
  const ws = loadConfig().workspaces.find((w) => w.id === workspace)
  if (!ws) return Response.json({ error: 'workspace inválido' }, { status: 400 })
  const rel = String(name).trim().replace(/\\/g, '/').replace(/\.ya?ml$/i, '') + '.yaml'
  if (!/^[\w\-/. ]+$/.test(rel) || rel.includes('..')) return Response.json({ error: 'nome inválido' }, { status: 400 })
  const ref = `${ws.id}:${rel}`
  const { file } = resolveRef(ref)
  if (fs.existsSync(file)) return Response.json({ error: 'já existe um fluxo com esse nome' }, { status: 409 })
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `appId: ${ws.appId ?? 'com.exemplo.app'}\n---\n- launchApp\n# Clique no espelho com "gravar" ligado para ir adicionando passos\n`,
  )
  return Response.json({ ref })
}
