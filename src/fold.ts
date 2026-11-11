// SPDX-License-Identifier: MIT
import { DESCRIBED, FAILURE, OUTCOME, OWNER, PERSON, PRIOR, SELECTION, TREATED, WALK } from "./shapes"
import type { Row } from "./store"

export type Post = { cell: string; alpha: number; beta: number }

const GIVEN = new Set([PERSON, OWNER])
const GRADERS = new Set([DESCRIBED, PERSON])

// by: the grader's role (person, or described for the walk's own outcome); deadline: the judged row is a deadline, so
// a counted grade of it at r 0 is a lapse.
// refused: why a grade does not count, when it does not (the first reason that applies).
export type Grade = { ok: boolean; r: number; judged: string; key: string; cells: Set<string>; by: string; deadline: boolean; refused?: string }

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
    // A lapse (r 0 on a deadline row, stamped after it) is a fact about the clock, not a judgment of the walk's work: what
    // else the grader saw cannot make it less independent, so it counts clean or not. A grade of an answer still must be
    // clean. (Outcome graders read hops, so without this no lapse counted, and no lapsed request ever closed.)
    const lapse = deadline && r === 0 && timely
    const refused = !(typeof o.r === "number" && Number.isFinite(r) && r >= 0 && r <= 1) ? "r"
      : judged.length !== 1 ? "judged"
      : s === undefined || !treated(s.id) || (o.role !== PERSON && !treated(o.selection_ref)) ? "untreated"
      : o.role !== PERSON && !(clean || lapse) ? "unclean"
      : !timely ? "untimely"
      : undefined
    const ok = refused === undefined
    const after = deadline ? [sels.get(String(o.selection_ref))?.pool_refs].flat().map((id) => sels.get(String(id))).filter((x) => x !== undefined && x.seq > Number(j?.seq)) : []
    const chain = ok && s !== undefined ? [s, ...[s.pool_refs].flat().map((id) => sels.get(String(id))), ...after] : []
    return { ok, r, judged: String(judged[0]?.id), key: [o.writer, judged[0]?.id].join("|"), cells: new Set(chain.filter((x) => x !== undefined && treated(x.id) && !failed.has(x.id)).map((x) => String(x?.cell))), by: String(o.role), deadline, ...(refused ? { refused } : {}) }
  }
  return seen
    .filter((r) => r.shape === OUTCOME)
    .filter((r) => GRADERS.has(r.role))
    .filter((r) => r.seq <= asOf)
    .map(credit)
}

// How the walk's own grades (described outcomes) fared, over every one written: how many were written and how many
// counted, of answers and of deadlines (lapses) apart, and why the rest did not count. A detector reads it to see grades
// being written that the fold never counts. Cumulative: a reader compares two of these to see what changed between.
export type Tally = { written: { answer: number; lapse: number }; counted: { answer: number; lapse: number }; refused: Record<string, number> }
export const tally = (all: Row[], asOf: number, atSeq: number): Tally => {
  const t: Tally = { written: { answer: 0, lapse: 0 }, counted: { answer: 0, lapse: 0 }, refused: {} }
  for (const g of grades(all, asOf, atSeq).filter((x) => x.by === DESCRIBED)) {
    const kind = g.deadline ? "lapse" : "answer"
    t.written[kind]++
    if (g.ok) t.counted[kind]++
    else t.refused[g.refused ?? "other"] = (t.refused[g.refused ?? "other"] ?? 0) + 1
  }
  return t
}

// The grades that stand: those that count, and of each writer's grades of one answer only the latest (a repeat
// replaces, never adds), as the fold below folds them. A person who grades an answer r 1 and then r 0 has not closed it.
export const standing = (all: Row[], asOf: number, atSeq: number): Grade[] =>
  [...new Map(grades(all, asOf, atSeq).filter((k) => k.ok).map((k) => [k.key, k])).values()]

// Whom a move's failure blames, decided once, here, and stamped on the failure row when it is written (store.ts), so
// every reader (this fold, and the walk deciding whether to call the same pointer again) reads one answer:
//   request: the vessel called answered and refused what was asked: a 200 carrying an error, or a 4xx other than
//            401/403 (the caller's credentials, which rotate) and 408/429 (the callee was busy);
//   callee:  anything else, an outage, a timeout or a transport error: not the move's fault;
//   walk:    the walk declined to run or record it (a kind of its own: skip, too_big, unrunnable).
const NOT_THE_REQUEST = new Set([401, 403, 408, 429])
export const blames = (f: Record<string, unknown>): "request" | "callee" | "walk" => {
  if (f.kind !== undefined) return "walk"
  const s = f.status
  return typeof s === "number" && (s === 200 || (s >= 400 && s < 500 && !NOT_THE_REQUEST.has(s))) ? "request" : "callee"
}
// A row written before the stamp keeps the rule it was counted by then: a 4xx that blames the request.
const blamed = (f: Row): string => typeof f.blames === "string" ? f.blames
  : (f.kind === undefined && typeof f.status === "number" && f.status !== 200 && blames(f) === "request" ? "request" : "callee")

// A move whose failure blames the request counts as r 0 for that move's cell only: the selection that made the call,
// treated, by the walk that wrote the failure; once per selection; never its chain, since it produced nothing. Kept
// apart from grades(): what closes a request and what lapses never read it, and its key cannot replace a grade's.
export const moveFailures = (all: Row[], asOf: number, atSeq: number): Grade[] => {
  const seen = all.filter((r) => r.seq <= atSeq)
  const sels = new Map(seen.filter((r) => r.shape === SELECTION).map((r) => [r.id, r]))
  const out = new Map<string, Grade>()
  for (const f of seen.filter((r) => r.shape === FAILURE && r.role === WALK && r.seq <= asOf)) {
    const s = sels.get(String(f.selection_ref))
    if (s === undefined || String(s.arm) !== TREATED || s.writer !== f.writer) continue
    if (blamed(f) !== "request") continue
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
