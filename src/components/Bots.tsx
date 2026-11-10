export type BotId = 'reader' | 'tapper' | 'typer' | 'checker'

export const BOTS: { id: BotId; name: string; role: string; color: string; doing: string }[] = [
  { id: 'reader', name: 'Reader', role: 'lê a tela', color: 'var(--teal)', doing: 'lendo' },
  { id: 'tapper', name: 'Tapper', role: 'toques e arrastes', color: 'var(--purple)', doing: 'tocando' },
  { id: 'typer', name: 'Typer', role: 'teclado', color: 'var(--pink)', doing: 'digitando' },
  { id: 'checker', name: 'Checker', role: 'asserts', color: 'var(--red)', doing: 'conferindo' },
]

/** Descobre qual "bot" fez uma linha do log. */
export function botFor(level: string, msg: string): BotId | null {
  if (level === 'ok' || level === 'fail') return 'checker'
  if (level !== 'adb') return null
  if (/uiautomator|agent dump/.test(msg)) return 'reader'
  if (/input (tap|swipe)/.test(msg)) return 'tapper'
  if (/input (text|keyevent)|ADB_INPUT|agent settext/.test(msg)) return 'typer'
  return null
}

function Eyes({ y }: { y: number }) {
  return (
    <g className="eyes">
      <circle cx="15" cy={y} r="3.6" fill="#fff" />
      <circle cx="25" cy={y} r="3.6" fill="#fff" />
      <g className="pupils">
        <circle cx="15.8" cy={y + 0.6} r="1.7" fill="#1b1631" />
        <circle cx="25.8" cy={y + 0.6} r="1.7" fill="#1b1631" />
      </g>
    </g>
  )
}

function Face({ id, color }: { id: BotId; color: string }) {
  switch (id) {
    case 'reader':
      return (
        <svg viewBox="0 0 40 40">
          <path className="body" d="M20 3l4 5 6-2 1 6 6 2-3 5 3 5-6 2-1 6-6-2-4 5-4-5-6 2-1-6-6-2 3-5-3-5 6-2 1-6 6 2z" fill={color} />
          <Eyes y={19} />
        </svg>
      )
    case 'tapper':
      return (
        <svg viewBox="0 0 40 40">
          <path className="body" d="M8 16c0-7 5-12 12-12s12 5 12 12v12c0 4-3 8-6 8l-2-4-2 4h-4l-2-4-2 4c-3 0-6-4-6-8z" fill={color} />
          <Eyes y={17} />
        </svg>
      )
    case 'typer':
      return (
        <svg viewBox="0 0 40 40">
          <path className="body" d="M20 35C8 27 4 21 4 14c0-5 4-9 9-9 3 0 5 1 7 4 2-3 4-4 7-4 5 0 9 4 9 9 0 7-4 13-16 21z" fill={color} />
          <Eyes y={16} />
          <rect className="mouth" x="14" y="23" width="12" height="3" rx="1.5" fill="#1b1631" opacity=".6" />
        </svg>
      )
    case 'checker':
      return (
        <svg viewBox="0 0 40 40">
          <path className="body" d="M20 4c2 0 3 1 4 3l12 21c2 4 0 8-4 8H8c-4 0-6-4-4-8L16 7c1-2 2-3 4-3z" fill={color} />
          <Eyes y={23} />
        </svg>
      )
  }
}

/**
 * `active`: última vez que cada bot apareceu no log. `failAt`: última falha pega pelo Checker.
 * Cada bot tem a própria animação enquanto trabalha (ver .bot.busy.<id> no CSS).
 */
export function Bots({ active, failAt, now }: { active: Record<BotId, number>; failAt: number; now: number }) {
  return (
    <div className="bots" aria-label="Mascotes da execução">
      {BOTS.map((b, i) => {
        const busy = now - (active[b.id] ?? 0) < 900
        const caught = b.id === 'checker' && now - failAt < 2500
        const label = caught ? 'pegou!' : busy ? b.doing : b.name
        return (
          <div
            key={b.id}
            className={`bot ${b.id} ${busy ? 'busy' : ''} ${caught ? 'caught' : ''}`}
            style={{ ['--bot' as string]: b.color, ['--blink-delay' as string]: `${i * 1.3}s` }}
            title={`${b.name}: ${b.role}`}
          >
            <div className="face" aria-hidden="true">
              <Face id={b.id} color={b.color} />
              {b.id === 'tapper' && busy && <span className="ripple" />}
            </div>
            <div className="name">{label}</div>
          </div>
        )
      })}
    </div>
  )
}
