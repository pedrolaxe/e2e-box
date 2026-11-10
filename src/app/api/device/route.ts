import { Adb } from '@/lib/adb'
import { hub } from '@/lib/hub'
import { describeHolder, lockHolder } from '@/lib/lock'

export const dynamic = 'force-dynamic'

export async function GET() {
  try {
    const devices = await new Adb().devices()
    const serial = await hub.ensureSerial()
    const entry = devices.find((d) => d.serial === serial)
    const runningSerials = hub.runningSerials
    if (!serial || !entry) return Response.json({ devices, serial: null, runningSerials })
    const holder = lockHolder(serial)
    const adb = hub.adb()
    const [battery, screen, model, release] = await Promise.all([
      adb.battery(),
      adb.screenSize().catch(() => null),
      adb.shell('getprop ro.product.model', { quiet: true }).catch(() => ''),
      adb.shell('getprop ro.build.version.release', { quiet: true }).catch(() => ''),
    ])
    return Response.json({
      devices,
      serial,
      runningSerials,
      busy: holder ? describeHolder(holder) : undefined,
      info: { model: model.trim() || entry.model, android: release.trim(), transport: entry.transport, battery, screen },
    })
  } catch (e) {
    return Response.json({ devices: [], serial: null, error: (e as Error).message })
  }
}

export async function POST(req: Request) {
  const { serial } = await req.json()
  hub.choose(serial)
  return Response.json({ serial })
}
