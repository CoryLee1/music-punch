import { useEffect, useMemo, useState } from 'react'

const SCAN_LOG = [
  '> TOKENIZING_LYRIC_STREAM',
  '> MAPPING_GLYPHS_TO_ONSET_GRID',
  '> LATTICE_ALIGN_95BPM_SOURCE',
  '> HARMONIC_MASK_FROM_CHROMATIC_PRIORS',
  '> CROSS_CORRELATING_RHYTHM_CELLS',
  '> EMITTING_PARAMETER_CURVE_FOR_SYNTH',
]

const CHROMA_ROWS: [string, string][] = [
  ['#0b0b3d', '#0b0b3d'],
  ['#2f1b97', '#2f1b97'],
  ['#f348b7', '#f348b7'],
  ['#07b88b', '#07b88b'],
  ['#ffc22a', '#ffc22a'],
  ['#1e60cf', '#1e60cf'],
]

/** 示意「文本 → 音乐」假解析层，风格参考 TECHNO_SCAN */
export function TechnoScanOverlay({ hint }: { hint?: string }) {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setPhase((p) => p + 1), 420)
    return () => clearInterval(id)
  }, [])

  const visibleLogs = useMemo(() => {
    const n = Math.min(SCAN_LOG.length, 2 + Math.floor(phase / 2))
    return SCAN_LOG.slice(0, n)
  }, [phase])

  const boxes = useMemo(
    () =>
      [0, 1, 2].map((i) => ({
        id: i,
        top: `${12 + i * 22}%`,
        left: `${8 + i * 18}%`,
        w: `${22 + (i % 2) * 8}%`,
        h: `${18 + (i % 3) * 5}%`,
        tag: ['GLYPH_LOCK', 'TEMPO_ZONE', 'SPECTRAL_TRACE'][i],
        score: (0.45 + i * 0.17).toFixed(2),
      })),
    [],
  )

  return (
    <div
    className="techno-scan-overlay"
    role="status"
    aria-live="polite"
    onPointerDown={(e) => e.stopPropagation()}
  >
      <header className="techno-scan-header">
        <div>
          <div className="techno-scan-title">TECHNO_SCAN</div>
          <div className="techno-scan-sub">TEXT → AUDIO PIPELINE</div>
        </div>
        <div className="techno-scan-version">SYS.V.3.1</div>
      </header>

      <div className="techno-scan-viewport">
        <div className="techno-scan-grid" />

        {boxes.map((b) => (
          <div
            key={b.id}
            className="techno-scan-target"
            style={{
              top: b.top,
              left: b.left,
              width: b.w,
              height: b.h,
            }}
          >
            <span className="techno-scan-tag">
              {b.tag} [{b.score}]
            </span>
          </div>
        ))}

        <aside className="techno-scan-chromatic">
          <div className="techno-scan-chromatic-title">CHROMATIC_DATA</div>
          <ul>
            {CHROMA_ROWS.map(([hex, fill]) => (
              <li key={hex}>
                <span className="techno-swatch" style={{ background: fill }} />
                <code>{hex}</code>
              </li>
            ))}
          </ul>
        </aside>

        {hint && (
          <div className="techno-scan-buffer-preview" title="输入缓冲">
            <span className="techno-scan-buffer-label">BUFFER</span>
            <p>{hint.length > 120 ? `${hint.slice(0, 120)}…` : hint}</p>
          </div>
        )}

        <div className="techno-scan-processing">PROCESSING</div>

        <div className="techno-scan-log">
          {visibleLogs.map((line) => (
            <div key={line} className="techno-scan-log-line">
              {line}
            </div>
          ))}
        </div>
      </div>

      <footer className="techno-scan-footer">RUNNING DIAGNOSTICS…</footer>
    </div>
  )
}
