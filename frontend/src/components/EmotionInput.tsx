import { useState, useRef, useEffect } from 'react'

type AppPhase = 'idle' | 'loading' | 'active' | 'ending' | 'over'

interface EmotionInputProps {
  disabled?: boolean
  phase?: AppPhase
  onSubmit: (emotion: string) => void
  onReset?: () => void
  onEasterEgg?: () => void
  easterEggActive?: boolean
}

export function EmotionInput({ disabled, phase, onSubmit, onReset, onEasterEgg, easterEggActive }: EmotionInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 光标常驻：始终保持输入框聚焦（延迟 refocus 以免吞掉按钮点击）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    let tid: ReturnType<typeof setTimeout> | null = null
    const refocus = () => {
      if (tid) clearTimeout(tid)
      tid = setTimeout(() => {
        if (!el.disabled) el.focus()
      }, 80)
    }
    el.addEventListener('blur', refocus)
    return () => {
      el.removeEventListener('blur', refocus)
      if (tid) clearTimeout(tid)
    }
  }, [])

  // disabled 状态变化时也重新聚焦
  useEffect(() => {
    if (!disabled && inputRef.current) {
      inputRef.current.focus()
    }
  }, [disabled])

  const handleSubmit = () => {
    const trimmed = value.trim()
    if (!trimmed || disabled) return
    onSubmit(trimmed)
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      e.preventDefault()
      handleSubmit()
    }
  }

  return (
    <div className="app-input-bar">
      {/* 彩蛋按钮 */}
      {onEasterEgg && (
        <button
          className={`input-easter-egg ${easterEggActive ? 'is-active' : ''}`}
          onClick={onEasterEgg}
          type="button"
          title={easterEggActive ? '退出解压模式' : '解压模式'}
        >
          📦
        </button>
      )}
      <span className="input-prefix">{'//>'}</span>
      <input
        ref={inputRef}
        className="emotion-input"
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="输入你的情绪... type your emotion here"
        disabled={disabled}
        maxLength={200}
        autoComplete="off"
        spellCheck={false}
      />
      {(phase === 'over' || phase === 'ending') && onReset && (
        <button
          className="input-restart"
          onClick={onReset}
          type="button"
        >
          ↻ Restart
        </button>
      )}
      <button
        className="input-submit"
        onClick={handleSubmit}
        disabled={disabled}
        type="button"
      >
        PUNCH
      </button>
    </div>
  )
}
