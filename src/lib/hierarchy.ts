import { XMLParser } from 'fast-xml-parser'

export interface Bounds {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface UiNode {
  idx: number
  parent: number
  depth: number
  text: string
  desc: string
  hint: string
  id: string
  cls: string
  pkg: string
  clickable: boolean
  enabled: boolean
  checked: boolean
  focused: boolean
  selected: boolean
  scrollable: boolean
  /** campo de texto (atributo do agente; o uiautomator não manda, aí vale a classe EditText) */
  editable: boolean
  bounds: Bounds
}

export interface Selector {
  text?: string
  id?: string
  index?: number
  enabled?: boolean
  checked?: boolean
  focused?: boolean
  selected?: boolean
  below?: Selector
  above?: Selector
  leftOf?: Selector
  rightOf?: Selector
  childOf?: Selector
  containsChild?: Selector
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '',
  htmlEntities: true,
  isArray: (name) => name === 'node',
})

function parseBounds(b: string | undefined): Bounds {
  const m = b?.match(/\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]/)
  if (!m) return { x1: 0, y1: 0, x2: 0, y2: 0 }
  return { x1: +m[1], y1: +m[2], x2: +m[3], y2: +m[4] }
}

export function parseHierarchy(xml: string): UiNode[] {
  const doc = parser.parse(xml)
  const out: UiNode[] = []
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const walk = (n: any, depth: number, parent: number) => {
    const node: UiNode = {
      idx: out.length,
      parent,
      depth,
      text: String(n.text ?? ''),
      desc: String(n['content-desc'] ?? ''),
      hint: String(n.hint ?? ''),
      id: String(n['resource-id'] ?? ''),
      cls: String(n.class ?? ''),
      pkg: String(n.package ?? ''),
      clickable: n.clickable === 'true',
      enabled: n.enabled !== 'false',
      checked: n.checked === 'true',
      focused: n.focused === 'true',
      selected: n.selected === 'true',
      scrollable: n.scrollable === 'true',
      editable: n.editable === 'true' || /EditText/.test(String(n.class ?? '')),
      bounds: parseBounds(n.bounds),
    }
    out.push(node)
    for (const c of n.node ?? []) walk(c, depth + 1, node.idx)
  }
  for (const n of doc?.hierarchy?.node ?? []) walk(n, 0, -1)
  return out
}

/** Rotação gravada na raiz do dump (0–3); null se o agente não conseguiu ler. */
export function rotationOf(xml: string): number | null {
  const m = xml.slice(0, 200).match(/<hierarchy rotation="(\d)"/)
  return m ? Number(m[1]) : null
}

export const center = (b: Bounds) => ({ x: Math.round((b.x1 + b.x2) / 2), y: Math.round((b.y1 + b.y2) / 2) })
const area = (b: Bounds) => Math.max(0, b.x2 - b.x1) * Math.max(0, b.y2 - b.y1)

export function isOnScreen(n: UiNode, screen: { w: number; h: number }) {
  const b = n.bounds
  return area(b) > 0 && b.x2 > 0 && b.y2 > 0 && b.x1 < screen.w && b.y1 < screen.h
}

/** Fração do elemento que está dentro da tela (0..1). */
export function visibleFraction(n: UiNode, screen: { w: number; h: number }) {
  const b = n.bounds
  const total = area(b)
  if (!total) return 0
  const clipped = area({ x1: Math.max(0, b.x1), y1: Math.max(0, b.y1), x2: Math.min(screen.w, b.x2), y2: Math.min(screen.h, b.y2) })
  return clipped / total
}

/** Igual ao Maestro: regex que precisa casar o texto inteiro; se a regex for inválida, compara literal. */
export function textMatches(pattern: string, value: string): boolean {
  if (!value) return false
  const v = value.replace(/\s+/g, ' ').trim()
  const p = pattern.trim()
  if (v.toLowerCase() === p.toLowerCase()) return true
  try {
    return new RegExp(`^(?:${p})$`, 'is').test(v)
  } catch {
    return false
  }
}

