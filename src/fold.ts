// SPDX-License-Identifier: MIT
import { DESCRIBED, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, TREATED } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

const GIVEN = new Set([PERSON, OWNER])
const GRADERS = new Set([DESCRIBED, PERSON])

type Credit = { r: number; cells: Set<string> }

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const treated = (id: unknown): boolean => String(sels.get(String(id))?.arm) === TREATED
  const priors = seen.filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  // A grade (a person's verdict or a described outcome) names the one answer it judges in its input_refs. It credits
  // the composition that made that answer: the answer's selection and every earlier treated selection in that
  // selection's pool. A described grade counts only when all it saw was the request, owner rows and that answer.
  const credit = (o: Row): Credit => {
    const saw = [o.input_refs].flat().map((id) => byId.get(String(id)))
    const answers = saw.filter((r) => r !== undefined && r.role === DESCRIBED && r.shape !== OUTCOME)
    const s = sels.get(String(answers[0]?.selection_ref))
    const clean = saw.every((r) => r !== undefined && (GIVEN.has(r.role) || r === answers[0]))
    const ok = answers.length === 1 && s !== undefined && treated(s.id) && (o.role === PERSON || (clean && treated(o.selection_ref)))
    const chain = ok ? [s, ...[s.pool_refs].flat().map((id) => sels.get(String(id)))] : []
    return { r: Number(o.r), cells: new Set(chain.filter((x) => x !== undefined && treated(x.id)).map((x) => String(x?.cell))) }
  }
  const credits = seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
  return cells.map((c) => {
    const counted = credits.filter((k) => k.cells.has(c))
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    const wins = counted.reduce((s, k) => s + k.r, 0)
    const losses = counted.reduce((s, k) => s + (1 - k.r), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses }
  })
}
