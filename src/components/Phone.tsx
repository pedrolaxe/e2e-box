'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import type { GestureKind } from '@/lib/engine'
import { H264Player, videoSupported } from './h264'

export type Mode = 'inspect' | 'record' | 'control'
type View = 'video' | 'print'

/** Gesto vindo do servidor (fluxo rodando ou ação manual), em pixels do device. */
export interface Gesture {
  id: number
  kind: GestureKind
  x: number
  y: number
  x2?: number
  y2?: number
  ms?: number
}

const GESTURE_MS: Record<GestureKind, number> = { tap: 700, double: 900, long: 1500, swipe: 0 }

export interface Suggestion {
  label: string
  yaml: string
}

interface InspectResult {
  node?: { text: string; desc: string; id: string; cls?: string; clickable: boolean; bounds: { x1: number; y1: number; x2: number; y2: number } }
  suggestions: Suggestion[]
  /** texto/regex do primeiro passo sugerido (vira o alvo do scrollUntilVisible) */
  target?: string
  field?: boolean
  fieldLabel?: string
  error?: string
}

interface Props {
  serial: string | null
  running: boolean
  /** Fluxo aberto no editor: trocar de fluxo encerra a gravação. */
  flowRef: string | null
  /** Último gesto: cada id novo vira uma animação em cima do espelho. */
  gesture: Gesture | null
  /** Chamado ao parar a gravação (a página salva o YAML). */
  onStopRecording: () => void
  onInsert: (yaml: string) => void
  onError: (msg: string) => void
}

async function act(body: object): Promise<InspectResult> {
  const res = await fetch('/api/action', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? 'falhou')
  return json
}

const q = (s: string) => JSON.stringify(s)
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function loadView(): View {
  try {
    const v = localStorage.getItem('e2e-box:view')
    if (v === 'print' || v === 'video') return v === 'video' && !videoSupported() ? 'print' : v
  } catch {}
  return videoSupported() ? 'video' : 'print'
}

