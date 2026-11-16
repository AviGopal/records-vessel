// SPDX-License-Identifier: MIT
// What rows of one shape hold, as counts: for each field asked (a dotted path, pointer.type; a list counts each of its
// elements), how many distinct values it takes and its most common short ones. So a walk about to edit code that keys
// on a field can read what values rows actually carry (agf_yn70bvzk53ud: d929 keyed an edit on a pointer type no row
// carries) without any row, or a person's words, reaching its prompt: a value longer than the cut is counted, never
// shown, and only record_summary is declared to callers that fill a schema.
import { DESCRIBED, DETECTOR, WALK } from "./shapes"
import type { Row } from "./store"

// The form callers are told they may ask for (discovery's declared vocabulary): the bounds a summary keeps are here and
// nowhere else.
export const SUMMARY_INPUTS = {
  type: "object",
  required: ["shape", "summarize"],
  additionalProperties: false,
  properties: {
    shape: { type: "string", minLength: 1, maxLength: 80, description: "The shape whose rows to count." },
    summarize: {
      type: "array", minItems: 1, maxItems: 8,
      items: { type: "string", minLength: 1, maxLength: 80 },
      description: "The fields to count: dotted paths into a row (pointer.type); a list counts each element.",
    },
    top: { type: "integer", minimum: 1, maximum: 20, description: "How many of the most common values to show per field." },
    // The walk's transport (walk calls.ts TRANSPORT): which selection, call and rows a forwarded call is for. Taken and
    // ignored, so a strict schema still holds as written (agf_a1p01pv553ex: every walk call was refused for them).
    selection_ref: { type: "string", description: "The walk's transport, ignored." },
    call_id: { type: "string", description: "The walk's transport, ignored." },
    input_refs: { type: "array", items: { type: "string" }, description: "The walk's transport, ignored." },
  },
} as const
export const SUMMARY_DESCRIPTION = "Counts what the rows of one shape hold, without returning any row: for each field in " +
  "summarize (a dotted path such as pointer.type), how many distinct values it takes and its most common short values. " +
  "Read it before changing code that keys on a field of rows, to see which values rows really carry. Summarize keys and " +
  "types, not text: a value longer than 40 characters is counted as long, never shown."
export const SUMMARY_ANSWERS = "{shape, count, newest_seq, fields: {<path>: {distinct, missing, long, withheld, top: [[value, n], …]} | {refused}}}"
// Whose values may be shown: rows the system writes (the walk's, a model producer's, a detector's). A person's, the
// owner's, an operator's or an unmarked key's row may hold a person's words however short ("Wrong", "Stop it now"), so
// its values are counted as withheld, never shown (qa).
const SHOWN_ROLES = new Set([WALK, DESCRIBED, DETECTOR])
// Paths that name who wrote a row or what proves it: never summarized (qa: a writer list names key-holders).
const NEVER = /^(writer|signature|by_key)$|key|token|secret|password|credential/i
// The keys a summary query takes, read from its declared schema (one list, never a second one to drift) and the
// call's type; any other is refused, so a summary is never quietly wider than asked (qa).
const SUMMARY_KEYS = new Set(["type", ...Object.keys(SUMMARY_INPUTS.properties)])
/** A summary query, read and answered: refused (thrown) when it carries any other key or lacks shape or summarize. */
export const serveSummary = (rows: Row[], q: Record<string, unknown>): Summary => {
  const extra = Object.keys(q).filter((k) => !SUMMARY_KEYS.has(k))
  if (extra.length > 0) throw new Error(`record_summary takes only shape, summarize and top: not ${extra.join(", ")}`)
  if (typeof q.shape !== "string" || !Array.isArray(q.summarize)) throw new Error("record_summary needs shape and summarize")
  return summarize(rows, q.shape, q.summarize.map(String), q.top === undefined ? undefined : Number(q.top))
}
// A value shown must be short enough to be a key or a type (a shape, a tool, a status), not a person's words.
export const SHOWN_MAX = 40
const TOP_MAX = SUMMARY_INPUTS.properties.top.maximum
const FIELDS_MAX = SUMMARY_INPUTS.properties.summarize.maxItems

export type FieldSummary = { distinct: number; missing: number; long: number; withheld: number; top: Array<[string, number]> } | { refused: string }
export type Summary = { shape: string; count: number; newest_seq: number | null; fields: Record<string, FieldSummary> }

// Every value a dotted path reaches in a row: a list at any step is entered element by element.
const valuesAt = (row: unknown, path: string[]): unknown[] => {
  let at: unknown[] = [row]
  for (const key of path) {
    at = at.flatMap((v) => (Array.isArray(v) ? v : [v]))
      .flatMap((v) => (typeof v === "object" && v !== null && key in (v as object) ? [(v as Record<string, unknown>)[key]] : []))
  }
  return at.flatMap((v) => (Array.isArray(v) ? v : [v]))
}

export const summarize = (rows: Row[], shape: string, fields: string[], top?: number): Summary => {
  const n = Math.min(Math.max(1, Math.floor(Number(top ?? TOP_MAX))), TOP_MAX)
  const of = rows.filter((r) => r.shape === shape)
  const out: Record<string, FieldSummary> = {}
  for (const f of fields.slice(0, FIELDS_MAX).map(String)) {
    if (f.split(".").some((seg) => NEVER.test(seg))) { out[f] = { refused: "who wrote a row, or a key, is never summarized" }; continue }
    const counts = new Map<string, number>()
    let missing = 0
    let long = 0
    let withheld = 0
    for (const r of of) {
      const vs = valuesAt(r, f.split("."))
      if (vs.length === 0) { missing++; continue }
      if (!SHOWN_ROLES.has(String(r.role))) { withheld += vs.length; continue }
      for (const v of vs) {
        const shown = typeof v === "string" ? v : typeof v === "object" ? undefined : JSON.stringify(v)
        if (shown === undefined || shown.length > SHOWN_MAX) { long++; continue }
        counts.set(shown, (counts.get(shown) ?? 0) + 1)
      }
    }
    const ranked = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    out[f] = { distinct: counts.size, missing, long, withheld, top: ranked.slice(0, n) }
  }
  return { shape, count: of.length, newest_seq: of.length > 0 ? of[of.length - 1]!.seq : null, fields: out }
}
