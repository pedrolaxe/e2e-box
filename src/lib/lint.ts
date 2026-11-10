import { isMap, isScalar, isSeq, parseAllDocuments, type YAMLMap, type YAMLSeq } from 'yaml'
import type { Lang } from './lang'

// Aponta passos que passam hoje e quebram amanhã. Roda no editor (a cada alteração) e no início
// da execução, então não pode depender de Node.

export interface FlowIssue {
  /** Mesmo formato do stepId do motor: é por ele que a sugestão da execução chega ao passo. */
  path: string
  line: number
  /** Trecho do passo no texto (sem o "- "), para o editor trocar por um seletor melhor. */
  start: number
  end: number
  message: string
  /** Ao rodar, o motor consegue sugerir um seletor (o toque tem posição conhecida na tela). */
  canSuggest: boolean
}

/** Contêineres que cobrem a tela inteira: o toque cai no meio, em qualquer coisa que esteja lá. */
export const isRootId = (id: unknown) =>
  typeof id === 'string' && /^(android:id\/)?(content|action_bar_root|decor_content_parent)$/.test(id.split(':id/').pop() ?? id)

const TAPS = new Set(['tapOn', 'doubleTapOn', 'longPressOn'])

// O motor usa em português (log da execução); o editor do painel, no idioma escolhido.
const MESSAGES = {
  'pt-BR': {
    noSelector: 'Seletor vazio: nunca encontra elemento e o passo falha. Grave o toque de novo ou apague o passo.',
    iconFont: 'Ícone de fonte: o caractere muda se a fonte de ícones mudar, e não diz o que o botão faz.',
    point: (p: unknown) => `Posição fixa (${p}): quebra com outro tamanho de tela ou se o layout mudar.`,
    rootId: (id: unknown) => `"${id}" é a raiz da tela: o toque cai no meio dela, em qualquer elemento.`,
  },
  en: {
    noSelector: 'Empty selector: never finds an element and the step fails. Record the tap again or delete the step.',
    iconFont: 'Icon font glyph: the character changes if the icon font changes, and it does not say what the button does.',
    point: (p: unknown) => `Fixed position (${p}): breaks on another screen size or if the layout changes.`,
    rootId: (id: unknown) => `"${id}" is the screen root: the tap lands in its middle, on any element.`,
  },
} satisfies Record<Lang, unknown>
type Msgs = (typeof MESSAGES)['pt-BR']

function textProblem(text: unknown, m: Msgs): string | null {
  if (text === '' || text == null) return m.noSelector
  // Faixas de uso privado do Unicode: é o desenho de um ícone, não um texto.
  if (typeof text === 'string' && /[\uE000-\uF8FF]/.test(text)) return m.iconFont
  return null
}

function tapProblem(value: unknown, m: Msgs): string | null {
  if (isScalar(value)) return textProblem(value.value, m)
  if (!isMap(value)) return null
  const get = (key: string) => (value as YAMLMap).get(key)
  const text = get('text') === undefined ? null : textProblem(get('text'), m)
  if (text) return text
  if (get('point') != null) return m.point(get('point'))
  if (isRootId(get('id'))) return m.rootId(get('id'))
  return null
}

/**
 * Falta o `---` entre o cabeçalho e os passos: acrescenta. Só mexe se o YAML estiver inválido,
 * porque uma lista logo depois de uma chave do cabeçalho pode ser legítima.
 */
export function repairFlow(text: string): string {
  if (/^---\s*$/m.test(text)) return text
  const first = text.search(/^- /m)
  if (first <= 0 || !/^[\w-]+:/m.test(text.slice(0, first))) return text
  if (!parseAllDocuments(text).some((d) => d.errors.length)) return text
  return `${text.slice(0, first)}---\n${text.slice(first)}`
}

/** Fluxo só com cabeçalho: abre a lista de passos antes de inserir o primeiro. */
export function withSeparator(text: string): string {
  const fixed = repairFlow(text)
  if (/^---\s*$/m.test(fixed) || /^- /m.test(fixed) || !/^[\w-]+:/m.test(fixed)) return fixed
  return `${fixed}${fixed.endsWith('\n') ? '' : '\n'}---\n`
}

/** Índice do passo de primeiro nível sob o cursor; null no cabeçalho ou com YAML inválido. */
export function stepAt(text: string, offset: number): number | null {
  const docs = parseAllDocuments(text)
  if (!Array.isArray(docs) || docs.some((d) => d.errors.length)) return null
  const seq = docs.map((d) => d.contents).find((c) => isSeq(c))
  if (!isSeq(seq) || !seq.items.length || !seq.range || offset < seq.range[0]) return null
  const items = seq.items as { range?: [number, number, number] | null }[]
  const found = items.findIndex((item) => item.range && offset <= item.range[2])
  return found >= 0 ? found : items.length - 1
}

export function lintFlow(text: string, lang: Lang = 'pt-BR'): FlowIssue[] {
  const m = MESSAGES[lang]
  const issues: FlowIssue[] = []
  const lineOf = (offset: number) => text.slice(0, offset).split('\n').length

  const walk = (seq: YAMLSeq, prefix: string) => {
    seq.items.forEach((item, i) => {
      if (!isMap(item) || item.items.length !== 1) return
      const path = prefix ? `${prefix}.${i}` : String(i)
      const { key, value } = item.items[0]
      const name = isScalar(key) ? String(key.value) : ''
      if (TAPS.has(name)) {
        const message = tapProblem(value, m)
        // O range do yaml inclui a quebra de linha: fica de fora, senão a troca juntaria dois passos.
        const end = item.range ? item.range[0] + text.slice(item.range[0], item.range[1]).trimEnd().length : 0
        if (message && item.range) issues.push({ path, line: lineOf(item.range[0]), start: item.range[0], end, message, canSuggest: isMap(value) && (value.get('point') != null || isRootId(value.get('id'))) })
      } else if (isMap(value)) {
        const commands = value.get('commands', true)
        // repeat e retry repetem o stepId com o número da volta: a primeira é a que vale.
        const inner = name === 'repeat' ? `${path}.r0` : name === 'retry' ? `${path}.t0` : path
        if (isSeq(commands)) walk(commands, inner)
      }
    })
  }

  const docs = parseAllDocuments(text)
  if (!Array.isArray(docs) || docs.some((d) => d.errors.length)) return []
  for (const doc of docs) {
    if (isSeq(doc.contents)) walk(doc.contents, '')
    else if (isMap(doc.contents)) {
      const start = doc.contents.get('onFlowStart', true)
      const complete = doc.contents.get('onFlowComplete', true)
      if (isSeq(start)) walk(start, 'start')
      if (isSeq(complete)) walk(complete, 'complete')
    }
  }
  return issues.sort((a, b) => a.start - b.start)
}