export function Phone({ serial, running, flowRef, gesture, onStopRecording, onInsert, onError }: Props) {
  const [view, setView] = useState<View>('print')
  const [src, setSrc] = useState<string | null>(null)
  /** Tamanho real da tela do device (os toques e overlays usam esse sistema de coordenadas). */
  const [devSize, setDevSize] = useState<{ w: number; h: number } | null>(null)
  const [fps, setFps] = useState(0)
  const [offline, setOffline] = useState(false)
  const [mode, setMode] = useState<Mode>('inspect')
  const [inspect, setInspect] = useState<InspectResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [text, setText] = useState('')
  const [textHint, setTextHint] = useState<string | null>(null)
  const [gestures, setGestures] = useState<Gesture[]>([])
  const [, setTick] = useState(0)
  const surfaceRef = useRef<HTMLElement | null>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const screenRef = useRef<HTMLDivElement>(null)
  const textRef = useRef<HTMLInputElement>(null)
  const down = useRef<{ x: number; y: number } | null>(null)
  /** Rolagens gravadas que ainda não viraram passo (viram scrollUntilVisible no próximo toque). */
  const pendingScroll = useRef<{ dir: 'DOWN' | 'UP'; count: number } | null>(null)
  const onStopRef = useRef(onStopRecording)
  onStopRef.current = onStopRecording

  // Só um vídeo por vez no celular: duas abas reconectando se derrubariam sem parar. A aba que abre
  // o vídeo avisa, a outra vai para o print e retoma quando o usuário voltar a ela.
  const tabId = useRef(Math.random().toString(36).slice(2))
  const channel = useRef<BroadcastChannel | null>(null)
  const demoted = useRef(false)
  const [elsewhere, setElsewhere] = useState(false)
  useEffect(() => {
    if (typeof BroadcastChannel === 'undefined') return
    const ch = new BroadcastChannel('e2e-box:video')
    channel.current = ch
    ch.onmessage = (e) => {
      if (e.data?.video === tabId.current) return
      setView((v) => {
        if (v !== 'video') return v
        demoted.current = true
        setElsewhere(true)
        return 'print'
      })
    }
    const reclaim = () => {
      if (!demoted.current || document.hidden) return
      demoted.current = false
      setElsewhere(false)
      setView('video')
    }
    window.addEventListener('focus', reclaim)
    document.addEventListener('visibilitychange', reclaim)
    return () => {
      ch.close()
      channel.current = null
      window.removeEventListener('focus', reclaim)
      document.removeEventListener('visibilitychange', reclaim)
    }
  }, [])

  // WebCodecs só existe no navegador: decidir no render daria HTML diferente do servidor (hidratação).
  const [canVideo, setCanVideo] = useState(false)
  useEffect(() => {
    setCanVideo(videoSupported())
  }, [])
  // Ao abrir ou reconectar, volta à preferência: a queda para print vale só para aquela conexão.
  useEffect(() => {
    if (serial) setView(loadView())
  }, [serial])

  const switchView = (v: View) => {
    demoted.current = false
    setElsewhere(false)
    setView(v)
    try {
      localStorage.setItem('e2e-box:view', v)
    } catch {}
  }

  // Espelho em print: um screencap atrás do outro, sem sobrepor.
  useEffect(() => {
    if (view !== 'print') return
    let alive = true
    let prev: string | null = null
    let frames = 0
    let since = performance.now()
    const loop = async () => {
      while (alive) {
        if (document.hidden) {
          await sleep(800)
          continue
        }
        try {
          const res = await fetch(`/api/screen?t=${Date.now()}`, { cache: 'no-store' })
          if (!res.ok) throw new Error(String(res.status))
          const url = URL.createObjectURL(await res.blob())
          if (!alive) return URL.revokeObjectURL(url)
          setSrc(url)
          setOffline(false)
          if (prev) setTimeout(((u) => () => URL.revokeObjectURL(u))(prev), 1000)
          prev = url
          frames++
          const t = performance.now()
          if (t - since > 2000) {
            setFps(Math.round((frames * 10000) / (t - since)) / 10)
            frames = 0
            since = t
          }
          await sleep(120)
        } catch {
          setOffline(true)
          await sleep(2000)
        }
      }
    }
    loop()
    return () => {
      alive = false
    }
  }, [serial, view])

  // Espelho em vídeo: H.264 do screenrecord decodificado no canvas.
  useEffect(() => {
    if (view !== 'video' || !serial) return
    const canvas = canvasRef.current
    if (!canvas) return
    if (document.hidden) {
      // Aba em segundo plano não toma o vídeo de quem está sendo olhado.
      demoted.current = true
      setElsewhere(true)
      setView('print')
      return
    }
    channel.current?.postMessage({ video: tabId.current })
    const controller = new AbortController()
    let failures = 0
    let player: H264Player | undefined
    let alive = true
    const fpsTimer = setInterval(() => {
      if (!player) return
      setFps(Math.round(player.frames / 2))
      player.frames = 0
    }, 2000)
    const loop = async () => {
      while (alive) {
        try {
          const res = await fetch('/api/video', { signal: controller.signal, cache: 'no-store' })
          if (res.status === 404 || res.status === 503) {
            // Celular fora do ar ou ainda ligando: o espelho volta sozinho quando ele responder.
            setOffline(true)
            await sleep(2000)
            continue
          }
          if (!res.ok || !res.body) throw new Error(String(res.status))
          const [dw, dh] = (res.headers.get('x-device-size') ?? '').split('x').map(Number)
          if (dw && dh) setDevSize({ w: dw, h: dh })
          player?.close()
          player = new H264Player(canvas, () => {
            failures = 0
            setOffline(false)
          })
          const reader = res.body.getReader()
          while (alive) {
            const { value, done } = await reader.read()
            if (done) break
            if (value) player.push(value)
          }
        } catch {
          if (!alive) return
        }
        if (!alive) return
        if (++failures >= 3) {
          setOffline(true)
          onError('Vídeo do espelho indisponível; voltando para o modo print')
          setView('print') // só nesta sessão: a preferência salva continua sendo a do usuário
          return
        }
        // Stream que estava bem e fechou (a tela girou): reabre logo.
        await sleep(failures > 1 ? 1000 : 150)
      }
    }
    loop()
    return () => {
      alive = false
      controller.abort()
      clearInterval(fpsTimer)
      player?.close()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serial, view])

  /** Converte a rolagem pendente em passo: scrollUntilVisible até o alvo, ou scroll/swipe simples. */
  const flushScroll = useCallback(
    (target?: string) => {
      const p = pendingScroll.current
      pendingScroll.current = null
      if (!p) return
      if (target) {
        onInsert(`- scrollUntilVisible:\n    element: ${q(target)}\n    direction: ${p.dir}`)
      } else if (p.dir === 'DOWN') {
        for (let i = 0; i < p.count; i++) onInsert('- scroll')
      } else {
        for (let i = 0; i < p.count; i++) onInsert('- swipe:\n    direction: DOWN')
      }
    },
    [onInsert],
  )

  const stopRecording = useCallback(() => {
    flushScroll()
    setMode('inspect')
    setTextHint(null)
    // Deixa o editor receber o último passo antes de salvar.
    setTimeout(() => onStopRef.current(), 50)
  }, [flushScroll])

  const changeMode = (next: Mode) => {
    if (mode === 'record' && next !== 'record') stopRecording()
    else setMode(next)
  }

  // A gravação para sozinha ao rodar um fluxo ou trocar o fluxo aberto.
  useEffect(() => {
    pendingScroll.current = null
    setMode((m) => (m === 'record' ? 'inspect' : m))
  }, [running, flowRef])

  useEffect(() => {
    if (mode !== 'record') return
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && stopRecording()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [mode, stopRecording])

  // Cada gesto fica na tela só o tempo da animação.
  useEffect(() => {
    if (!gesture) return
    setGestures((g) => [...g.slice(-8), gesture])
    const life = gesture.kind === 'swipe' ? (gesture.ms ?? 400) + 900 : GESTURE_MS[gesture.kind]
    const t = setTimeout(() => setGestures((g) => g.filter((x) => x.id !== gesture.id)), life)
    return () => clearTimeout(t)
  }, [gesture])

  useEffect(() => {
    const onResize = () => setTick((t) => t + 1)
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  /** Converte coordenada da tela do PC para pixels do device. */
  const toDevice = useCallback(
    (clientX: number, clientY: number) => {
      const el = surfaceRef.current
      if (!el || !devSize) return null
      const r = el.getBoundingClientRect()
      return { x: ((clientX - r.left) / r.width) * devSize.w, y: ((clientY - r.top) / r.height) * devSize.h }
    },
    [devSize],
  )

  /** Converte pixels do device para posição dentro do container da tela (overlays). */
  const toBox = (x: number, y: number) => {
    const el = surfaceRef.current
    const scr = screenRef.current
    if (!el || !scr || !devSize) return { left: 0, top: 0 }
    const r = el.getBoundingClientRect()
    const s = scr.getBoundingClientRect()
    return { left: r.left - s.left + (x / devSize.w) * r.width, top: r.top - s.top + (y / devSize.h) * r.height }
  }

  const run = async (body: object, insert: boolean) => {
    setBusy(true)
    try {
      const res = await act(body)
      if (insert && res.suggestions[0]) onInsert(res.suggestions[0].yaml)
      return res
    } catch (e) {
      onError((e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    down.current = { x: e.clientX, y: e.clientY }
  }

  const onPointerUp = async (e: React.PointerEvent) => {
    const start = down.current
    down.current = null
    if (!start || busy) return
    const a = toDevice(start.x, start.y)
    const b = toDevice(e.clientX, e.clientY)
    if (!a || !b) return
    const dist = Math.hypot(e.clientX - start.x, e.clientY - start.y)
    const recording = mode === 'record'
    if (dist > 18) {
      if (mode === 'inspect' || running) return
      const dx = b.x - a.x
      const dy = b.y - a.y
      const vertical = Math.abs(dy) > Math.abs(dx) * 1.5
      if (recording && vertical) {
        // Rolagem: segura e decide no próximo toque (scrollUntilVisible até o que for tocado).
        const dir = dy < 0 ? 'DOWN' : 'UP'
        if (pendingScroll.current && pendingScroll.current.dir !== dir) flushScroll()
        pendingScroll.current = { dir, count: (pendingScroll.current?.count ?? 0) + 1 }
        await run({ type: 'swipe', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, false)
        return
      }
      if (recording) flushScroll()
      await run({ type: 'swipe', x1: a.x, y1: a.y, x2: b.x, y2: b.y }, recording)
      return
    }
    if (mode === 'inspect' || running) {
      setBusy(true)
      try {
        setInspect(await act({ type: 'inspect', ...a }))
      } catch (err) {
        onError((err as Error).message)
      } finally {
        setBusy(false)
      }
      return
    }
    const res = await run({ type: 'tap', ...a, quick: mode === 'control' }, false)
    if (!res || !recording) return
    flushScroll(res.target)
    if (res.suggestions[0]) onInsert(res.suggestions[0].yaml)
    setInspect(res)
    if (res.field) {
      // Campo de texto: o próximo passo natural é digitar.
      setTextHint(res.fieldLabel ? `texto para "${res.fieldLabel}"…` : 'texto para o campo…')
      requestAnimationFrame(() => textRef.current?.focus())
    } else {
      setTextHint(null)
    }
  }

  const key = (type: string) => {
    if (mode === 'record') flushScroll()
    return run({ type }, mode === 'record')
  }
  const sendText = async () => {
    if (!text) return
    if (mode === 'record') flushScroll()
    await run({ type: 'text', text }, mode === 'record')
    setText('')
    setTextHint(null)
  }

  const hl = inspect?.node && devSize ? (() => {
    const b = inspect.node!.bounds
    const p1 = toBox(b.x1, b.y1)
    const p2 = toBox(b.x2, b.y2)
    return { left: p1.left, top: p1.top, width: p2.left - p1.left, height: p2.top - p1.top }
  })() : null

  const surfaceProps = {
    onPointerDown,
    onPointerUp,
    style: { opacity: busy ? 0.85 : 1 },
  }

  return (
    <div className="card phone-card">
      <div className="phone-head">
        <div className="modes" role="group" aria-label="O que o clique no espelho faz">
          <button className={mode === 'inspect' ? 'on' : ''} aria-pressed={mode === 'inspect'} onClick={() => changeMode('inspect')} title="Clique mostra o elemento e sugere o passo">Inspecionar</button>
          <button className={mode === 'record' ? 'on rec' : ''} aria-pressed={mode === 'record'} onClick={() => changeMode('record')} title="Clique toca no celular e adiciona o passo no YAML" disabled={running || !flowRef}>● Gravar</button>
          <button className={mode === 'control' ? 'on' : ''} aria-pressed={mode === 'control'} onClick={() => changeMode('control')} title="Clique só toca no celular">Controlar</button>
        </div>
      </div>
      <div className="phone-wrap">
        <div className={`phone ${devSize && devSize.w > devSize.h ? 'landscape' : ''}`}>
          <div className="screen" ref={screenRef}>
            {mode === 'record' && !running && (
              <button className="rec-badge" onClick={stopRecording} title="Parar gravação e salvar (Esc)">
                ■ REC · parar
              </button>
            )}
            {view === 'video' ? (
              <canvas
                ref={(el) => {
                  canvasRef.current = el
                  surfaceRef.current = el
                }}
                className="surface"
                {...surfaceProps}
              />
            ) : src && !offline ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                ref={(el) => {
                  surfaceRef.current = el
                }}
                className="surface"
                src={src}
                alt="tela do device"
                draggable={false}
                onLoad={(e) => {
                  const i = e.currentTarget
                  if (!devSize || devSize.w !== i.naturalWidth) setDevSize({ w: i.naturalWidth, h: i.naturalHeight })
                }}
                {...surfaceProps}
              />
            ) : null}
            {(offline || !serial) && (
              <div className="no-device">
                Celular não disponível.
                <br />
                <br />
                Ligue a <b>depuração USB</b> e confira com <code>adb devices</code>.
              </div>
            )}
            {hl && <div className="hl" style={hl} />}
            {devSize ? (
              <>
                {gestures.filter((g) => g.kind !== 'swipe').map((g) => (
                  <div key={g.id} className={`g-tap ${g.kind}`} style={toBox(g.x, g.y)}>
                    <i />
                    <i />
                    <b />
                  </div>
                ))}
                {gestures.some((g) => g.kind === 'swipe') && (
                  <svg className="g-layer">
                    {gestures.filter((g) => g.kind === 'swipe').map((g) => {
                      const a = toBox(g.x, g.y)
                      const b = toBox(g.x2 ?? g.x, g.y2 ?? g.y)
                      const dur = `${Math.max(250, g.ms ?? 400)}ms`
                      return (
                        <g key={g.id} className="g-swipe" style={{ ['--dur' as string]: dur }}>
                          <line x1={a.left} y1={a.top} x2={b.left} y2={b.top} className="trail" pathLength={1} />
                          <circle cx={a.left} cy={a.top} r={7} className="start" />
                          <circle r={11} className="finger">
                            <animate attributeName="cx" from={a.left} to={b.left} dur={dur} fill="freeze" />
                            <animate attributeName="cy" from={a.top} to={b.top} dur={dur} fill="freeze" />
                          </circle>
                        </g>
                      )
                    })}
                  </svg>
                )}
              </>
            ) : null}
          </div>
        </div>
      </div>
      {inspect && (
        <div className="inspector">
          <div className="attrs">
            {inspect.node ? (
              <>
                {inspect.node.text && <>text <b>&quot;{inspect.node.text}&quot;</b> · </>}
                {inspect.node.desc && <>desc <b>&quot;{inspect.node.desc}&quot;</b> · </>}
                {inspect.node.id && <>id <b>{inspect.node.id}</b> · </>}
                <b>{inspect.node.cls}</b>
                {inspect.field ? ' · campo de texto' : inspect.node.clickable ? ' · clicável' : ''}
              </>
            ) : (
              'nenhum elemento com texto aqui; use o ponto'
            )}
            <button className="icon-btn" style={{ float: 'right' }} onClick={() => setInspect(null)} aria-label="Fechar inspetor">×</button>
          </div>
          <div className="chips">
            {inspect.suggestions.map((s) => (
              <button key={s.yaml} className="chip" onClick={() => onInsert(s.yaml)} title={s.yaml}>
                + {s.label}
              </button>
            ))}
          </div>
        </div>
      )}
      <div className="phone-tools">
        <div className="phone-keys">
          <button className="btn" disabled={running || busy} onClick={() => key('back')}>◀ Voltar</button>
          <button className="btn" disabled={running || busy} onClick={() => key('home')}>● Home</button>
          <button className="btn" disabled={running || busy} onClick={() => key('hideKeyboard')}>⌨ Fechar</button>
          <button className="btn" disabled={running || busy} onClick={() => key('enter')} aria-label="Enter" title="Enter">↵</button>
        </div>
        <input
          ref={textRef}
          className={textHint ? 'want' : ''}
          aria-label="Digitar no celular"
          placeholder={textHint ?? 'Digitar no celular…'}
          value={text}
          disabled={running}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && sendText()}
        />
      </div>
      {mode === 'record' && (
        <div className="rec-bar">
          <span>● gravando em {flowRef?.split(':')[1]}</span>
          <button className="btn stop" onClick={stopRecording}>■ Parar e salvar</button>
        </div>
      )}
      <div className="phone-foot">
        <span>
          <button
            className="view-toggle"
            onClick={() => switchView(view === 'video' ? 'print' : 'video')}
            disabled={view === 'print' && !canVideo}
            title="Alternar entre vídeo (screenrecord) e print (screencap)"
          >
            {view === 'video' ? 'Vídeo' : 'Print'}
          </button>
          {' '}
          {[devSize && `${devSize.w}×${devSize.h}`, view === 'video' ? (fps ? `${fps} fps` : 'parado') : fps ? `${fps} fps` : null, view === 'print' && elsewhere ? 'vídeo em outra aba' : null]
            .filter(Boolean)
            .join(', ')}
        </span>
        <span>{mode === 'record' ? 'Esc para parar' : mode === 'inspect' ? 'Clique para ver o elemento' : 'Clique e arraste no celular'}</span>
      </div>
    </div>
  )
}
