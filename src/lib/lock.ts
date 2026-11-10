import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Só um cliente de UiAutomation por vez no celular: painel e CLI rodando no mesmo aparelho
// derrubariam o agente um do outro. A trava é um arquivo por device, com o pid de quem roda.

export interface LockHolder {
  pid: number
  kind: 'cli' | 'painel'
  ref: string
}

export class DeviceBusyError extends Error {}

const DIR = path.join(os.tmpdir(), 'e2e-box-locks')
const fileFor = (serial: string) => path.join(DIR, `${serial.replace(/[^\w.-]/g, '_')}.json`)

function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Outro processo vivo rodando fluxo nesse device (trava de processo morto não conta). */
export function lockHolder(serial: string): LockHolder | null {
  try {
    const h = JSON.parse(fs.readFileSync(fileFor(serial), 'utf8')) as LockHolder
    return h.pid !== process.pid && alive(h.pid) ? h : null
  } catch {
    return null
  }
}

export const describeHolder = (h: LockHolder) => `${h.kind === 'cli' ? 'A CLI' : 'O painel'} está rodando ${h.ref} neste celular (pid ${h.pid})`

export function acquireLock(serial: string, kind: LockHolder['kind'], ref: string) {
  fs.mkdirSync(DIR, { recursive: true })
  const file = fileFor(serial)
  const body = JSON.stringify({ pid: process.pid, kind, ref } satisfies LockHolder)
  for (let i = 0; i < 2; i++) {
    try {
      fs.writeFileSync(file, body, { flag: 'wx' })
      return
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
      const h = lockHolder(serial)
      if (h) throw new DeviceBusyError(describeHolder(h))
      fs.rmSync(file, { force: true }) // sobra de processo que morreu
    }
  }
  throw new DeviceBusyError('Outro processo acabou de começar a rodar neste celular')
}

export function releaseLock(serial: string) {
  const file = fileFor(serial)
  try {
    if ((JSON.parse(fs.readFileSync(file, 'utf8')) as LockHolder).pid === process.pid) fs.rmSync(file, { force: true })
  } catch {
    // já não existe
  }
}
