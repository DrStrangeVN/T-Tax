import type { AnalyzeProgressCounts } from "../types.js"

export type QueueTask<T> = () => Promise<T>
export type AnalyzeDocState = "queued" | "analyzing" | "done" | "error"

export class ConcurrencyLimiter {
  private active = 0
  private max = 2
  private waiters: Array<() => void> = []
  private listeners = new Set<() => void>()

  constructor(initialMax = 2) {
    this.setMax(initialMax)
  }

  setMax(max: number): void {
    this.max = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 1
    this.fill()
    this.emit()
  }

  reduceMax(): void {
    if (this.max <= 1) return
    this.max -= 1
    this.emit()
  }

  getMax(): number {
    return this.max
  }

  getActive(): number {
    return this.active
  }

  async run<T>(task: QueueTask<T>): Promise<T> {
    await this.acquire()
    try {
      return await task()
    } finally {
      this.active -= 1
      this.fill()
      this.emit()
    }
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private acquire(): Promise<void> {
    if (this.active < this.max) {
      this.active += 1
      this.emit()
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve)
    })
  }

  private fill(): void {
    while (this.waiters.length > 0 && this.active < this.max) {
      this.active += 1
      this.waiters.shift()?.()
      this.emit()
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

export class AnalyzeProgressTracker {
  private states = new Map<string, AnalyzeDocState>()
  private listeners = new Set<(counts: AnalyzeProgressCounts) => void>()
  private cached: AnalyzeProgressCounts = { analyzing: 0, queued: 0, done: 0, error: 0, total: 0 }

  setState(fileId: string, state: AnalyzeDocState): void {
    this.states.set(fileId, state)
    this.recompute()
  }

  clear(fileId: string): void {
    if (this.states.delete(fileId)) this.recompute()
  }

  reset(): void {
    this.states.clear()
    this.recompute()
  }

  getCounts(): AnalyzeProgressCounts {
    return this.cached
  }

  subscribe(listener: (counts: AnalyzeProgressCounts) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private recompute(): void {
    let analyzing = 0
    let queued = 0
    let done = 0
    let error = 0
    for (const st of this.states.values()) {
      if (st === "analyzing") analyzing++
      else if (st === "queued") queued++
      else if (st === "done") done++
      else error++
    }
    this.cached = { analyzing, queued, done, error, total: this.states.size }
    for (const listener of this.listeners) listener(this.cached)
  }
}
