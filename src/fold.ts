// SPDX-License-Identifier: MIT
import { DESCRIBED, FAILURE, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, TREATED, WALK } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

const GIVEN = new Set([PERSON, OWNER])
const GRADERS = new Set([DESCRIBED, PERSON])

// by: the grader's role (person, or described for the walk's own outcome); deadline: the judged row is a deadline, so
// a counted grade of it at r 0 is a lapse.
export type Grade = { ok: boolean; r: number; judged: string; key: string; cells: Set<string>; by: string; deadline: boolean }

// Every grade among the rows, with whether it counts and what it judges. The fold folds the ones that count; the
// lapse detector uses the same answer, so a grade the fold refuses never hides a lapse.
export const grades = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const byId = new Map(seen.map((r) => [r.id, r]))
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const treated = (id: unknown): boolean => String(sels.get(String(id))?.arm) === TREATED
  // A selection whose move failed (a failure row the walk that made it wrote, whatever the status or kind) produced
  // nothing a grade can be crediting, so it is left out of every chain. A skip row is not such a failure: it names a
  // template that could not run, and cites whichever selection the walk was making then, not a move of its own.
  const failed = new Set(seen
    .filter((r) => r.shape === FAILURE && r.role === WALK && r.kind !== "skip")
    .filter((r) => sels.get(String(r.selection_ref))?.writer === r.writer)
    .map((r) => String(r.selection_ref)))
  // A grade (a person's verdict or a described outcome) judges one answer it saw (any described row that is not a grade,
  // so a due row is answer-like: grading it r 1 credits the steps that made it): the answer in its input_refs, or, when
  // it saw several, the one its evidence_refs names. It credits the composition that made that answer: the answer's
  // selection and every earlier treated selection in that selection's pool. A described grade counts only when all it
  // saw was the request, owner rows and answers. r must be a number from 0 to 1, and only a writer's latest valid grade
  // of an answer counts: a repeat replaces, never adds. A judged row that carries a deadline (within_ms, which records
  // made into `at`) lapsed rather than answered: its grade counts only as r 0 and only when records stamped the grade after the deadline, and it also
  // credits the treated steps the grader's selection held after that row, which are the waits that let it lapse.
  const credit = (o: Row): Grade => {
    const saw = [o.input_refs].flat().map((id) => byId.get(String(id)))
    const answers = saw.filter((r) => r !== undefined && r.role === DESCRIBED && r.shape !== OUTCOME)
    const named = [o.evidence_refs].flat().filter((id) => id !== undefined).map(String)
    const judged = named.length > 0 ? answers.filter((a) => named.includes(String(a?.id))) : answers
    const s = sels.get(String(judged[0]?.selection_ref))
    const clean = saw.every((r) => r !== undefined && (GIVEN.has(r.role) || answers.includes(r)))
    const r = Number(o.r)
    const j = judged[0]
    const deadline = j !== undefined && typeof j.within_ms === "number" && typeof j.at === "number"
    const timely = !deadline || (r === 0 && Date.parse(String(o.t)) >= Number(j?.at))
    const ok = typeof o.r === "number" && Number.isFinite(r) && r >= 0 && r <= 1 && judged.length === 1 && s !== undefined && treated(s.id) && (o.role === PERSON || (clean && treated(o.selection_ref))) && timely
    const after = deadline ? [sels.get(String(o.selection_ref))?.pool_refs].flat().map((id) => sels.get(String(id))).filter((x) => x !== undefined && x.seq > Number(j?.seq)) : []
    const chain = ok ? [s, ...[s.pool_refs].flat().map((id) => sels.get(String(id))), ...after] : []
    return { ok, r, judged: String(judged[0]?.id), key: [o.writer, judged[0]?.id].join("|"), cells: new Set(chain.filter((x) => x !== undefined && treated(x.id) && !failed.has(x.id)).map((x) => String(x?.cell))), by: String(o.role), deadline }
  }
  return seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
}

