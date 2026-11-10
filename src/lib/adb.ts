import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { agentFor, DeviceGoneError, type AgentClient } from './agent'

export { DeviceGoneError }

function findAdb(): string {
  if (process.env.ADB_PATH) return process.env.ADB_PATH
  const exe = process.platform === 'win32' ? 'adb.exe' : 'adb'
  const sdks = [
    process.env.ANDROID_HOME,
    process.env.ANDROID_SDK_ROOT,
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Android', 'Sdk'),
  ].filter(Boolean) as string[]
  for (const sdk of sdks) {
    const p = path.join(sdk, 'platform-tools', exe)
    if (fs.existsSync(p)) return p
  }
  return 'adb'
}

export const ADB_BIN = findAdb()

export interface DeviceEntry {
  serial: string
  state: string
  model?: string
  transport?: string
}

export class AdbError extends Error {}

export class Adb {
  constructor(
    public serial?: string,
    /** Chamado com cada comando executado (para o log). */
    public onCommand?: (cmd: string) => void,
  ) {}

  /** Erro de comando com o celular fora do ar vira DeviceGoneError, com uma mensagem que explica. */
  async run(args: string[], opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<Buffer> {
    try {
      return await this.exec(args, opts)
    } catch (e) {
      throw (await this.goneError()) ?? e
    }
  }

  /** DeviceGoneError se este celular não está mais disponível no adb; null se está. */
  async goneError(): Promise<DeviceGoneError | null> {
    if (!this.serial) return null
    const devices = await new Adb().devices().catch(() => null)
    if (!devices) return null // o próprio adb falhou: o erro original já diz isso
    const state = devices.find((d) => d.serial === this.serial)?.state
    if (state === 'device') return null
    agentFor(this.serial, (args, opts) => this.run(args, opts), ADB_BIN).reset()
    if (state === 'unauthorized') return new DeviceGoneError(`Celular sem autorização (${this.serial}): aceite a depuração USB na tela do aparelho`)
    if (state) return new DeviceGoneError(`Celular indisponível (${this.serial}: ${state}): confira o cabo e a depuração USB`)
    return new DeviceGoneError(`Celular desconectado (${this.serial}): confira o cabo e a depuração USB`)
  }

  private exec(args: string[], opts: { timeoutMs?: number; quiet?: boolean }): Promise<Buffer> {
    const full = this.serial ? ['-s', this.serial, ...args] : args
    if (!opts.quiet) this.onCommand?.(`adb ${args.join(' ')}`)
    return new Promise((resolve, reject) => {
      const child = spawn(ADB_BIN, full, { windowsHide: true })
      const out: Buffer[] = []
      const err: Buffer[] = []
      const timer = setTimeout(() => {
        child.kill()
        reject(new AdbError(`adb ${args.join(' ')}: timeout de ${opts.timeoutMs ?? 30000}ms`))
      }, opts.timeoutMs ?? 30000)
      child.stdout.on('data', (d) => out.push(d))
      child.stderr.on('data', (d) => err.push(d))
      child.on('error', (e) => {
        clearTimeout(timer)
        reject(new AdbError(`não consegui rodar o adb (${ADB_BIN}): ${e.message}`))
      })
      child.on('close', (code) => {
        clearTimeout(timer)
        if (code === 0) resolve(Buffer.concat(out))
        else reject(new AdbError(Buffer.concat(err).toString().trim() || `adb saiu com código ${code}`))
      })
    })
  }

  async shell(cmd: string, opts: { timeoutMs?: number; quiet?: boolean } = {}): Promise<string> {
    if (!opts.quiet) this.onCommand?.(`adb shell ${cmd}`)
    const buf = await this.run(['shell', cmd], { ...opts, quiet: true })
    return buf.toString('utf8')
  }

  async devices(): Promise<DeviceEntry[]> {
    const out = (await this.run(['devices', '-l'], { quiet: true, timeoutMs: 8000 })).toString()
    return out
      .split(/\r?\n/)
      .slice(1)
      .map((l) => l.trim())
      .filter(Boolean)
      .map((line) => {
        const [serial, state, ...rest] = line.split(/\s+/)
        const kv = Object.fromEntries(rest.map((p) => p.split(':') as [string, string]))
        return { serial, state, model: kv.model?.replace(/_/g, ' '), transport: kv.usb ? 'usb' : serial.includes(':') ? 'wifi' : undefined }
      })
  }

  /** Tamanho da tela como está agora (girada, a largura e a altura trocam). */
  async screenSize(): Promise<{ w: number; h: number }> {
    const out = await this.shell('dumpsys window displays 2>/dev/null | grep cur=; true', { quiet: true })
    const m = out.match(/\bcur=(\d+)x(\d+)/)
    return m ? { w: Number(m[1]), h: Number(m[2]) } : this.naturalSize()
  }

  /** Tamanho da tela na orientação natural do aparelho (o `wm size` não muda ao girar). */
  async naturalSize(): Promise<{ w: number; h: number }> {
    const out = await this.shell('wm size', { quiet: true })
    const m = out.match(/Override size:\s*(\d+)x(\d+)/) ?? out.match(/Physical size:\s*(\d+)x(\d+)/)
    if (!m) throw new AdbError(`não consegui ler o tamanho da tela: ${out.trim()}`)
    return { w: Number(m[1]), h: Number(m[2]) }
  }

  screencap(quiet = true): Promise<Buffer> {
    return this.run(['exec-out', 'screencap', '-p'], { quiet, timeoutMs: 10000 })
  }

  /** Agente rápido no celular (null sem serial ou com E2E_BOX_NO_AGENT=1). */
  agent(): AgentClient | null {
    if (!this.serial || process.env.E2E_BOX_NO_AGENT === '1') return null
    const a = agentFor(this.serial, (args, opts) => this.run(args, opts), ADB_BIN)
    return a.disabled ? null : a
  }

  /** O agente está conectado (leituras rápidas: dá para esperar a tela estabilizar). */
  get fast() {
    return !!this.agent()?.ready
  }

  /** `quiet`: não registra no log (leituras repetidas de quem está esperando a tela). */
  async dumpHierarchy(opts: { quiet?: boolean } = {}): Promise<string> {
    const agent = this.agent()
    if (agent) {
      try {
        const xml = await agent.dump()
        if (!opts.quiet) this.onCommand?.('adb agent dump')
        return xml
      } catch (e) {
        const gone = e instanceof DeviceGoneError ? e : await this.goneError()
        if (gone) throw gone
        this.onCommand?.(`agente indisponível, usando uiautomator: ${(e as Error).message}`)
      }
    }
    return this.dumpWithUiautomator()
  }

  /** Digita texto com acento no campo focado pelo agente. false se o agente não estiver disponível. */
  async setText(text: string): Promise<boolean> {
    const agent = this.agent()
    if (!agent) return false
    try {
      await agent.setText(text)
      return true
    } catch (e) {
      // Campo que não aceita texto pela acessibilidade: quem chamou digita como teclado.
      this.onCommand?.(`agente não conseguiu escrever no campo: ${(e as Error).message}`)
      return false
    }
  }

  private async dumpWithUiautomator(): Promise<string> {
    this.onCommand?.('adb exec-out uiautomator dump')
    let lastErr = ''
    for (let i = 0; i < 4; i++) {
      try {
        const out = (await this.run(['exec-out', 'uiautomator', 'dump', '/dev/tty'], { quiet: true, timeoutMs: 20000 })).toString('utf8')
        const start = out.indexOf('<?xml')
        const end = out.lastIndexOf('</hierarchy>')
        if (start >= 0 && end > start) return out.slice(start, end + '</hierarchy>'.length)
        lastErr = out.trim()
        // Alguns aparelhos não escrevem em /dev/tty: usa arquivo.
        await this.run(['shell', 'uiautomator dump /sdcard/e2e-box-dump.xml'], { quiet: true, timeoutMs: 20000 })
        const file = (await this.run(['exec-out', 'cat /sdcard/e2e-box-dump.xml'], { quiet: true })).toString('utf8')
        if (file.includes('</hierarchy>')) return file
      } catch (e) {
        if (e instanceof DeviceGoneError) throw e
        lastErr = (e as Error).message
      }
      await new Promise((r) => setTimeout(r, 300 + i * 300))
    }
    throw new AdbError(`uiautomator dump falhou: ${lastErr}`)
  }

  /** Tira o foco do campo pelo agente; sem agente, não há como fazer sem arriscar sair da tela. */
  async clearFocus(): Promise<void> {
    await this.agent()?.blur().catch((e) => this.onCommand?.(`agente não conseguiu tirar o foco: ${(e as Error).message}`))
  }

  /**
   * Teclado ocupando espaço na tela. Com teclado físico (emulador) o Android diz "aberto" com
   * altura zero, e o `back` do hideKeyboard sairia da tela. O mIsInputViewShown não serve: continua
   * true depois que o teclado fecha. Sem a linha de insets (Android antigo), vale o mInputShown.
   */
  async keyboardShown(): Promise<boolean> {
    const win = await this.shell('dumpsys window 2>/dev/null | grep type=ime; true', { quiet: true }).catch(() => '')
    const m = win.match(/type=ime frame=\[-?\d+,(-?\d+)\]\[-?\d+,(-?\d+)\].*? visible=(true|false)/)
    if (m) return m[3] === 'true' && Number(m[2]) > Number(m[1])
    const out = await this.shell('dumpsys input_method', { quiet: true }).catch(() => '')
    return /mInputShown=true/.test(out)
  }

  /** A janela de splash do Android continua por cima do app, mesmo com a tela dele já na hierarquia. */
  async splashShowing(appId: string): Promise<boolean> {
    const out = await this.shell(`dumpsys window windows 2>/dev/null | grep -c "Splash Screen ${appId}"; true`, { quiet: true })
    return Number(out.trim()) > 0
  }

  async battery(): Promise<{ level: number; charging: boolean } | null> {
    try {
      const out = await this.shell('dumpsys battery', { quiet: true, timeoutMs: 5000 })
      const level = Number(out.match(/level:\s*(\d+)/)?.[1])
      const charging = /(AC|USB|Wireless) powered:\s*true/.test(out)
      return Number.isFinite(level) ? { level, charging } : null
    } catch {
      return null
    }
  }
}
