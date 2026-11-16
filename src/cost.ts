// SPDX-License-Identifier: MIT
import { drainRefolds } from "./fold"

// What a query asked, without its values: its shape, and every other field's name with the length of its value (and a
// nested object's fields the same way). A where can hold a person's text, which must not reach the journal.
const lengthOf = (v: unknown): number => (JSON.stringify(v) ?? "").length
export const outline = (q: unknown): string => {
  if (typeof q !== "object" || q === null) return typeof q
  const fields = Object.entries(q as Record<string, unknown>).filter(([k]) => k !== "shape" && k !== "type").map(([k, v]) =>
    typeof v === "object" && v !== null && !Array.isArray(v)
      ? `${k}{${Object.entries(v as Record<string, unknown>).map(([k2, v2]) => `${k2}:${lengthOf(v2)}`).join(",")}}`
      : `${k}:${lengthOf(v)}`)
  const shape = (q as { shape?: unknown }).shape
  return [typeof shape === "string" ? shape : "-", ...fields].join(" ")
}

// A request whose answer refolded grades over the whole store (a cache miss: the store moved since the last fold) says
// so, with what it cost: such a fold takes seconds and is what makes a reader wait or time out, and without this line no
// one can tell which read it was. A request that folded nothing writes no line.
export const costed = <T>(shape: string, query: unknown, run: () => T, log: (line: string) => void = console.log): T => {
  drainRefolds()
  const t0 = performance.now()
  const v = run()
  const folds = drainRefolds()
  if (folds.length > 0) {
    const each = folds.map((f) => `${f.fold} ${f.ms} ms`).join(", ")
    log(`[records] ${shape} took ${Math.round(performance.now() - t0)} ms; refolded ${each} over ${folds[0]!.rows} rows; query ${outline(query)}`)
  }
  return v
}
