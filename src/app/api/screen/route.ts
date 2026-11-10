import { hub } from '@/lib/hub'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    if (!(await hub.ensureSerial())) return new Response('sem device', { status: 404 })
    const png = await hub.adb().screencap()
    return new Response(new Uint8Array(png), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store' } })
  } catch (e) {
    return new Response((e as Error).message, { status: 503 })
  }
}
