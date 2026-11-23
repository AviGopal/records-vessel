// SPDX-License-Identifier: MIT
// What crosses to another root's work: a debit always (a missed deadline always counts, by the owner's ruling, 11-16);
// credit only from a person's grade (by the owner's ruling, 11-17). A plan minted by a selection on root A and run on root B:
// a produce on B that uses the run's output, graded on B. A person's grade carries credit back over the run to A's mint
// at gamma^k; a kept promise, the walk's own grader's r 1 or an r 1 from a detector role credits B's work only (a
// detector's close credits its gap's own chain and does not travel through reached()); a lapse or a broken promise
// debits A's mint as before. A selection with no root is not known to be on another one: its edges are walked. All on one root, every originator carries as
// before. A citation alone, with no grade, originates nothing. The rows are the forms the walk, described-shape, the graders and the owner write.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// far in the wall clock's future, so only the store's own clock (its newest row) can say a deadline has passed
const T0 = Date.parse("2099-01-01T10:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields }) as Row

const MINT = "produce/activity_template/ch1|world_changed,did:none,asker:person,age:0"
const RUN = "run|world_changed,did:none,asker:person,age:0"
const ANS = "produce/answer/ch1|world_changed,did:none,asker:person,age:0"
const T = { w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 } as F.Travel
const K2 = 0.7 * 0.7 // answer k 0, run k 1, mint k 2
// the parent's (8c05b1c) answer for the mixed pool of debits below, as it printed it, but the run's alpha: B's answer
// uses the run's output at the next selection, within the window, so the use grade credits the run once (r 1 at w_check);
// and the grader's cell, which has no grade of its own, draws from its kind's record (the produces' debits) since a move
// never graded starts from its kind's (USER ruling 11-23): with that level left out, it is the parent's 1/1 from none
const EXPECTED_MIXED = {
  lapse: [true, 0, 0.48999999999999994], grader: [true, 0, 0.48999999999999994], promise: [true, 0, 0.48999999999999994],
  posts: [[ANS, 1, 3, "cell"], [RUN, 2, 2.4, "cell"], [MINT, 1, 1.98, "cell"], ["produce/outcome|answer", 1, 3, "kind"]],
}

// The plan's mint on root A (or on B: sameRoot), its run on B, and B's answer using the run's output.
const world = (o: { sameRoot?: boolean; promise?: boolean; due?: boolean; noRoot?: "mint" | "run" } = {}) => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", { target: "selection", ...T, ...(o.promise ? { w_check: 1, promise_window: 1 } : {}) }))
  if (o.promise) add(row("requires", "owner", { for: "fs_edit", needs: "change_wanted", where: { wanted: true } }))
  const askA = add(row("world_changed", "person", { what: "make a plan for this" }))
  const askB = add(row("world_changed", "person", { what: "do the same elsewhere" }))
  if (o.promise) add(row("change_wanted", "described", { wanted: true, repo: "some-vessel", input_refs: [askB.id] }))
  const mintSel = add(row("selection", "walk", { arm: "treated", cell: MINT, a: "produce/activity_template/ch1", ...(o.noRoot === "mint" ? {} : { root: o.sameRoot ? askB.id : askA.id }) }))
  const tpl = add(row("activity_template", "described", { selection_ref: mintSel.id, input_refs: [o.sameRoot ? askB.id : askA.id], calls: [] }))
  const runSel = add(row("selection", "walk", { arm: "treated", cell: RUN, a: `run/${tpl.id}`, ...(o.noRoot === "run" ? {} : { root: askB.id }) }))
  const hop = add(row("hop", "walk", { phase: "ended", call_id: "c1", selection_ref: runSel.id }))
  const ansSel = add(row("selection", "walk", { arm: "treated", cell: ANS, a: "produce/answer/ch1", root: askB.id }))
  const answer = add(row("answer", "described", { text: "done", selection_ref: ansSel.id, input_refs: [askB.id, hop.id], uses: [hop.id],
    ...(o.promise ? { next_act: { tool: "fs_edit", target: "src/x.ts" } } : {}) }))
  const due = o.due ? add(row("due", "described", { within_ms: 60_000, at: T0 + 60_000, selection_ref: ansSel.id, input_refs: [askB.id, hop.id], uses: [hop.id] })) : undefined
  const reach = (by: string, r: number) => F.reached(F.indexOf(rows), ansSel.id, T, { by, r })
  const post = (cell: string) => F.foldFrom(rows, [cell], 1e9, 1e9)[0]
  return { rows, add, askA, askB, mintSel, tpl, runSel, hop, ansSel, answer, due, reach, post }
}
// a person's verdict on B's answer
const personGrade = (w: ReturnType<typeof world>) => w.add(row("outcome", "person", { r: 1, input_refs: [w.askB.id, w.answer.id] }, 30_000))
// the walk's own grader, on B, judging B's answer (it saw the ask and the answer only: clean)
const graderGrade = (w: ReturnType<typeof world>) => {
  const gSel = w.add(row("selection", "walk", { arm: "treated", cell: "produce/outcome|answer", a: "produce/outcome", root: w.askB.id }))
  return w.add(row("outcome", "described", { r: 1, selection_ref: gSel.id, input_refs: [w.askB.id, w.answer.id] }, 30_000))
}
const tick = (w: ReturnType<typeof world>) => w.add(row("hop", "walk", { phase: "ended" }, 120_000)) // moves the store's clock

