import { promisify } from 'node:util'
import zlib from 'node:zlib'

// O `screencap -p` passa quase todo o tempo codificando o PNG no celular (~1s). Sem o -p ele só copia
// os pixels (~250ms): o motor espera essa parte, para o print ser mesmo do passo que acabou, e o
// PNG é feito aqui no PC, em segundo plano.

const deflate = promisify(zlib.deflate)

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(buf: Buffer) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Buffer) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data])
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([length, body, crc])
}

const RGBA_8888 = 1
/** Acima disso reduz pela metade: a tela de execução mostra pequeno e são muitos prints. */
const MAX_WIDTH = 720

/** Converte a saída do `screencap` sem -p (cabeçalho + RGBA) em PNG. */
export async function rawToPng(raw: Buffer): Promise<Buffer> {
  const w = raw.readUInt32LE(0)
  const h = raw.readUInt32LE(4)
  const format = raw.readUInt32LE(8)
  // O cabeçalho tem 12 ou 16 bytes conforme a versão do Android.
  const header = raw.length - w * h * 4
  if (format !== RGBA_8888 || header < 12 || header > 32) throw new Error(`screencap em formato inesperado (${format})`)

  const step = w > MAX_WIDTH ? 2 : 1
  const outW = Math.floor(w / step)
  const outH = Math.floor(h / step)
  const lines = Buffer.alloc(outH * (1 + outW * 3))
  let o = 0
  for (let y = 0; y < outH; y++) {
    lines[o++] = 0 // sem filtro na linha
    let i = header + y * step * w * 4
    for (let x = 0; x < outW; x++) {
      lines[o++] = raw[i]
      lines[o++] = raw[i + 1]
      lines[o++] = raw[i + 2]
      i += step * 4
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(outW, 0)
  ihdr.writeUInt32BE(outH, 4)
  ihdr[8] = 8 // bits por canal
  ihdr[9] = 2 // RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', await deflate(lines, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}
