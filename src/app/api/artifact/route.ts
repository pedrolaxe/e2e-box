import fs from 'node:fs'
import path from 'node:path'
import { loadConfig } from '@/lib/config'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams
  const run = params.get('run') ?? ''
  const name = params.get('file') ?? ''
  if (!/^[\w-]+$/.test(run) || !/^[\w.-]+$/.test(name)) return new Response('inválido', { status: 400 })
  const file = path.join(loadConfig().runsDir, run, name)
  if (!fs.existsSync(file)) return new Response('não encontrado', { status: 404 })
  const type = name.endsWith('.png') ? 'image/png' : name.endsWith('.json') ? 'application/json' : 'text/plain; charset=utf-8'
  return new Response(new Uint8Array(fs.readFileSync(file)), { headers: { 'content-type': type } })
}
