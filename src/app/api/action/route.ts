import { nodeAt, parseHierarchy, type UiNode } from '@/lib/hierarchy'
import type { RunEvent } from '@/lib/engine'
import { hub } from '@/lib/hub'
import { describeHolder, lockHolder } from '@/lib/lock'
import { suggest } from '@/lib/suggest'

export const dynamic = 'force-dynamic'

type Action =
  | { type: 'inspect' | 'tap'; x: number; y: number; /** só toca, sem ler a tela nem sugerir passo */ quick?: boolean }
  | { type: 'swipe'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'back' | 'home' | 'enter' | 'hideKeyboard' }
  | { type: 'text'; text: string }

const q = (s: string) => JSON.stringify(s)
const pct = (v: number, total: number) => `${Math.round((v / total) * 100)}%`
const isField = (n: UiNode) => n.editable

function gesture(g: Omit<Extract<RunEvent, { type: 'gesture' }>, 'type' | 'at' | 'manual'>) {
  hub.emit({ type: 'gesture', ...g, at: Date.now(), manual: true })
}

export async function POST(req: Request) {
  const a = (await req.json()) as Action
  if (hub.running && a.type !== 'inspect') return Response.json({ error: 'Tem um fluxo rodando' }, { status: 409 })
  const serial = await hub.ensureSerial()
  if (!serial) return Response.json({ error: 'Nenhum device conectado' }, { status: 404 })
  // Ler a tela daqui derrubaria o agente de quem está rodando em outro processo.
  const holder = lockHolder(serial)
  if (holder) return Response.json({ error: describeHolder(holder) }, { status: 409 })
  const adb = hub.manualAdb()
  try {
    switch (a.type) {
      case 'inspect':
      case 'tap': {
        // A animação sai já; o toque espera a leitura da tela (o passo sugerido é do elemento antes do toque).
        if (a.type === 'tap') gesture({ kind: 'tap', x: a.x, y: a.y })
        if (a.type === 'tap' && a.quick) {
          await adb.shell(`input tap ${Math.round(a.x)} ${Math.round(a.y)}`)
          return Response.json({ suggestions: [] })
        }
        const screen = await adb.screenSize()
        const nodes = parseHierarchy(await adb.dumpHierarchy())
        const node = nodeAt(nodes, a.x, a.y)
        const { suggestions, target } = suggest(nodes, node, a.x, a.y, screen)
        if (a.type === 'tap') await adb.shell(`input tap ${Math.round(a.x)} ${Math.round(a.y)}`)
        return Response.json({
          node: node && { text: node.text, desc: node.desc, id: node.id, cls: node.cls.split('.').pop(), clickable: node.clickable, bounds: node.bounds },
          suggestions,
          target,
          field: node ? isField(node) : false,
          fieldLabel: node && isField(node) ? node.hint || node.text || node.desc : undefined,
        })
      }
      case 'swipe': {
        const screen = await adb.screenSize()
        gesture({ kind: 'swipe', x: a.x1, y: a.y1, x2: a.x2, y2: a.y2, ms: 400 })
        await adb.shell(`input swipe ${a.x1 | 0} ${a.y1 | 0} ${a.x2 | 0} ${a.y2 | 0} 400`)
        const yaml = `- swipe:\n    start: "${pct(a.x1, screen.w)},${pct(a.y1, screen.h)}"\n    end: "${pct(a.x2, screen.w)},${pct(a.y2, screen.h)}"`
        return Response.json({ suggestions: [{ label: 'swipe', yaml }] })
      }
      case 'back':
        await adb.shell('input keyevent 4')
        return Response.json({ suggestions: [{ label: 'back', yaml: '- back' }] })
      case 'home':
        await adb.shell('input keyevent 3')
        return Response.json({ suggestions: [] })
      case 'enter':
        await adb.shell('input keyevent 66')
        return Response.json({ suggestions: [{ label: 'Enter', yaml: '- pressKey: Enter' }] })
      case 'hideKeyboard':
        if (await adb.keyboardShown()) await adb.shell('input keyevent 4')
        else await adb.clearFocus()
        return Response.json({ suggestions: [{ label: 'hideKeyboard', yaml: '- hideKeyboard' }] })
      case 'text': {
        // Com acento, o agente escreve direto no campo; sem acento, digita como teclado.
        if (/^[\x20-\x7e]*$/.test(a.text) || !(await adb.setText(a.text))) {
          const ascii = a.text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
          await adb.shell(`input text '${ascii.replace(/'/g, `'\\''`).replace(/ /g, '%s')}'`)
        }
        return Response.json({ suggestions: [{ label: 'inputText', yaml: `- inputText: ${q(a.text)}` }] })
      }
    }
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 500 })
  }
}
