import { hub } from '@/lib/hub'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const { ref, env, times, from, to } = await req.json()
  const step = (v: unknown) => (Number.isInteger(v) && (v as number) >= 0 ? (v as number) : undefined)
  try {
    return Response.json(await hub.start(ref, env ?? {}, { times: Math.min(20, Math.max(1, Number(times) || 1)), from: step(from), to: step(to) }))
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 409 })
  }
}

export async function DELETE() {
  hub.stop()
  return Response.json({ ok: true })
}