// The grades that stand: those that count, and of each writer's grades of one answer only the latest (a repeat
// replaces, never adds), as the fold below folds them. A person who grades an answer r 1 and then r 0 has not closed it.
export const standing = (all: Row[], asOf: number, atSeq: number): Grade[] =>
  [...new Map(grades(all, asOf, atSeq).filter((k) => k.ok).map((k) => [k.key, k])).values()]

// A move that failed, as the vessel it called said: a 4xx answer blames the request the move made (a template call
// naming no channel, a pointer missing its fields). It counts as r 0 for that move's cell only: the selection that made
// the call, treated, by the walk that wrote the failure; once per selection; never its chain, since it produced nothing.
// Not counted: 401 and 403 (they blame the caller's credentials, which rotate, not the request), 408 and 429 (the callee
// was busy), 5xx, timeouts and transport errors (an outage is not the move's fault),
// and the walk declining to run or record (kind skip or too_big). Kept apart from grades(): what closes a request and
// what lapses never read it, and its key cannot replace a grade's.
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
const BLAMES_REQUEST = (status: number): boolean => status >= 400 && status < 500 && !NOT_THE_REQUEST.has(status)
export const moveFailures = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const out = new Map<string, Grade>()
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.seq <= asOf)) {
    const s = sels.get(String(f.selection_ref))
    if (s === undefined || String(s.arm) !== TREATED || s.writer !== f.writer) continue
    if (f.kind !== undefined || typeof f.status !== "number" || !BLAMES_REQUEST(f.status)) continue
    out.set(s.id, { ok: true, r: 0, judged: s.id, key: `fail|${s.id}`, cells: new Set([String(s.cell)]), by: WALK, deadline: false })
  }
  return [...out.values()]
}

// A cell is the move and everything it saw ("<move>|<context>": the shapes, the asker, the age), so the same cell
// rarely comes twice and most draws were made at the prior: nothing learned carried to the next request. A cell with no
// counted evidence of its own backs off to a coarser one that has some: the same move for the same asker, then the same
// move anywhere. The finest level with evidence answers, each grade counted once, and the answer says which (from).
// An owner prior still belongs to the exact cell.
type Level = "cell" | "asker" | "move" | "none"
const move = (c: string): string => c.split("|")[0]
const asker = (c: string): string | undefined => c.split("|").slice(1).join("|").split(",").find((t) => t.startsWith("asker:"))

export const foldFrom = (all: Row[], cells: string[], asOf: number, atSeq: number): Array<Post & { from: Level }> => {
  const priors = all.filter((r) => r.seq <= atSeq).filter((r) => r.shape === PRIOR).filter((r) => r.role === OWNER)
  const latest = [...new Map([...standing(all, asOf, atSeq), ...moveFailures(all, asOf, atSeq)].map((k) => [k.key, k])).values()]
  return cells.map((c) => {
    const levels: Array<[Level, (x: string) => boolean]> = [
      ["cell", (x) => x === c],
      ["asker", (x) => move(x) === move(c) && asker(c) !== undefined && asker(x) === asker(c)],
      ["move", (x) => move(x) === move(c)],
    ]
    const [from, counted] = levels
      .map(([level, at]): [Level, Grade[]] => [level, latest.filter((k) => [...k.cells].some(at))])
      .find(([, ks]) => ks.length > 0) ?? ["none", []]
    const p0 = priors
      .filter((r) => String(r.cell) === c)
      .reduce((_, r) => ({ alpha: Number(r.alpha0), beta: Number(r.beta0) }), { alpha: 1, beta: 1 })
    const wins = counted.reduce((s, k) => s + k.r, 0)
    const losses = counted.reduce((s, k) => s + (1 - k.r), 0)
    return { cell: c, alpha: p0.alpha + wins, beta: p0.beta + losses, from }
  })
}

export const fold = (all: Row[], cells: string[], asOf: number, atSeq: number): Post[] =>
  foldFrom(all, cells, asOf, atSeq).map(({ cell, alpha, beta }) => ({ cell, alpha, beta }))