// the walk calling fs_edit on src/x.ts on B: what keeps the answer's promise (its request, the call's selection, its started hop)
const keep = (w: ReturnType<typeof world>) => {
  const req = w.add(row("request", "described", { pointer: { type: "fs_edit", path: "/walk-trees/some-vessel-x/src/x.ts" }, input_refs: [w.askB.id] }))
  const sel = w.add(row("selection", "walk", { arm: "treated", cell: "call/fs_edit|request", a: "call/fs_edit", from: req.id, root: w.askB.id }))
  w.add(row("hop", "walk", { selection_ref: sel.id, call_id: "c2", phase: "started", kind: "call", pointer_type: "fs_edit" }))
}

describe("what crosses to another root's work: a debit always, credit only from a person's grade", () => {
  // Leg 1: credit from anyone but a person stops at the root; a debit crosses.
  test("[GUARD] reached(): a kept promise or the walk's grader's r 1 on B walks to B's run, not to A's mint", () => {
    const w = world()
    for (const by of ["promise", "described"]) {
      const got = w.reach(by, 1)
      expect([by, got.get(w.ansSel.id), got.has(w.runSel.id), got.has(w.mintSel.id)]).toEqual([by, 1, true, false])
    }
  })
  test("reached(): an r 0 from any originator walks on to A's mint at gamma^k (a debit always crosses)", () => {
    const w = world()
    for (const by of [F.LAPSE, "promise", "described"]) expect([by, w.reach(by, 0).get(w.mintSel.id)]).toEqual([by, K2])
  })
  test("[MUST-FAIL] the walk's grader's r 1 on B's answer weighs B's cells, never A's mint", () => {
    const w = world()
    const g = graderGrade(w)
    const k = F.grades(w.rows, 1e9, 1e9).find((x) => x.id === g.id)!
    expect(k).toMatchObject({ ok: true, by: "described" })
    expect([k.weights.get(ANS), k.weights.get(RUN), k.weights.has(MINT)]).toEqual([1, 0.7, false])
  })
  test("[MUST-FAIL] a kept promise on B credits B's makers and A's mint not at all", () => {
    const w = world({ promise: true })
    keep(w)
    const [k] = F.promiseGrades(w.rows, 1e9, 1e9)
    expect(k).toMatchObject({ ok: true, r: 1, judged: w.ansSel.id })
    expect([k.weights.get(ANS), k.weights.get(RUN), k.weights.has(MINT)]).toEqual([1, 0.7, false])
    // A's mint has no grade of its own: it draws from its kind's record (B's answer's credit, a produce like it), not a credit
    expect([w.post(ANS), w.post(MINT)].map((p) => [p.alpha, p.beta, p.from])).toEqual([[2, 1, "cell"], [2, 1, "kind"]])
  })
  test("a derived lapse on B's deadline debits B's makers and A's mint at gamma^k, as before (deadlines always count)", () => {
    const w = world({ due: true })
    tick(w)
    const k = F.grades(w.rows, 1e9, 1e9).find((x) => x.by === F.LAPSE && x.judged === w.due!.id)!
    expect(k).toMatchObject({ ok: true, r: 0 })
    expect([k.weights.get(ANS), k.weights.get(RUN), k.weights.get(MINT)]).toEqual([1, 0.7, K2])
    expect([w.post(ANS), w.post(RUN), w.post(MINT)].map((p) => [p.alpha, p.beta])).toEqual([[1, 2], [1, 1.7], [1, 1 + K2]])
  })
  test("a broken promise on B debits B's makers and A's mint at gamma^k, as before", () => {
    const w = world({ promise: true })
    w.add(row("selection", "walk", { arm: "treated", cell: "produce/request|world_changed", a: "produce/request", root: w.askB.id }))
    const [k] = F.promiseGrades(w.rows, 1e9, 1e9)
    expect(k).toMatchObject({ ok: true, r: 0, judged: w.ansSel.id })
    expect([k.weights.get(ANS), k.weights.get(RUN), k.weights.get(MINT)]).toEqual([1, 0.7, K2])
    expect([w.post(ANS), w.post(MINT)].map((p) => [p.alpha, p.beta])).toEqual([[1, 2], [1, 1 + K2]])
  })
  // The r 0 path is the parent's, whole: a mixed pool on B (a derived lapse, a broken promise, the walk's grader at r 0)
  // posts every cell exactly as before the rule. The expected posteriors are the parent's (8c05b1c), hard-coded. The
  // grader's r 0 of an answer is a counted grade whose weights reach A's mint, though foldFrom originates nothing from
  // it (only a person's grade or a deadline's r 0 does), so it moves no posterior here, before or after.
  test("a mixed pool of debits on B posts every cell as the parent did", () => {
    const w = world({ due: true, promise: true })
    const gSel = w.add(row("selection", "walk", { arm: "treated", cell: "produce/outcome|answer", a: "produce/outcome", root: w.askB.id }))
    const g = w.add(row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [w.askB.id, w.answer.id] }, 30_000))
    tick(w)
    const gs = F.grades(w.rows, 1e9, 1e9)
    const lapse = gs.find((x) => x.by === F.LAPSE && x.judged === w.due!.id)!
    const grader = gs.find((x) => x.id === g.id)!
    const [promise] = F.promiseGrades(w.rows, 1e9, 1e9)
    const got = {
      lapse: [lapse.ok, lapse.r, lapse.weights.get(MINT)], grader: [grader.ok, grader.r, grader.weights.get(MINT)], promise: [promise.ok, promise.r, promise.weights.get(MINT)],
      posts: F.foldFrom(w.rows, [ANS, RUN, MINT, "produce/outcome|answer"], 1e9, 1e9).map((p) => [p.cell, p.alpha, p.beta, p.from]),
    }
    expect(got).toEqual(EXPECTED_MIXED)
  })
  // Leg 2: a person's grade crosses, unchanged.
  test("a person's grade on B carries to A's mint at gamma^k, as before", () => {
    const w = world()
    personGrade(w)
    const p = w.post(MINT)
    expect([p.alpha, p.beta]).toEqual([1 + K2, 1])
    expect(w.post(ANS)).toMatchObject({ alpha: 2, beta: 1 })
  })
  test("a person's land verdict on a diff B's produce made carries to A's mint (a land verdict counts only from a person)", () => {
    const w = world()
    const diff = w.add(row("gitDiff", "walk", { selection_ref: w.ansSel.id, tree: "tree-1", input_refs: [w.askB.id] }))
    w.add(row("land_verdict", "person", { r: 1, tree: "tree-1", input_refs: [diff.id] }, 30_000))
    const [k] = F.landGrades(w.rows, 1e9, 1e9)
    expect(k.weights.get(MINT)).toBeCloseTo(K2)
  })
  // Leg 3: a detector role's r 1 does not cross. A detector's close credits its gap's own chain without reached(), and
  // an outcome row a detector wrote is no grader's (GRADERS) so grades() refuses it before reached(); what is held here
  // is that reached() itself, given that originator, stops at the root (on the parent everything crossed).
  test("[GUARD] an outcome row with role detector and r 1 on B does not credit A's mint", () => {
    const w = world()
    const d = w.add(row("outcome", "detector", { r: 1, input_refs: [w.askB.id, w.answer.id] }, 30_000))
    const got = w.reach("detector", 1)
    expect([got.get(w.ansSel.id), got.has(w.runSel.id), got.has(w.mintSel.id)]).toEqual([1, true, false])
    expect(F.grades(w.rows, 1e9, 1e9).filter((k) => k.id === d.id || k.weights.has(MINT))).toEqual([])
    expect([w.post(MINT).alpha, w.post(MINT).beta]).toEqual([1, 1])
  })
  // Leg 3a: an operator's grade is absent from the roles that cross by intent, so its credit stays in its root. An
  // outcome row an operator wrote is no grader's (GRADERS), so grades() refuses it before reached(); reached() itself,
  // given that originator, stops at the root.
  test("[GUARD] an operator's r 1 on B does not credit A's mint (operator absent from CROSSES by intent)", () => {
    const w = world()
    const o = w.add(row("outcome", "operator", { r: 1, input_refs: [w.askB.id, w.answer.id] }, 30_000))
    const got = w.reach("operator", 1)
    expect([got.get(w.ansSel.id), got.has(w.runSel.id), got.has(w.mintSel.id)]).toEqual([1, true, false])
    expect(F.grades(w.rows, 1e9, 1e9).filter((k) => k.id === o.id || k.weights.has(MINT))).toEqual([])
    expect([w.post(MINT).alpha, w.post(MINT).beta]).toEqual([1, 1])
  })
  // Leg 3b: a selection with no root is not known to be on another one, so the edge is walked (credit reaches across).
  test("a run with no root (the edge's from undefined at the mint): the walk's grader's r 1 reaches A's mint", () => {
    const w = world({ noRoot: "run" })
    expect(w.reach("described", 1).get(w.mintSel.id)).toBeCloseTo(K2)
  })
  test("a mint with no root (the edge's to undefined): the walk's grader's r 1 reaches the mint", () => {
    const w = world({ noRoot: "mint" })
    expect(w.reach("described", 1).get(w.mintSel.id)).toBeCloseTo(K2)
  })
  // Leg 4: on one root nothing changes.
  test("all on one root, every originator carries to the mint as before", () => {
    const w = world({ sameRoot: true })
    for (const by of ["promise", "described", "person", "detector"]) expect([by, w.reach(by, 1).get(w.mintSel.id)]).toEqual([by, K2])
    const g = graderGrade(w)
    expect(F.grades(w.rows, 1e9, 1e9).find((x) => x.id === g.id)!.weights.get(MINT)).toBeCloseTo(K2)
  })
  test("all on one root, a derived lapse debits the mint at gamma^k as before", () => {
    const w = world({ sameRoot: true, due: true })
    tick(w)
    expect([w.post(ANS).beta, w.post(MINT).beta]).toEqual([2, 1 + K2])
  })
  // Leg 5: a citation alone originates nothing.
  test("a row of A's that B's produce names in uses, with no grade on B, gives A nothing", () => {
    seq = 0
    const rows: Row[] = []
    const add = (r: Row): Row => { rows.push(r); return r }
    add(row("credits", "owner", { target: "selection", ...T }))
    const askA = add(row("world_changed", "person", { what: "a" }))
    const askB = add(row("world_changed", "person", { what: "b" }))
    const aSel = add(row("selection", "walk", { arm: "treated", cell: "produce/draft|a", a: "produce/draft", root: askA.id }))
    const draft = add(row("draft", "described", { selection_ref: aSel.id, input_refs: [askA.id] }))
    const bSel = add(row("selection", "walk", { arm: "treated", cell: "produce/answer|b", a: "produce/answer", root: askB.id }))
    add(row("answer", "described", { selection_ref: bSel.id, input_refs: [askB.id, draft.id], uses: [draft.id] }))
    add(row("hop", "walk", { phase: "ended" }, 120_000))
    expect(F.grades(rows, 1e9, 1e9).filter((k) => k.weights.has("produce/draft|a"))).toEqual([])
    expect(F.foldFrom(rows, ["produce/draft|a", "produce/answer|b"], 1e9, 1e9).map((p) => [p.alpha, p.beta])).toEqual([[1, 1], [1, 1]])
  })
})
