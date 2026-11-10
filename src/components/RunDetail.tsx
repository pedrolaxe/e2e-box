'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import type { RunEvent } from '@/lib/engine'

interface Report {
  runId: string
  ref: string
  status: string
  ms?: number
  error?: string
  partial?: string
  events: RunEvent[]
}

interface StepRow {
  id: string
  label: string
  status: string
  ms?: number
  error?: string
  shot?: string
  logs: { level: string; msg: string; depth: number }[]
}

interface HierarchyLine {
  cls: string
  text: string
  desc: string
  id: string
}

const secs = (ms?: number) => (ms == null ? '' : ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`)

/** Monta a linha do tempo dos passos de primeiro nível a partir dos eventos do relatório. */
function toRows(report: Report): StepRow[] {
  const start = report.events.find((e) => e.type === 'run-start')
  const labels = start?.type === 'run-start' ? start.steps : []
  const rows: StepRow[] = labels.map((label, i) => ({ id: String(i), label, status: 'pending', logs: [] }))
  let current: StepRow | undefined
  for (const e of report.events) {
    if (e.type === 'step-start' && e.depth === 0) current = rows[Number(e.stepId)]
    if (e.type === 'log' && current && e.level !== 'step') current.logs.push({ level: e.level, msg: e.msg, depth: e.depth ?? 0 })
    if (e.type === 'step-end' && e.depth === 0) {
      const row = rows[Number(e.stepId)]
      if (row) Object.assign(row, { status: e.status, ms: e.ms, error: e.error, shot: e.shot })
      current = undefined
    }
  }
  // Falhou antes do primeiro passo (pré-condição, por exemplo).
  if (report.status === 'failed' && !rows.some((r) => r.status === 'failed')) {
    rows.unshift({ id: 'falha', label: 'antes dos passos', status: 'failed', error: report.error, shot: 'falha.png', logs: [] })
  }
  return rows
}

/** Só o que ajuda a escolher um seletor; senha nunca aparece. */
function parseHierarchyLines(xml: string): HierarchyLine[] {
  const doc = new DOMParser().parseFromString(xml, 'text/xml')
  return [...doc.querySelectorAll('node')]
    .map((n) => ({
      cls: (n.getAttribute('class') ?? '').split('.').pop() ?? '',
      text: n.getAttribute('password') === 'true' ? '•••' : (n.getAttribute('text') ?? ''),
      desc: n.getAttribute('content-desc') ?? '',
      id: (n.getAttribute('resource-id') ?? '').split(':id/').pop() ?? '',
    }))
    .filter((n) => n.text || n.desc || n.id)
}

export function RunDetail({ runId, onClose }: { runId: string; onClose: () => void }) {
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selected, setSelected] = useState<number | null>(null)
  const [hierarchy, setHierarchy] = useState<HierarchyLine[] | null>(null)
  const [noImage, setNoImage] = useState(false)
  const artifact = (file: string) => `/api/artifact?run=${encodeURIComponent(runId)}&file=${encodeURIComponent(file)}`

  // A página re-renderiza a cada tique do relógio: o listener do Esc fica num ref.
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current()
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    let alive = true
    fetch(artifact('report.json'), { cache: 'no-store' })
      .then((r) => {
        if (!r.ok) throw new Error('Relatório não encontrado')
        return r.json()
      })
      .then((data) => alive && setReport(data))
      .catch((e) => alive && setError((e as Error).message))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId])

  const rows = useMemo(() => (report ? toRows(report) : []), [report])
  const failedIndex = rows.findIndex((r) => r.status === 'failed')
  const lastShot = rows.reduce((last, r, i) => (r.shot ? i : last), -1)
  const index = selected ?? (failedIndex >= 0 ? failedIndex : Math.max(lastShot, 0))
  const row = rows[index]

  useEffect(() => setNoImage(false), [index])

  // A hierarquia só existe da falha: é o que estava na tela quando o seletor não achou.
  useEffect(() => {
    if (row?.status !== 'failed' || hierarchy) return
    let alive = true
    fetch(artifact('falha-hierarquia.xml'), { cache: 'no-store' })
      .then((r) => (r.ok ? r.text() : ''))
      .then((xml) => alive && setHierarchy(xml ? parseHierarchyLines(xml) : []))
      .catch(() => alive && setHierarchy([]))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [row?.status, hierarchy])

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal card detail" role="dialog" aria-modal="true" aria-labelledby="run-detail-title">
        <div className="modal-head">
          <h2 id="run-detail-title">
            {report?.ref.split(':').pop() ?? 'Execução'}
            {report && (
              <small>
                {' '}{report.status === 'passed' ? 'passou' : report.status === 'stopped' ? 'parado' : 'falhou'} em {secs(report.ms)}
                {report.partial ? `, ${report.partial}` : ''}
              </small>
            )}
          </h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">×</button>
        </div>
        {error && <div className="modal-error">{error}</div>}
        {report && (
          <div className="detail-body">
            <ol className="detail-steps">
              {rows.map((r, i) => (
                <li key={r.id}>
                  <button className={`detail-step ${i === index ? 'on' : ''}`} onClick={() => setSelected(i)} title={r.label}>
                    <span className={`sdot ${r.status}`} />
                    <span className="name">{r.label}</span>
                    <span className="ms">{secs(r.ms)}</span>
                  </button>
                </li>
              ))}
            </ol>
            <div className="detail-shot">
              {row?.shot && !noImage ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img src={artifact(row.shot)} alt={`Tela depois de ${row.label}`} onError={() => setNoImage(true)} />
              ) : (
                <div className="detail-empty">{row?.status === 'skipped' || row?.status === 'pending' ? 'Passo não executado' : 'Sem print deste passo'}</div>
              )}
            </div>
            <div className="detail-info">
              {row?.error && <div className="modal-error">{row.error}</div>}
              <div className="detail-title">Log do passo</div>
              <div className="detail-log">
                {row?.logs.length ? (
                  row.logs.map((l, i) => (
                    <div key={i} className={`ln ${l.level}`} style={{ paddingLeft: l.depth * 12 }}>{l.msg}</div>
                  ))
                ) : (
                  <span className="detail-muted">Nada registrado</span>
                )}
              </div>
              {row?.status === 'failed' && (
                <>
                  <div className="detail-title">Na tela quando falhou</div>
                  <div className="detail-log">
                    {hierarchy === null && <span className="detail-muted">Carregando…</span>}
                    {hierarchy?.length === 0 && <span className="detail-muted">Hierarquia indisponível</span>}
                    {hierarchy?.map((n, i) => (
                      <div key={i} className="detail-node">
                        <span>{n.cls}</span> {n.text && <b>{n.text}</b>} {n.desc && <i>{n.desc}</i>} {n.id && <code>#{n.id}</code>}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
