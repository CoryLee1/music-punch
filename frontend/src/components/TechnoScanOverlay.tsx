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

const GLYPH_TAGS = [
  { tag: 'GLYPH_LOCK', score: '0.45' },
  { tag: 'TEMPO_ZONE', score: '0.62' },
  { tag: 'SPECTRAL_TRACE', score: '0.79' },
]

const MAX_GLYPHS = 26

/**
 * 假解析层：无蓝白底的暗色叠层，主体为可扫描的大号字形块（与主线黑白 UI 一致）。
 */
export function TechnoScanOverlay({ hint }: { hint?: string }) {
  const [phase, setPhase] = useState(0)
  useEffect(() => {
    const id = window.setInterval(() => setPhase((p) => p + 1), 380)
    return () => clearInterval(id)
  }, [])

  const visibleLogs = useMemo(() => {
    const n = Math.min(SCAN_LOG.length, 2 + Math.floor(phase / 2))
    return SCAN_LOG.slice(0, n)
  }, [phase])

  const glyphs = useMemo(() => {
    if (!hint?.trim()) return ['·']
    return Array.from(hint.replace(/\r/g, ''))
      .filter((c) => c !== '\n')
      .slice(0, MAX_GLYPHS)
  }, [hint])

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
        <div className="techno-scan-glyph-stage">
          <div className="techno-scan-buffer-row">
            <span className="techno-scan-buffer-label">BUFFER</span>
            <span className="techno-scan-buffer-dim">
              {glyphs.length} glyph{glyphs.length !== 1 ? 's' : ''}
            </span>
          </div>

          <div className="techno-scan-glyph-grid" aria-hidden>
            {glyphs.map((ch, i) => {
              const pulse =
                (phase + i) % 7 < 2 || (phase % glyphs.length === i % glyphs.length)
              return (
                <div
                  key={`${i}-${ch.codePointAt(0) ?? i}`}
                  className={`techno-glyph-cell${pulse ? ' techno-glyph-cell--pulse' : ''}`}
                >
                  <span className="techno-glyph-char">{ch}</span>
                </div>
              )
            })}
          </div>

          <div className="techno-scan-floating-tags">
            {GLYPH_TAGS.map((g, i) => (
              <span
                key={g.tag}
                className="techno-scan-float-tag"
                style={{
                  opacity: 0.35 + ((phase + i) % 6) * 0.1,
                  transform: `translateX(${Math.sin((phase + i) * 0.2) * 4}px)`,
                }}
              >
                {g.tag} [{g.score}]
              </span>
            ))}
          </div>

          <div className="techno-scan-processing">PROCESSING</div>
        </div>

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
