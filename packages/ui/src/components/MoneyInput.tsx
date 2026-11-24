import React, { useEffect, useState } from "react"

interface MoneyInputProps {
  value: number
  onChange: (next: number) => void
  currency?: string
  placeholder?: string
  className?: string
  disabled?: boolean
}

function parseShorthandMoney(raw: string): number {
  const cleaned = raw.trim().toLowerCase().replace(/\s+/g, "")
  if (!cleaned) return 0
  const trMatch = cleaned.match(/^([\d.,]+)(m|tr|trieu)$/)
  if (trMatch) {
    const base = Number(trMatch[1]!.replace(",", "."))
    return Number.isFinite(base) ? Math.round(base * 1_000_000) : 0
  }
  const kMatch = cleaned.match(/^([\d.,]+)k$/)
  if (kMatch) {
    const base = Number(kMatch[1]!.replace(",", "."))
    return Number.isFinite(base) ? Math.round(base * 1_000) : 0
  }
  const digits = cleaned.replace(/[.,]/g, "").replace(/[^\d-]/g, "")
  const num = Number(digits)
  return Number.isFinite(num) ? Math.round(num) : 0
}

function formatViInteger(n: number): string {
  if (!Number.isFinite(n)) return "0"
  return new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 }).format(Math.round(n))
}

export function MoneyInput({ value, onChange, placeholder, className = "", disabled }: MoneyInputProps) {
  const [focused, setFocused] = useState(false)
  const [draft, setDraft] = useState(() => formatViInteger(value))

  useEffect(() => {
    if (!focused) {
      setDraft(formatViInteger(value))
    }
  }, [value, focused])

  const commit = (raw: string) => {
    const parsed = parseShorthandMoney(raw)
    onChange(parsed)
    setDraft(formatViInteger(parsed))
  }

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      placeholder={placeholder}
      value={draft}
      onFocus={(e) => {
        setFocused(true)
        setDraft(value === 0 ? "" : String(Math.round(value)))
        e.currentTarget.select()
      }}
      onChange={(e) => {
        const val = e.target.value
        setDraft(val)
        if (/^-?[\d.,\s]*$/.test(val) && !/[mktr]/i.test(val)) {
          onChange(parseShorthandMoney(val))
        }
      }}
      onBlur={() => {
        setFocused(false)
        commit(draft)
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit(draft)
        }
      }}
      onWheel={(e) => {
        if (document.activeElement === e.currentTarget) {
          e.currentTarget.blur()
        }
      }}
      className={`tnum text-right ${className}`}
    />
  )
}