const nodeMatchesText = (n: UiNode, pattern: string) =>
  textMatches(pattern, n.text) || textMatches(pattern, n.desc) || textMatches(pattern, n.hint)

const idMatches = (n: UiNode, pattern: string) => {
  if (!n.id) return false
  const short = n.id.includes(':id/') ? n.id.split(':id/')[1] : n.id
  return textMatches(pattern, n.id) || textMatches(pattern, short)
}

export function isDescendant(nodes: UiNode[], child: UiNode, ancestor: UiNode) {
  let p = child.parent
  while (p >= 0) {
    if (p === ancestor.idx) return true
    p = nodes[p].parent
  }
  return false
}

/** Todos os elementos que casam com o seletor (sem aplicar `index`). */
export function findAll(nodes: UiNode[], sel: Selector, screen: { w: number; h: number }): UiNode[] {
  let found = nodes.filter((n) => isOnScreen(n, screen))
  if (sel.text != null) found = found.filter((n) => nodeMatchesText(n, sel.text!))
  if (sel.id != null) found = found.filter((n) => idMatches(n, sel.id!))
  if (sel.enabled != null) found = found.filter((n) => n.enabled === sel.enabled)
  if (sel.checked != null) found = found.filter((n) => n.checked === sel.checked)
  if (sel.focused != null) found = found.filter((n) => n.focused === sel.focused)
  if (sel.selected != null) found = found.filter((n) => n.selected === sel.selected)

  const anchor = (s: Selector) => findOne(nodes, s, screen)
  if (sel.below) {
    const a = anchor(sel.below)
    found = a ? found.filter((n) => n.bounds.y1 >= a.bounds.y2).sort((m, n) => m.bounds.y1 - n.bounds.y1) : []
  }
  if (sel.above) {
    const a = anchor(sel.above)
    found = a ? found.filter((n) => n.bounds.y2 <= a.bounds.y1).sort((m, n) => n.bounds.y2 - m.bounds.y2) : []
  }
  if (sel.leftOf) {
    const a = anchor(sel.leftOf)
    found = a ? found.filter((n) => n.bounds.x2 <= a.bounds.x1).sort((m, n) => n.bounds.x2 - m.bounds.x2) : []
  }
  if (sel.rightOf) {
    const a = anchor(sel.rightOf)
    found = a ? found.filter((n) => n.bounds.x1 >= a.bounds.x2).sort((m, n) => m.bounds.x1 - n.bounds.x1) : []
  }
  if (sel.childOf) {
    const a = anchor(sel.childOf)
    found = a ? found.filter((n) => isDescendant(nodes, n, a)) : []
  }
  if (sel.containsChild) {
    const kids = findAll(nodes, sel.containsChild, screen)
    found = found.filter((n) => kids.some((k) => isDescendant(nodes, k, n)))
  }
  return found
}

export function findOne(nodes: UiNode[], sel: Selector, screen: { w: number; h: number }): UiNode | undefined {
  return findAll(nodes, sel, screen)[sel.index ?? 0]
}

/** Elemento mais útil sob um ponto (para o inspetor / gravador). */
export function nodeAt(nodes: UiNode[], x: number, y: number): UiNode | undefined {
  const hits = nodes.filter((n) => n.bounds.x1 <= x && x <= n.bounds.x2 && n.bounds.y1 <= y && y <= n.bounds.y2 && area(n.bounds) > 0)
  const labeled = hits.filter((n) => n.text || n.desc)
  const pool = labeled.length ? labeled : hits.filter((n) => n.id || n.clickable)
  return pool.sort((a, b) => area(a.bounds) - area(b.bounds))[0]
}

export function describeSelector(sel: Selector): string {
  const parts: string[] = []
  if (sel.text != null) parts.push(`"${sel.text}"`)
  if (sel.id != null) parts.push(`#${sel.id}`)
  if (sel.index) parts.push(`[${sel.index}]`)
  for (const k of ['below', 'above', 'leftOf', 'rightOf', 'childOf', 'containsChild'] as const) {
    if (sel[k]) parts.push(`${k} ${describeSelector(sel[k]!)}`)
  }
  return parts.join(' ') || '(seletor vazio)'
}
