// SPDX-License-Identifier: MIT
import { DESCRIBED, OUTCOME, OWNER, PRIOR, SELECTION, TREATED } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const sels = seen.filter((r) => r.shape === SELECTION)
  const treated = new Set(sels.filter((r) => String(r.arm) === TREATED).map((r) => r.id))
  const described = seen.filter((r) => r.role === DESCRIBED)
  const outcomes = described.filter((r) => r.shape === OUTCOME).filter((r) => r.seq <= asOf)
  const priors = seen.filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  return cells.map((c) => {
    const mine = new Set(sels.filter((r) => String(r.cell) === c).map((r) => r.id))
    const lineage = new Set(described.filter((r) => mine.has(String(r.selection_ref))).map((r) => String(r.producer)))
    const counted = outcomes
      .filter((r) => String(r.cell) === c)
      .filter((r) => treated.has(String(r.selection_ref)))
      .filter((r) => !lineage.has(String(r.producer)))
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    const wins = counted.reduce((s, r) => s + Number(r.r), 0)
    const losses = counted.reduce((s, r) => s + (1 - Number(r.r)), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses }
  })
}
