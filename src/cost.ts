// SPDX-License-Identifier: MIT
import { drainRefolds } from "./fold"

// What a query asked, without its values: its shape, and every other field's name with the length of its value (and a
// nested object's fields the same way). A where can hold a person's text, which must not reach the journal.
const lengthOf = (v: unknown): number => (JSON.stringify(v) ?? "").length
// A name a caller chose (a shape, a field) is cut: a name can carry text too.
const NAME_CHARS = 40
const name = (k: string): string => (k.length > NAME_CHARS ? `${k.slice(0, NAME_CHARS)}…` : k)
export const outline = (q: unknown): string => {
  if (typeof q !== "object" || q === null) return typeof q
  const fields = Object.entries(q as Record<string, unknown>).filter(([k]) => k !== "shape" && k !== "type").map(([k, v]) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? `${name(k)}{${Object.entries(v as Record<string, unknown>).map(([k2, v2]) => `${name(k2)}:${lengthOf(v2)}`).join(",")}}`
      : `${name(k)}:${lengthOf(v)}`)
  const shape = (q as { shape?: unknown }).shape
  return [typeof shape === "string" ? name(shape) : "-", ...fields].join(" ")
}

// A request whose answer refolded grades over the whole store (a cache miss: the store moved since the last fold) says
// so, with what it cost: such a fold takes seconds and is what makes a reader wait or time out, and without this line no
// one can tell which read it was. A request that folded nothing writes no line.
// What an answer cost: its time, and each fold it had to redo (counts and durations only). An answer that is an object
// carries it as `cost`, so whoever reads the answer (the walk's selection, a trace) has it; an answer that is a list
// is left as it is (adding a field would change what every reader of a list receives), and the journal line says it.
export type Cost = { ms: number; refolded: Array<{ fold: string; rows: number; ms: number }> }
export const costed = <T>(shape: string, query: unknown, run: () => T, log: (line: string) => void = console.log): T | (T & { cost: Cost }) => {
  drainRefolds()
  const t0 = performance.now()
  const v = run()
  const folds = drainRefolds()
  const cost: Cost = { ms: Math.round(performance.now() - t0), refolded: folds }
  if (folds.length > 0) {
    const each = folds.map((f) => `${f.fold} ${f.ms} ms`).join(", ")
    log(`[records] ${shape} took ${cost.ms} ms; refolded ${each} over ${folds[0]!.rows} rows; query ${outline(query)}`)
  }
  return typeof v === "object" && v !== null && !Array.isArray(v) ? { ...(v as object), cost } as T & { cost: Cost } : v
}
