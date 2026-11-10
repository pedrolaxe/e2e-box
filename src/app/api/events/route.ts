import type { RunEvent } from '@/lib/engine'
import { hub } from '@/lib/hub'

export const dynamic = 'force-dynamic'

export async function GET(req: Request) {
  const serial = new URL(req.url).searchParams.get('serial') ?? hub.serial ?? ''
  const encoder = new TextEncoder()
  let cleanup = () => {}
  const stream = new ReadableStream({
    start(controller) {
      const send = (e: RunEvent | { type: 'hello'; running: boolean }) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`))
        } catch {
          cleanup()
        }
      }
      send({ type: 'hello', running: hub.isRunning(serial) })
      for (const e of hub.replay(serial)) send(e)
      const unsubscribe = hub.subscribe(serial, send)
      const ping = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(': ping\n\n'))
        } catch {
          cleanup()
        }
      }, 15000)
      cleanup = () => {
        unsubscribe()
        clearInterval(ping)
      }
      req.signal.addEventListener('abort', () => cleanup())
    },
    cancel() {
      cleanup()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' },
  })
}
