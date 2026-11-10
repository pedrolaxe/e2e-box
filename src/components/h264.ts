// Toca o H.264 cru (Annex B) do `screenrecord` num <canvas> usando WebCodecs.
// O stream não tem container: separa as NAL units pelos start codes, junta cada quadro
// (access unit) e manda para o VideoDecoder. Quadro novo = fatia com first_mb_in_slice 0.

export const videoSupported = () => typeof window !== 'undefined' && 'VideoDecoder' in window

const START = [0, 0, 0, 1]
const hex = (n: number) => n.toString(16).padStart(2, '0')

export class H264Player {
  private decoder?: VideoDecoder
  private codec = ''
  private pending = new Uint8Array(0)
  private au: Uint8Array[] = []
  private auHasSlice = false
  private auKey = false
  private gotKey = false
  private ts = 0
  private flushTimer?: ReturnType<typeof setTimeout>
  frames = 0

  constructor(
    private canvas: HTMLCanvasElement,
    private onFrame?: () => void,
  ) {}

  push(chunk: Uint8Array) {
    const buf = new Uint8Array(this.pending.length + chunk.length)
    buf.set(this.pending)
    buf.set(chunk, this.pending.length)
    // Procura start codes (00 00 01); cada NAL vai até o próximo.
    const starts: number[] = []
    for (let i = 0; i + 2 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0 && buf[i + 2] === 1) {
        starts.push(i + 3)
        i += 2
      }
    }
    if (!starts.length) {
      this.pending = buf
      return
    }
    for (let k = 0; k < starts.length - 1; k++) {
      let end = starts[k + 1] - 3
      if (end > starts[k] && buf[end - 1] === 0) end-- // start code de 4 bytes
      this.nal(buf.subarray(starts[k], end))
    }
    // O último NAL só termina no próximo start code; se o stream parar (tela parada), fecha o
    // quadro mesmo assim para ele aparecer sem esperar a próxima mudança.
    this.pending = buf.slice(starts[starts.length - 1] - 3)
    clearTimeout(this.flushTimer)
    this.flushTimer = setTimeout(() => {
      const rest = this.pending.subarray(3)
      if (rest.length) {
        this.pending = new Uint8Array(0)
        this.nal(rest.slice())
        this.flush()
      }
    }, 25)
  }

  private nal(n: Uint8Array) {
    if (!n.length) return
    const type = n[0] & 0x1f
    const isSlice = type === 1 || type === 5
    // Começo de quadro novo: NAL que não é fatia depois de fatias, ou fatia com first_mb 0.
    if (this.auHasSlice && (!isSlice || (n[1] & 0x80) !== 0)) this.flush()
    if (type === 7) this.configure(n)
    this.au.push(n)
    if (isSlice) this.auHasSlice = true
    if (type === 5) this.auKey = true
  }

  private configure(sps: Uint8Array) {
    const codec = `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
    if (codec === this.codec && this.decoder?.state === 'configured') return
    this.codec = codec
    this.decoder?.close()
    this.gotKey = false
    this.decoder = new VideoDecoder({
      output: (frame) => {
        if (this.canvas.width !== frame.displayWidth) this.canvas.width = frame.displayWidth
        if (this.canvas.height !== frame.displayHeight) this.canvas.height = frame.displayHeight
        this.canvas.getContext('2d')?.drawImage(frame, 0, 0)
        frame.close()
        this.frames++
        this.onFrame?.()
      },
      error: () => {
        this.codec = ''
      },
    })
    this.decoder.configure({ codec, optimizeForLatency: true })
  }

  private flush() {
    const au = this.au
    const key = this.auKey
    const hasSlice = this.auHasSlice
    this.au = []
    this.auHasSlice = false
    this.auKey = false
    if (!hasSlice || !this.decoder || this.decoder.state !== 'configured') return
    if (!key && !this.gotKey) return // espera o primeiro quadro-chave
    if (key) this.gotKey = true
    const size = au.reduce((s, n) => s + START.length + n.length, 0)
    const data = new Uint8Array(size)
    let o = 0
    for (const n of au) {
      data.set(START, o)
      data.set(n, o + START.length)
      o += START.length + n.length
    }
    this.ts += 33333
    try {
      this.decoder.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: this.ts, data }))
    } catch {
      this.gotKey = false
    }
  }

  close() {
    clearTimeout(this.flushTimer)
    try {
      this.decoder?.close()
    } catch {
      // já fechado
    }
  }
}
