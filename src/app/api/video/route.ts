import { spawn, type ChildProcess } from 'node:child_process'
import { Adb, ADB_BIN, DeviceGoneError } from '@/lib/adb'
import { hub } from '@/lib/hub'

export const dynamic = 'force-dynamic'

// Espelho em vídeo: H.264 cru (Annex B) do `screenrecord`, decodificado no navegador (WebCodecs).
// O screenrecord para sozinho a cada 3 minutos; o stream religa ele sem fechar a resposta.
// Se a tela girar ou o celular sair, o stream fecha e o navegador abre outro no tamanho certo.
const WIDTH = 720
const ROTATION_CHECK_MS = 1500

const g = globalThis as unknown as { __e2eBoxVideoStop?: () => void }

export async function GET(req: Request) {
  const serial = await hub.ensureSerial()
  if (!serial) return new Response('sem device', { status: 404 })
  const adb = new Adb(serial)
  let screen: { w: number; h: number }
  try {
    screen = await adb.screenSize()
  } catch (e) {
    return new Response((e as Error).message, { status: e instanceof DeviceGoneError ? 404 : 503 })
  }
  // Largura e altura múltiplas de 16 (exigência do encoder), mantendo a proporção da tela.
  const w = Math.floor(Math.min(WIDTH, screen.w) / 16) * 16
  const h = Math.round((w * screen.h) / screen.w / 16) * 16

  // Matar o adb no PC não encerra o screenrecord no celular na hora, e só um consegue usar o
  // encoder: sobra de um stream anterior (outra aba, troca vídeo/print) travaria o novo.
  const killRecorders = () => adb.shell('pkill screenrecord', { quiet: true }).catch(() => '')

  let child: ChildProcess | undefined
  let closed = false
  let output: ReadableStreamDefaultController<Uint8Array> | undefined
  let watcher: ReturnType<typeof setInterval> | undefined
  const stop = () => {
    if (closed) return
    closed = true
    clearInterval(watcher)
    child?.kill()
    try {
      output?.close()
    } catch {
      // já fechado pelo navegador
    }
    void killRecorders()
  }
  req.signal.addEventListener('abort', stop)
  // Um stream por vez: o Next nem sempre avisa que o navegador desistiu de um (efeito duplicado
  // do React em dev, aba fechada), então o novo encerra o anterior.
  g.__e2eBoxVideoStop?.()
  g.__e2eBoxVideoStop = stop
  await killRecorders()

  let checking = false
  watcher = setInterval(async () => {
    if (checking) return
    checking = true
    try {
      const now = await adb.screenSize()
      if (now.w !== screen.w || now.h !== screen.h) stop()
    } catch (e) {
      if (e instanceof DeviceGoneError) stop()
    } finally {
      checking = false
    }
  }, ROTATION_CHECK_MS)

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      output = controller
      const startRecorder = () => {
        if (closed) return
        child = spawn(
          ADB_BIN,
          ['-s', serial, 'exec-out', 'screenrecord', '--output-format=h264', '--bit-rate', '6000000', '--size', `${w}x${h}`, '-'],
          { windowsHide: true },
        )
        child.stdout?.on('data', (d: Buffer) => {
          try {
            controller.enqueue(new Uint8Array(d))
            // Ninguém lendo (o navegador saiu e o Next não avisou): encerra em vez de acumular.
            if ((controller.desiredSize ?? 0) < -300) stop()
          } catch {
            stop()
          }
        })
        child.on('exit', () => {
          if (closed) return
          setTimeout(startRecorder, 200)
        })
      }
      startRecorder()
    },
    cancel: stop,
  })

  return new Response(stream, {
    headers: {
      'content-type': 'video/h264',
      'cache-control': 'no-store',
      'x-video-size': `${w}x${h}`,
      'x-device-size': `${screen.w}x${screen.h}`,
    },
  })
}
