import { spawn, type ChildProcess } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { ROOT } from './config'

// Cliente do agente que roda no celular (agent/src/dev/e2ebox/Agent.java): lê a tela em ~20ms
// em vez dos 1–3s do `uiautomator dump`, e digita texto com acento no campo focado.

const DEVICE_JAR = '/data/local/tmp/e2e-box-agent.jar'
/** O nome real leva um sufixo aleatório por sessão. */
const SOCKET_PREFIX = 'e2e-box-agent'

/**
 * O jar fica na pasta do e2e-box, que não é a pasta atual quando a CLI roda no repo do app
 * (`.e2e-box/` ou `.maestro/`): a CLI informa a sua em E2E_BOX_HOME. Lido na hora, não no import.
 */
const agentJar = () => path.join(process.env.E2E_BOX_HOME ?? ROOT, 'agent', 'dist', 'e2e-box-agent.jar')

type Run = (args: string[], opts?: { timeoutMs?: number; quiet?: boolean }) => Promise<Buffer>

export class AgentError extends Error {}

/** O celular saiu do adb (cabo, offline, sem autorização). A mensagem já é a que o usuário lê. */
export class DeviceGoneError extends Error {}

export class AgentClient {
  private socket?: net.Socket
  private child?: ChildProcess
  private buf = Buffer.alloc(0)
  private queue: { resolve: (s: string) => void; reject: (e: Error) => void }[] = []
  private starting?: Promise<void>
  private socketName = SOCKET_PREFIX
  private secret = ''
  private port?: number
  /** Depois de falhar ao subir, não tenta de novo nesta sessão (usa o uiautomator). */
  disabled = false

  constructor(
    private serial: string,
    private run: Run,
    private adbBin: string,
  ) {}

  get ready() {
    return !!this.socket && !this.socket.destroyed
  }

  private async ensure() {
    if (this.ready) return
    if (this.disabled) throw new AgentError('agente desativado')
    this.starting ??= this.start().finally(() => (this.starting = undefined))
    await this.starting
  }

  /**
   * Sobe um agente novo para esta sessão, com nome de socket e segredo aleatórios, e confirma
   * por HMAC que é ele do outro lado. Nunca reaproveita um agente que já estava no ar: um app
   * do aparelho poderia ter ocupado o socket e receberia o que for digitado (senha inclusive).
   */
  private async start() {
    const AGENT_JAR = agentJar()
    if (!fs.existsSync(AGENT_JAR)) {
      this.disabled = true
      throw new AgentError(`agente não compilado (${AGENT_JAR}); rode: node agent/build.mjs`)
    }
    try {
      const local = crypto.createHash('md5').update(fs.readFileSync(AGENT_JAR)).digest('hex')
      const remote = (await this.run(['shell', `md5sum ${DEVICE_JAR} 2>/dev/null`], { quiet: true }).catch(() => Buffer.from('')))
        .toString()
        .split(/\s+/)[0]
      if (remote !== local) await this.run(['push', AGENT_JAR, DEVICE_JAR], { quiet: true })
      // Só um cliente de UiAutomation por vez: encerra agentes de sessões anteriores.
      // O padrão inclui o nome antigo do agente, que pode seguir no ar em aparelhos que já rodaram a versão anterior.
      await this.run(['shell', "pkill -f 'dev[.]e2e(box|fun)[.]Agent'"], { quiet: true }).catch(() => undefined)

      this.socketName = `${SOCKET_PREFIX}-${crypto.randomBytes(8).toString('hex')}`
      this.secret = crypto.randomBytes(24).toString('hex')
      await this.spawnAgent()
      const port = await this.forward()
      await this.connect(port)
      await this.handshake()
      if ((await this.request('ping')) !== 'pong') throw new AgentError('agente não respondeu')
    } catch (e) {
      this.close()
      // Celular fora do ar não diz nada sobre o agente: tenta de novo quando ele voltar.
      this.disabled = !(e instanceof DeviceGoneError)
      throw e instanceof AgentError || e instanceof DeviceGoneError ? e : new AgentError(`não consegui subir o agente: ${(e as Error).message}`)
    }
  }

  /** Os dois lados provam que conhecem o segredo desta sessão (HMAC-SHA256 de um nonce novo). */
  private async handshake() {
    const nonce = crypto.randomBytes(16).toString('hex')
    const hmac = (msg: string) => crypto.createHmac('sha256', this.secret).update(msg).digest('hex')
    const got = Buffer.from(await this.request(`hello ${nonce} ${hmac(`client:${nonce}`)}`), 'utf8')
    const want = Buffer.from(hmac(nonce), 'utf8')
    if (got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      throw new AgentError('o socket não respondeu como o agente desta sessão (handshake inválido)')
    }
  }

