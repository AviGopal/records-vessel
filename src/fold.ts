// SPDX-License-Identifier: MIT
import { DESCRIBED, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, TREATED } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

const GIVEN = new Set([PERSON, OWNER])
const GRADERS = new Set([DESCRIBED, PERSON])

type Credit = { ok: boolean; r: number; key: string; cells: Set<string> }

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const treated = (id: unknown): boolean => String(sels.get(String(id))?.arm) === TREATED
  const priors = seen.filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  // A grade (a person's verdict or a described outcome) judges one answer it saw: the answer in its input_refs, or, when
  // it saw several, the one its evidence_refs names. It credits the composition that made that answer: the answer's
  // selection and every earlier treated selection in that selection's pool. A described grade counts only when all it
  // saw was the request, owner rows and answers. r must be a number from 0 to 1, and only a writer's latest valid grade
  // of an answer counts: a repeat replaces, never adds. A judged row that carries a deadline (`at`) lapsed rather than
  // answered: its grade counts only as r 0 and only when records stamped the grade after the deadline, and it also
  // credits the treated steps the grader's selection held after that row, which are the waits that let it lapse.
  const credit = (o: Row): Credit => {
    const saw = [o.input_refs].flat().map((id) => byId.get(String(id)))
    const answers = saw.filter((r) => r !== undefined && r.role === DESCRIBED && r.shape !== OUTCOME)
    const named = [o.evidence_refs].flat().filter((id) => id !== undefined).map(String)
    const judged = named.length > 0 ? answers.filter((a) => named.includes(String(a?.id))) : answers
    const s = sels.get(String(judged[0]?.selection_ref))
    const clean = saw.every((r) => r !== undefined && (GIVEN.has(r.role) || answers.includes(r)))
    const r = Number(o.r)
    const j = judged[0]
    const deadline = j !== undefined && typeof j.at === "number"
    const timely = !deadline || (r === 0 && Date.parse(String(o.t)) >= Number(j?.at))
    const ok = typeof o.r === "number" && Number.isFinite(r) && r >= 0 && r <= 1 && judged.length === 1 && s !== undefined && treated(s.id) && (o.role === PERSON || (clean && treated(o.selection_ref))) && timely
    const after = deadline ? [sels.get(String(o.selection_ref))?.pool_refs].flat().map((id) => sels.get(String(id))).filter((x) => x !== undefined && x.seq > Number(j?.seq)) : []
    const chain = ok ? [s, ...[s.pool_refs].flat().map((id) => sels.get(String(id))), ...after] : []
    return { ok, r, key: [o.writer, judged[0]?.id].join("|"), cells: new Set(chain.filter((x) => x !== undefined && treated(x.id)).map((x) => String(x?.cell))) }
  }
  const credits = seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
  const latest = new Map(credits.filter((k) => k.ok).map((k) => [k.key, k]))
  return cells.map((c) => {
    const counted = [...latest.values()].filter((k) => k.cells.has(c))
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    const wins = counted.reduce((s, k) => s + k.r, 0)
    const losses = counted.reduce((s, k) => s + (1 - k.r), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses }
  })
}
