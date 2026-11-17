// SPDX-License-Identifier: MIT
// Rows for first-deadline.test.ts, and the serialisation its snapshot holds. first-deadline-run.ts writes
// first-deadline-snapshot.json from these on the parent's tree; the test compares this tree's grades to it.
import type { Row } from "../../src/store"

// Rows as store.ts write() makes them: input_refs defaulted, a deadline's `at` from records' clock plus within_ms (only
// for a finite within_ms >= 0; anything else keeps what the writer sent), seq, t, writer, role, then the sha256 id over
// all of it. The clock advances by dt per row (0: written in the same millisecond, which a live store does). seq forces a
// seq already used: the store never writes that, but the fold must still break the tie as the parent's stable sort did.
const T0 = Date.parse("2026-11-16T09:00:00.000Z")
type As = { writer: string; role: string }
const walk: As = { writer: "walk-1", role: "walk" }
const owner: As = { writer: "owner", role: "owner" }
const person: As = { writer: "kid-person", role: "person" }
const producer: As = { writer: "described-1", role: "described" }
const grader = (k = 1): As => ({ writer: `grader-${k}`, role: "described" })
const HOUR = 3_600_000

const store = () => {
  const rows: Row[] = []
  let seq = 0
  let clock = T0
  type O = { dt?: number; seq?: number }
  const add = (body: Record<string, unknown>, as: As, o: O = {}): Row => {
    const at = o.seq ?? ++seq
    clock += o.dt ?? 1000
    const t = new Date(clock).toISOString()
    const within = Number(body.within_ms)
    const deadline = typeof body.within_ms === "number" && Number.isFinite(within) && within >= 0 ? { at: Date.parse(t) + within } : {}
    const unsigned = { input_refs: [], ...body, ...deadline, seq: at, t, writer: as.writer, role: as.role }
    const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
    const row = { ...unsigned, shape: String(body.shape), id } as Row
    rows.push(row)
    return row
  }
  // The walk's selection as it writes one: its root, cell, arm and the pool it chose from.
  const select = (root: Row, cell: string, o: O = {}): Row =>
    add({ shape: "selection", arm: "treated", cell, a: `produce/${cell}`, root: root.id, pool_refs: [root.id], input_refs: [root.id],
      cands: [{ id: cell, kind: "produce", root: root.id }], posts: [{ alpha: 1, beta: 1, from: 0 }], posts_seq: seq }, walk, o)
  // A deadline row on a selection of its own, or on the one given (sel).
  const due = (ask: Row | Row[], within: unknown, more: Record<string, unknown> = {}, as: As = producer, o: O & { sel?: Row } = {}): Row => {
    const asks = [ask].flat()
    const s = o.sel ?? select(asks[0]!, "due", { dt: o.dt })
    return add({ shape: "due", within_ms: within, selection_ref: s.id, input_refs: asks.map((a) => a.id), ...more }, as, o)
  }
  // A promising answer (next_act, the owner's deferred_by) to the asks it cites.
  const answer = (ask: Row | Row[], promise = true): Row => {
    const asks = [ask].flat()
    const s = select(asks[0]!, "answer")
    return add({ shape: "answer", text: "t", selection_ref: s.id, input_refs: asks.map((a) => a.id), ...(promise ? { next_act: { tool: "git_land" } } : {}) }, producer)
  }
  // The walk's grader judging one answer, as an outcome on a selection of its own.
  const grade = (ask: Row, ans: Row, r: number, as: As = grader(), o: O = {}): Row => {
    const s = select(ask, "judge")
    return add({ shape: "outcome", r, selection_ref: s.id, input_refs: [ask.id, ans.id], evidence_refs: [ans.id] }, as, o)
  }
  const owners = (): void => {
    add({ shape: "arm", vessel_id: "walk-1", arm: "treated", as_of_seq: 1e9 }, owner)
    add({ shape: "shape_schema", target: "outcome", version: 1, context: ["answer", "due"],
      evidence: [{ shape: "answer", deferred_by: "next_act" }, { shape: "due", after: "at" }] }, owner)
    add({ shape: "credits", target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }, owner)
  }
  const ask = (what: string): Row => add({ shape: "world_changed", what }, person)
  return { rows, add, select, due, answer, grade, owners, ask }
}