  private async forward(): Promise<number> {
    if (this.port) await this.run(['forward', '--remove', `tcp:${this.port}`], { quiet: true }).catch(() => undefined)
    const out = (await this.run(['forward', 'tcp:0', `localabstract:${this.socketName}`], { quiet: true })).toString().trim()
    const port = Number(out)
    if (!port) throw new AgentError(`adb forward devolveu "${out}"`)
    this.port = port
    return port
  }

  private spawnAgent() {
    return new Promise<void>((resolve, reject) => {
      const cmd = `CLASSPATH=${DEVICE_JAR} app_process / dev.e2ebox.Agent ${this.socketName} ${this.secret}`
      const child = spawn(this.adbBin, ['-s', this.serial, 'shell', cmd], {
        windowsHide: true,
      })
      this.child = child
      let out = ''
      const timer = setTimeout(() => reject(new AgentError(`agente não ficou pronto: ${out.trim() || 'sem saída'}`)), 10000)
      child.stdout.on('data', (d) => {
        out += d.toString()
        if (out.includes('READY')) {
          clearTimeout(timer)
          resolve()
        } else if (out.includes('ERROR')) {
          clearTimeout(timer)
          reject(new AgentError(out.trim()))
        }
      })
      child.stderr.on('data', (d) => (out += d.toString()))
      child.on('exit', () => {
        clearTimeout(timer)
        if (this.child === child) this.child = undefined
        this.close()
        reject(new AgentError(`agente saiu: ${out.trim() || 'sem saída'}`))
      })
    })
  }

  private connect(port: number) {
    return new Promise<void>((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => {
        this.socket = socket
        this.buf = Buffer.alloc(0)
        resolve()
      })
      socket.once('error', reject)
      socket.on('data', (d) => this.onData(d))
      socket.on('close', () => {
        if (this.socket === socket) this.socket = undefined
        for (const q of this.queue.splice(0)) q.reject(new AgentError('conexão com o agente caiu'))
      })
    })
  }

  private onData(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d])
    while (true) {
      const nl = this.buf.indexOf(10)
      if (nl < 0) return
      const head = this.buf.subarray(0, nl).toString()
      if (head.startsWith('ERR')) {
        this.buf = this.buf.subarray(nl + 1)
        this.queue.shift()?.reject(new AgentError(head.slice(4)))
        continue
      }
      const len = Number(head.split(' ')[1])
      if (this.buf.length < nl + 1 + len) return
      const body = this.buf.subarray(nl + 1, nl + 1 + len).toString('utf8')
      this.buf = this.buf.subarray(nl + 1 + len)
      this.queue.shift()?.resolve(body)
    }
  }

  private request(cmd: string, timeoutMs = 10000): Promise<string> {
    return new Promise((resolve, reject) => {
      if (!this.socket) return reject(new AgentError('agente desconectado'))
      const timer = setTimeout(() => {
        this.close()
        reject(new AgentError(`agente não respondeu a "${cmd.split(' ')[0]}"`))
      }, timeoutMs)
      this.queue.push({
        resolve: (s) => {
          clearTimeout(timer)
          resolve(s)
        },
        reject: (e) => {
          clearTimeout(timer)
          reject(e)
        },
      })
      this.socket.write(cmd + '\n')
    })
  }

  async dump(): Promise<string> {
    await this.ensure()
    return this.request('dump')
  }

  /** Acrescenta o texto no campo focado (aceita acento). */
  async setText(text: string): Promise<void> {
    await this.ensure()
    await this.request(`settext ${Buffer.from(text, 'utf8').toString('base64')}`)
  }

  /** Tira o foco do campo atual. */
  async blur(): Promise<void> {
    await this.ensure()
    await this.request('blur')
  }

  close() {
    this.socket?.destroy()
    this.socket = undefined
  }

  /** O celular saiu do adb: quando voltar, sobe um agente novo. */
  reset() {
    this.close()
    this.disabled = false
  }
}

// Um agente por device, compartilhado no processo (sobrevive ao hot reload do Next).
const g = globalThis as unknown as { __e2eBoxAgents?: Map<string, AgentClient> }
const agents = (g.__e2eBoxAgents ??= new Map())

export function agentFor(serial: string, run: Run, adbBin: string): AgentClient {
  let a = agents.get(serial)
  if (!a) {
    a = new AgentClient(serial, run, adbBin)
    agents.set(serial, a)
  }
  return a
}
