// SPDX-License-Identifier: MIT
import { DESCRIBED, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, TREATED } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

const GIVEN = new Set([PERSON, OWNER])

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = seen.filter((r) => r.shape === SELECTION)
  const cellOf = new Map(sels.map((r) => [r.id, String(r.cell)]))
  const treated = new Set(sels.filter((r) => String(r.arm) === TREATED).map((r) => r.id))
  const outcomes = seen.filter((r) => r.role === DESCRIBED).filter((r) => r.shape === OUTCOME).filter((r) => r.seq <= asOf)
  const priors = seen.filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  // A grade counts only when everything it saw was validly obtained: the request and owner rows, and answers made in
  // the cell it grades. Anything else it was given (another grade, the walk's hops or failures) disqualifies it.
  const independent = (o: Row): boolean => {
    const saw = [o.input_refs].flat().map((id) => byId.get(String(id)))
    const graded = saw.filter((r) => r !== undefined && r.role === DESCRIBED && cellOf.get(String(r.selection_ref)) === String(o.cell))
    const clean = saw.every((r) => r !== undefined && (GIVEN.has(r.role) || graded.includes(r)))
    return clean && graded.length > 0
  }
  return cells.map((c) => {
    const counted = outcomes
      .filter((r) => String(r.cell) === c)
      .filter((r) => treated.has(String(r.selection_ref)))
      .filter(independent)
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    const wins = counted.reduce((s, r) => s + Number(r.r), 0)
    const losses = counted.reduce((s, r) => s + (1 - Number(r.r)), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses }
  })
}
