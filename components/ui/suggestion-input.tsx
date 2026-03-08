"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command"
import { Popover, PopoverAnchor, PopoverContent } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

type Props = {
  value: string
  onValueChange: (value: string) => void
  suggestions: string[]
  placeholder?: string
  emptyText?: string
  className?: string
  inputClassName?: string
  maxItems?: number
  disabled?: boolean
  onEnter?: () => void
}

export function SuggestionInput({
  value,
  onValueChange,
  suggestions,
  placeholder,
  emptyText,
  className,
  inputClassName,
  maxItems = 10,
  disabled,
  onEnter,
}: Props) {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState("")
  const inputRef = useRef<HTMLInputElement | null>(null)

  useEffect(() => {
    setQuery(value)
  }, [value])

  const matches = useMemo(() => {
    const q = query.trim().toLowerCase()
    const base = q ? suggestions.filter((s) => s.toLowerCase().includes(q)) : suggestions
    return base.slice(0, Math.max(1, maxItems))
  }, [maxItems, query, suggestions])

  const trimmed = query.trim()
  const showUseTyped = Boolean(trimmed) && !suggestions.some((s) => s.toLowerCase() === trimmed.toLowerCase())

  const shouldOpen = open && !disabled

  return (
    <Popover open={shouldOpen} onOpenChange={setOpen}>
      <PopoverAnchor asChild>
        <div className={cn("w-full", className)}>
          <Command className={cn("rounded-lg border bg-transparent", inputClassName)}>
            <CommandInput
              ref={inputRef as any}
              value={query}
              onValueChange={(v) => {
                setQuery(v)
                onValueChange(v)
                setOpen(true)
              }}
              placeholder={placeholder}
              disabled={disabled}
              onFocus={() => setOpen(true)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && onEnter) {
                  e.preventDefault()
                  setOpen(false)
                  onEnter()
                }
                if (e.key === "Escape") setOpen(false)
              }}
            />
          </Command>
        </div>
      </PopoverAnchor>
      <PopoverContent className="p-0" align="start">
        <Command>
          <CommandList>
            <CommandEmpty>{emptyText || "No suggestions"}</CommandEmpty>
            <CommandGroup heading="Suggestions">
              {showUseTyped ? (
                <CommandItem
                  value={trimmed}
                  onSelect={(v) => {
                    onValueChange(v)
                    setQuery(v)
                    setOpen(false)
                    inputRef.current?.focus()
                  }}
                >
                  Use "{trimmed}"
                </CommandItem>
              ) : null}
              {matches.map((s) => (
                <CommandItem
                  key={s}
                  value={s}
                  onSelect={(v) => {
                    onValueChange(v)
                    setQuery(v)
                    setOpen(false)
                    inputRef.current?.focus()
                  }}
                >
                  {s}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}
