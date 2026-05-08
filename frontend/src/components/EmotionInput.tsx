import { useState, useRef, useEffect } from 'react'

type AppPhase = 'idle' | 'loading' | 'active' | 'ending' | 'over'

interface EmotionInputProps {
  disabled?: boolean
  phase?: AppPhase
  onSubmit: (emotion: string) => void
  onReset?: () => void
}

export function EmotionInput({ disabled, phase, onSubmit, onReset }: EmotionInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  // 光标常驻：始终保持输入框聚焦
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    const refocus = () => {
      if (!el.disabled) el.focus()
    }
    el.addEventListener('blur', refocus)
    return () => el.removeEventListener('blur', refocus)
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