// Every case a first deadline can turn on, each made so that the row the parent chooses and its rival straddle the
// grade's time (one deadline already passed, the other an hour ahead), so a different choice changes the grade.
export const world = (o: { flip?: boolean; unordered?: boolean } = {}): { rows: Row[]; gFirst: Row; gDue: Row; pair: { early: Row[]; late: Row[] } } => {
  const { rows, due, answer, grade, owners, ask, add, select } = store()
  owners()
  // A: two deadline rows at the SAME seq (an hour ahead, and one second), in the order flip says; later, a second
  // deadline that passes at once. The first in the list at the lowest seq decides.
  const a = ask("a")
  const aSel = select(a, "due")
  const ahead = due(a, HOUR, {}, producer, { sel: aSel })
  const soon = due(a, 1000, {}, producer, { sel: aSel, seq: ahead.seq })
  if (o.flip) rows.splice(rows.indexOf(ahead), 2, soon, ahead)
  const aFirst = rows.slice(rows.indexOf(aSel) + 1, rows.indexOf(aSel) + 3)
  const aAns = answer(a)
  const aLater = due(a, 0)
  grade(a, aAns, 0)
  // B: a described row with an `at` its writer sent and no within_ms (store adds none), before the real deadline
  const b = ask("b")
  due(b, "1000", { at: T0 })
  due(b, HOUR)
  const bAns = answer(b)
  grade(b, bAns, 0)
  // C: a within_ms the store gave no `at` (negative), before a real deadline that passes at once
  const c = ask("c")
  due(c, -1)
  due(c, 0)
  const cAns = answer(c)
  grade(c, cAns, 0)
  // D: a person's own deadline row (not the producer's) passing at once, before the producer's an hour ahead
  const d = ask("d")
  due(d, 0, {}, person)
  due(d, HOUR)
  const dAns = answer(d)
  grade(d, dAns, 0, grader(2))
  // E and F: one deadline row citing two asks, an hour ahead; F also had a deadline of its own that passed at once,
  // and an answer to both is exempt only while both are ahead
  const e = ask("e")
  const f = ask("f")
  due(f, 0)
  due([e, f], HOUR)
  const efAns = answer([e, f])
  grade(e, efAns, 0)
  const eAns = answer(e)
  grade(e, eAns, 1)
  // G: no deadline yet when graded; its first deadline is written in the same millisecond, with no time allowed
  const g = ask("g")
  const gAns = answer(g)
  const gFirst = grade(g, gAns, 0)
  const gDue = due(g, 0, {}, producer, { dt: 0 })
  grade(g, gAns, 1, grader(3), { dt: 0 })
  // H: an ask with no deadline at all, and a claim (no next_act), graded at once
  const h = ask("h")
  const hAns = answer(h, false)
  grade(h, hAns, 0)
  grade(h, answer(h), 1)
  // P and Q: one deadline row citing both, an hour ahead, as the producer writes it for an ask the owner's world_changed
  // and a person's ask stand behind together; neither ask has a deadline row of its own. So each ask's exemption turns
  // on that one row, by whichever ref names the ask: a promise to each, graded by the walk's grader before its `at`
  // (exempt), and again after it (counted, below).
  const p = add({ shape: "world_changed", what: "p" }, owner)
  const q = ask("q")
  due([p, q], HOUR)
  const pAns = answer(p)
  const qAns = answer(q)
  const early = [grade(p, pAns, 0), grade(q, qAns, 0)]
  // a person's grades: of a promise (never exempt) and of A's answer
  add({ shape: "outcome", r: 1, input_refs: [aAns.id], evidence_refs: [aAns.id] }, person)
  add({ shape: "outcome", r: 0, input_refs: [dAns.id], evidence_refs: [dAns.id] }, person)
  // after A's deadlines have passed: the grader again, on A, B, D, and on A's later answer
  grade(a, aAns, 1, grader(4), { dt: 2 * HOUR })
  grade(b, bAns, 0, grader(4))
  grade(d, dAns, 1, grader(4))
  grade(a, answer(a), 0, grader(5))
  const late = [grade(p, pAns, 1, grader(7)), grade(q, qAns, 1, grader(7))]
  // a new credits row from the owner, then one last grade
  add({ shape: "credits", target: "selection", w_person: 2, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }, owner)
  grade(e, efAns, 1, grader(6))
  // the list not in seq order: A's later deadline written ahead of A's first pair in the list
  if (o.unordered) {
    rows.splice(rows.indexOf(aLater), 1)
    rows.splice(rows.indexOf(aFirst[0]!), 0, aLater)
  }
  return { rows, gFirst, gDue, pair: { early, late } }
}

// Grades serialised with their order: arrays as they are; a Set or Map both in insertion order and sorted.
export const ser = (gs: unknown): string => JSON.stringify(gs, (_k, v) =>
  v instanceof Set ? { set: [...v], sorted: [...v].map(String).sort() }
  : v instanceof Map ? { map: [...v], sorted: [...v].map(([k, x]) => [String(k), x] as const).sort((p, q) => (p[0] < q[0] ? -1 : p[0] > q[0] ? 1 : 0)) }
  : v)
export const seqs = (rows: Row[]): number[] => [...new Set(rows.map((r) => r.seq))].sort((x, y) => x - y)
export const LEGS: Record<string, () => Row[]> = {
  "same seq, the hour-ahead row first in the list": () => world().rows,
  "same seq, the one-second row first in the list": () => world({ flip: true }).rows,
  "later-seq deadline ahead in the list": () => world({ unordered: true }).rows,
  "unordered and flipped": () => world({ flip: true, unordered: true }).rows,
}

// N rows, K grades by the walk's grader of one promising answer before its deadline (each exempt), padded with ended
// hops to N.
export const exemptWorld = (k: number, n: number): Row[] => {
  const { rows, due, answer, grade, owners, ask, add } = store()
  owners()
  const a = ask("a")
  due(a, 24 * HOUR)
  const ans = answer(a)
  for (let i = 1; i <= k; i++) grade(a, ans, 0, grader(i), { dt: 1 })
  while (rows.length < n) add({ shape: "hop", phase: "ended", call_id: `c${rows.length}`, kind: "call", output: { ok: true } }, walk, { dt: 1 })
  return rows
}
