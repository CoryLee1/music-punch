import { useState, useRef, useEffect } from 'react'

interface EmotionInputProps {
  disabled?: boolean
  onSubmit: (emotion: string) => void
}

export function EmotionInput({ disabled, onSubmit }: EmotionInputProps) {
  const [value, setValue] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    // 自动聚焦
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
      <button
        className="input-submit"
        onClick={handleSubmit}
        disabled={disabled || !value.trim()}
        type="button"
      >
        PUNCH
      </button>
    </div>
  )
}
