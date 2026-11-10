import { findAll, isDescendant, type UiNode } from './hierarchy'
import { isRootId } from './lint'

const q = (s: string) => JSON.stringify(s)
const pct = (v: number, total: number) => `${Math.round((v / total) * 100)}%`
const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Regex para texto que muda entre execuções:
 * - saudação com nome ("Olá Mathias" -> "Olá .*")
 * - números (contagens, valores, datas: "Agendas (0)" -> "Agendas \(\d+\)")
 */
function dynamicPattern(text: string): { pattern: string; why: string } | null {
  const greeting = text.match(/^(olá|ola|oi|bem[- ]vind[oa]s?|boa (?:tarde|noite)|bom dia|hello|hi)[,!]?\s+\S/i)
  if (greeting) return { pattern: `${escapeRegex(greeting[1])} .*`, why: 'nome muda' }
  if (/\d/.test(text) && /\D/.test(text)) {
    return { pattern: text.split(/\d+/).map(escapeRegex).join('\\d+'), why: 'números mudam' }
  }
  return null
}

/** Gera os comandos YAML que reproduzem um toque nesse elemento (o primeiro é o que o gravador usa). */
export function suggest(nodes: UiNode[], node: UiNode | undefined, x: number, y: number, screen: { w: number; h: number }) {
  const point = `${pct(x, screen.w)},${pct(y, screen.h)}`
  const out: { label: string; yaml: string }[] = []
  let target: string | undefined
  if (node) {
    const label = (node.text || node.desc || (node.editable ? node.hint : '')).replace(/\s+/g, ' ').trim()
    if (label) {
      const exact = escapeRegex(label)
      const same = findAll(nodes, { text: exact }, screen)
      // Texto repetido no botão (content-desc) e no texto dentro dele: usa o de fora, sem index.
      const outer = same.find((n) => n.idx === node.idx || isDescendant(nodes, node, n))
      const index = same.findIndex((n) => n.idx === (outer ?? node).idx)
      const dyn = dynamicPattern(label)
      const tap = (text: string, shown: string) =>
        index > 0
          ? { label: `tapOn "${shown}" [${index}]`, yaml: `- tapOn:\n    text: ${q(text)}\n    index: ${index}` }
          : { label: `tapOn "${shown}"`, yaml: `- tapOn: ${q(text)}` }
      // Saudação com nome: a regex vem primeiro (o nome muda com o usuário logado).
      const regexFirst = dyn?.why === 'nome muda'
      target = regexFirst && dyn ? dyn.pattern : exact
      if (dyn && regexFirst) out.push(tap(dyn.pattern, dyn.pattern))
      out.push(tap(exact, label))
      if (dyn && !regexFirst) out.push({ ...tap(dyn.pattern, dyn.pattern), label: `tapOn "${dyn.pattern}" (${dyn.why})` })
      out.push({ label: `assertVisible "${label}"`, yaml: `- assertVisible: ${q(exact)}` })
      if (dyn) out.push({ label: `assertVisible "${dyn.pattern}"`, yaml: `- assertVisible: ${q(dyn.pattern)}` })
    }
    // A raiz da tela não identifica nada: o gravador cai no ponto, que o editor aponta como frágil.
    if (node.id && !isRootId(node.id)) {
      const id = node.id.includes(':id/') ? node.id.split(':id/')[1] : node.id
      out.push({ label: `tapOn #${id}`, yaml: `- tapOn:\n    id: ${q(id)}` })
    }
  }
  out.push({ label: `tapOn @${point}`, yaml: `- tapOn:\n    point: ${q(point)}` })
  return { suggestions: out, target }
}
