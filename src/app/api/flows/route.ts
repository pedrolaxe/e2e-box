import { listFlows } from '@/lib/flows'
import { listRuns } from '@/lib/hub'

export const dynamic = 'force-dynamic'

export async function GET() {
  const runs = listRuns()
  const { workspaces } = listFlows()
  const lastByRef = new Map<string, (typeof runs)[number]>()
  // Rodar um trecho não diz se o fluxo passa: o ponto na lista continua sendo o da última execução inteira.
  for (const r of runs) if (!r.partial && !lastByRef.has(r.ref)) lastByRef.set(r.ref, r)
  return Response.json({
    workspaces: workspaces.map(({ env: _env, ...w }) => ({ ...w, files: w.files.map((f) => ({ ...f, lastRun: lastByRef.get(f.ref) ?? null })) })),
    runs: runs.slice(0, 15),
  })
}
