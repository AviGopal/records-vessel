// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import { fold } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

describe("posterior fold", () => {
  const ask = row("world_changed", "person", { what: "q" })
  const stepSel = row("selection", "walk", { arm: "treated", cell: "step" })
  const answerSel = row("selection", "walk", { arm: "treated", cell: "c", pool_refs: [ask.id, stepSel.id] })
  const outcomeSel = row("selection", "walk", { arm: "treated", cell: "judge" })
  const controlSel = row("selection", "walk", { arm: "control", cell: "judge" })
  const answer = row("answer", "described", { selection_ref: answerSel.id, producer: "model-a", input_refs: [ask.id] })
  const controlAnswerSel = row("selection", "walk", { arm: "control", cell: "c", pool_refs: [stepSel.id] })
  const controlAnswer = row("answer", "described", { selection_ref: controlAnswerSel.id })
  const otherAnswer = row("answer", "described", { selection_ref: stepSel.id })
  const hop = row("hop", "walk", { output: { text: "draft" } })
  const grade = (fields: Record<string, unknown>) =>
    row("outcome", "described", { cell: "c", r: 1, selection_ref: outcomeSel.id, producer: "model-a", input_refs: [ask.id, answer.id], ...fields })
  const verdict = (fields: Record<string, unknown>) => row("outcome", "person", { r: 1, input_refs: [answer.id], ...fields })
  const base = [ask, stepSel, answerSel, outcomeSel, controlSel, answer, controlAnswerSel, controlAnswer, otherAnswer, hop]
  const post = (rows: Row[], cell: string, asOf = seq) => fold([...base, ...rows], [cell], asOf, seq)[0]
  const moved = { alpha: 2, beta: 1 }
  const still = { alpha: 1, beta: 1 }

  test("[MUST-FAIL] the walk's own described grade of an answer originates no credit, though it still counts as a grade", () => {
    const g = grade({})
    expect(post([g], "c")).toEqual({ cell: "c", ...still })
    expect(post([g], "step")).toEqual({ cell: "step", ...still })
    expect(F.grades([...base, g], seq, seq).at(-1)).toMatchObject({ ok: true }) // closing and lapses still read it
  })

  test("[MUST-FAIL] a person's verdict credits the answer's cell, and an earlier step only through what the answer consumed", () => {
    expect(post([verdict({})], "c")).toEqual({ cell: "c", ...moved })
    expect(post([verdict({})], "step")).toEqual({ cell: "step", ...still }) // in the pool, never consumed: nothing
    expect(post([verdict({ r: 0 })], "c")).toEqual({ cell: "c", alpha: 1, beta: 2 })
    const draft = row("hop", "walk", { selection_ref: stepSel.id, output: { text: "draft" } })
    const used = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, draft.id], uses: [draft.id] })
    const v = row("outcome", "person", { r: 1, input_refs: [used.id] })
    expect(fold([...base, draft, used, v], ["step"], seq, seq)[0]).toEqual({ cell: "step", alpha: 1.7, beta: 1 }) // one edge: w·0.7
    const shownOnly = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, draft.id] })
    const v2 = row("outcome", "person", { r: 1, input_refs: [shownOnly.id] })
    expect(fold([...base, draft, shownOnly, v2], ["step"], seq, seq)[0]).toEqual({ cell: "step", ...still }) // shown, not in uses
  })

  test("the cell comes from the answer, not from a cell copied onto the grade", () => {
    expect(post([verdict({ cell: "mis-copied" })], "c")).toEqual({ cell: "c", ...moved })
  })

  test("a described grade that saw the walk's own rows does not count", () => {
    expect(post([grade({ input_refs: [ask.id, answer.id, hop.id] })], "c")).toEqual({ cell: "c", ...still })
  })

  test("a described grade that saw another grade does not count", () => {
    const earlier = grade({})
    const later = grade({ r: 0, input_refs: [ask.id, answer.id, earlier.id] })
    const gs = F.grades([...base, earlier, later], seq, seq)
    expect(gs.at(-2)).toMatchObject({ ok: true })
    expect(gs.at(-1)).toMatchObject({ ok: false, refused: "unclean" })
  })

  test("a grade that saw several answers judges the one its evidence_refs names", () => {
    const two = [ask.id, answer.id, otherAnswer.id]
    expect(F.grades([...base, grade({ input_refs: two, evidence_refs: [answer.id] })], seq, seq).at(-1)).toMatchObject({ ok: true, judged: answer.id })
    expect(F.grades([...base, grade({ input_refs: two, evidence_refs: ["not-seen"] })], seq, seq).at(-1)).toMatchObject({ ok: false })
    expect(post([verdict({ input_refs: [answer.id, otherAnswer.id], evidence_refs: [answer.id] })], "c")).toEqual({ cell: "c", ...moved })
  })

  test("a later invalid grade does not cancel an earlier valid one", () => {
    const good = verdict({ r: 1 })
    const junk = verdict({ r: 7 })
    expect(post([good, junk], "c")).toEqual({ cell: "c", ...moved })
  })

  test("a grade citing two answers, or none, or a missing row, does not count", () => {
    expect(post([grade({ input_refs: [ask.id, answer.id, otherAnswer.id] })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ input_refs: [ask.id] })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ input_refs: [answer.id, otherAnswer.id] })], "c")).toEqual({ cell: "c", ...still })
    expect(post([grade({ input_refs: [ask.id, answer.id, "nowhere"] })], "c")).toEqual({ cell: "c", ...still })
  })

  test("a verdict on a control-arm answer, or a grade made by the control arm, does not count", () => {
    expect(post([verdict({ input_refs: [controlAnswer.id] })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ input_refs: [controlAnswer.id] })], "step")).toEqual({ cell: "step", ...still })
    expect(post([grade({ selection_ref: controlSel.id })], "c")).toEqual({ cell: "c", ...still })
  })

  test("only a grade with r a number from 0 to 1 counts", () => {
    expect(post([verdict({ r: 2 })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ r: "x" })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ r: undefined })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ r: -1 })], "c")).toEqual({ cell: "c", ...still })
    expect(post([verdict({ r: 0.5 })], "c")).toEqual({ cell: "c", alpha: 1.5, beta: 1.5 })
    for (const r of [null, "", "1", true, [1]]) expect(post([verdict({ r })], "c")).toEqual({ cell: "c", ...still })
  })

  test("a writer's latest grade of an answer replaces its earlier ones", () => {
    const first = verdict({ r: 1 })
    const again = verdict({ r: 1 })
    const changed = verdict({ r: 0 })
    expect(post([first, again], "c")).toEqual({ cell: "c", ...moved })
    expect(post([first, again, changed], "c")).toEqual({ cell: "c", alpha: 1, beta: 2 })
    const someoneElse = verdict({ r: 1, writer: "another-person" })
    expect(post([first, someoneElse], "c")).toEqual({ cell: "c", alpha: 3, beta: 1 })
  })

  test("[MUST-FAIL] a lapse, though the walk wrote it, originates r 0 at w_lapse along consumption, only after its time; the waits after it are not debited", () => {
    const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", pool_refs: [ask.id, stepSel.id] })
    const due = row("due", "described", { selection_ref: dueSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const waitSel = row("selection", "walk", { arm: "treated", cell: "wait-cell" })
    const graderSel = row("selection", "walk", { arm: "treated", cell: "judge", pool_refs: [ask.id, dueSel.id, due.id, waitSel.id] })
    const lapse = (fields: Record<string, unknown>) => row("outcome", "described", {
      r: 0, selection_ref: graderSel.id, input_refs: [ask.id, due.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z", ...fields,
    })
    const rows = [dueSel, due, waitSel, graderSel]
    const at = (g: Row, cell: string) => fold([...base, ...rows, g], [cell], seq, seq)[0]
    const late = lapse({})
    expect(at(late, "due-cell")).toEqual({ cell: "due-cell", alpha: 1, beta: 2 })
    expect(at(late, "step")).toEqual({ cell: "step", ...still }) // in the due's pool, not consumed
    expect(at(late, "wait-cell")).toEqual({ cell: "wait-cell", ...still }) // the rule for waits after a deadline is gone
    const heavier = row("credits", "owner", { target: "selection", w_lapse: 3 })
    expect(fold([...base, ...rows, heavier, late], ["due-cell"], seq, seq)[0]).toEqual({ cell: "due-cell", alpha: 1, beta: 4 })
    expect(at(lapse({ t: "2026-11-10T09:59:00Z" }), "due-cell")).toEqual({ cell: "due-cell", ...still })
    expect(at(lapse({ r: 1 }), "due-cell")).toEqual({ cell: "due-cell", ...still })
  })

  test("[MUST-FAIL] a lapse counts even when its grader also saw the walk's hops: a deadline passing is a fact, not a judgment", () => {
    const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", pool_refs: [ask.id, stepSel.id] })
    const due = row("due", "described", { selection_ref: dueSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const graderSel = row("selection", "walk", { arm: "treated", cell: "judge", pool_refs: [ask.id, dueSel.id, due.id] })
    const lapse = row("outcome", "described", {
      r: 0, selection_ref: graderSel.id, input_refs: [ask.id, due.id, hop.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z",
    })
    expect(fold([...base, dueSel, due, graderSel, lapse], ["due-cell"], seq, seq)[0]).toEqual({ cell: "due-cell", alpha: 1, beta: 2 })
  })

  test("a grade of an answer that saw the walk's hops still does not count (a guard: only a lapse is exempt)", () => {
    const g = grade({ input_refs: [ask.id, answer.id, hop.id] })
    expect(post([g], "c")).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  // The walk's rows as written: a started hop names the shape called and its kind; the ended hop, under the same call_id,
  // carries kind and output but no pointer_type.
  const callHops = (kind: string, id: string) => [
    row("hop", "walk", { phase: "started", kind, call_id: id, pointer_type: "fs_read", input: { path: "a" } }),
    row("hop", "walk", { phase: "ended", kind, call_id: id, output: { text: "contents" } }),
  ]
  // The owner's outcome schema as the seeder writes it: what a grade may judge, and which hops it is given
  const toolOutputs = { shape: "hop", where: { phase: "ended", kind: ["call", "run"] } }
  const outcomeSchema = (context: unknown[]) => row("shape_schema", "owner", { target: "outcome", context })

  test("[MUST-FAIL] (A) a grade that saw only the request, the answer and the ended hops of tool calls the owner gives it counts", () => {
    const [, ce] = callHops("call", "c1")
    const [, re] = callHops("run", "r1")
    const g = grade({ input_refs: [ask.id, answer.id, ce.id, re.id] })
    expect(F.grades([...base, ce, re, outcomeSchema(["answer", "due", toolOutputs]), g], seq, seq).at(-1)).toMatchObject({ ok: true })
  })

  test("(A) a produce or wait hop, or a call's started hop, still leaves the grade unclean (a guard)", () => {
    const [cs, ce] = callHops("call", "c2")
    const schema = outcomeSchema(["answer", "due", toolOutputs])
    for (const [, other] of [callHops("produce", "p1"), callHops("wait-for", "w1"), [undefined, cs]]) {
      const g = grade({ input_refs: [ask.id, answer.id, ce.id, other!.id] })
      expect(post([cs, ce, other!, schema, g], "c")).toEqual({ cell: "c", ...still })
    }
  })

  test("(A) a context entry with no where (the schema as seeded before) gives no hop: the same grade stays unclean (a guard)", () => {
    const [, ce] = callHops("call", "c3")
    const g = grade({ input_refs: [ask.id, answer.id, ce.id] })
    expect(post([ce, outcomeSchema(["answer", "due", "hop"]), g], "c")).toEqual({ cell: "c", ...still })
  })

  test("a grade whose evidence_refs name a deadline row it was not given judges nothing: refused as judged (a pin: the fold never reaches outside input_refs)", () => {
    const due = row("due", "described", { selection_ref: answerSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const g = row("outcome", "described", { r: 0, selection_ref: outcomeSel.id, input_refs: [ask.id, answer.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z" })
    expect(F.grades([...base, due, g], seq, seq).at(-1)).toMatchObject({ ok: false, refused: "judged" })
  })

  test("[MUST-FAIL] a described grade judging another request's row judges nothing, though it was given that row", () => {
    const other = row("world_changed", "person", { what: "another ask" })
    const theirs = row("due", "described", { selection_ref: answerSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [other.id] })
    const mine = row("due", "described", { selection_ref: answerSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const lapseOf = (due: Row) => row("outcome", "described", { r: 0, selection_ref: outcomeSel.id, input_refs: [ask.id, due.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z" })
    const [g1, g2] = [lapseOf(theirs), lapseOf(mine)]
    const gs = F.grades([...base, other, theirs, mine, g1, g2], seq, seq)
    expect(gs.at(-2)).toMatchObject({ ok: false, refused: "judged" })
    expect(gs.at(-1)).toMatchObject({ ok: true, deadline: true }) // its own request's lapse still counts (a guard)
  })

  test("[MUST-FAIL] (B) what a grade may judge is read from the owner's newest outcome schema: another described row it saw makes it unclean", () => {
    const wanted = row("change_wanted", "described", { wanted: false, input_refs: [ask.id] })
    const g = grade({ input_refs: [ask.id, answer.id, wanted.id], evidence_refs: [answer.id] })
    expect(F.grades([...base, wanted, outcomeSchema(["world_changed", "answer", "due"]), g], seq, seq).at(-1)).toMatchObject({ ok: false, refused: "unclean" })
    // the newest schema row is the one read: one naming change_wanted as context lets the same grade count (a guard)
    expect(F.grades([...base, wanted, outcomeSchema(["world_changed", "answer", "due"]), outcomeSchema(["answer", "change_wanted"]), g], seq, seq).at(-1)).toMatchObject({ ok: true })
  })

  test("[MUST-FAIL] the walk's grades are tallied: written and counted, answers and lapses apart, and why the rest were refused", () => {
    const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", pool_refs: [ask.id] })
    const due = row("due", "described", { selection_ref: dueSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const graderSel = row("selection", "walk", { arm: "treated", cell: "judge", pool_refs: [ask.id, dueSel.id, due.id] })
    const lapse = row("outcome", "described", { r: 0, selection_ref: graderSel.id, input_refs: [ask.id, due.id, hop.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z" })
    const sawHops = grade({ input_refs: [ask.id, answer.id, hop.id] }) // an answer grade that saw the walk's hops: refused
    const person = verdict({}) // a person's grade: not the walk's own, not tallied
    const t = F.tally?.([...base, dueSel, due, graderSel, lapse, sawHops, person], seq, seq)
    expect(t).toEqual({ written: { answer: 1, lapse: 1, detector: 0 }, counted: { answer: 0, lapse: 1, detector: 0 }, refused: { unclean: 1 } })
  })

  test("a row with only a guessed `at` (no within_ms) is not a deadline: no waits are debited", () => {
    const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", pool_refs: [ask.id] })
    const guessed = row("due", "described", { selection_ref: dueSel.id, at: Date.parse("2026-11-09T11:29:42Z"), input_refs: [ask.id] })
    const waitSel = row("selection", "walk", { arm: "treated", cell: "wait-cell" })
    const graderSel = row("selection", "walk", { arm: "treated", cell: "judge", pool_refs: [ask.id, dueSel.id, guessed.id, waitSel.id] })
    const g = row("outcome", "described", {
      r: 0, selection_ref: graderSel.id, input_refs: [ask.id, guessed.id], evidence_refs: [guessed.id], t: "2026-11-10T12:30:00Z",
    })
    expect(fold([...base, dueSel, guessed, waitSel, graderSel, g], ["wait-cell"], seq, seq)[0]).toEqual({ cell: "wait-cell", ...still })
  })

  test("grades after as_of_seq are left out", () => {
    const g = verdict({})
    expect(post([g], "c", g.seq - 1)).toEqual({ cell: "c", ...still })
  })

  test("the latest owner prior for the cell replaces Beta(1,1)", () => {
    const prior = row("prior", "owner", { cell: "c", alpha0: 3, beta0: 5 })
    expect(post([prior, verdict({ r: 0 })], "c")).toEqual({ cell: "c", alpha: 3, beta: 6 })
  })
})

describe("a move that failed", () => {
  const sel = row("selection", "walk", { arm: "treated", cell: "run/t1", pool_refs: [] })
  const earlier = row("selection", "walk", { arm: "treated", cell: "step2" })
  const chained = row("selection", "walk", { arm: "treated", cell: "run/t2", pool_refs: [earlier.id] })
  const control = row("selection", "walk", { arm: "control", cell: "run/t1" })
  const fail = (s: Row, fields: Record<string, unknown>) => row("failure", "walk", { selection_ref: s.id, status: 422, body: "x", ...fields })
  const post = (rows: Row[], cell: string) => fold([sel, earlier, chained, control, ...rows], [cell], seq, seq)[0]

  test("[MUST-FAIL] a 4xx the called vessel answered lowers the move's own cell, once per selection", () => {
    expect(post([fail(sel, {})], "run/t1")).toEqual({ cell: "run/t1", alpha: 1, beta: 2 })
    expect(post([fail(sel, {}), fail(sel, { status: 400 })], "run/t1")).toEqual({ cell: "run/t1", alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] an outage, a busy callee, the walk declining, or an untreated move does not count", () => {
    for (const f of [
      fail(sel, { status: 503 }), fail(sel, { status: 500 }), fail(sel, { status: 408 }), fail(sel, { status: 429 }),
      fail(sel, { status: 401 }), fail(sel, { status: 403 }),
      fail(sel, { status: undefined }), fail(sel, { kind: "skip", status: undefined }), fail(sel, { kind: "too_big" }),
      fail(control, {}),
    ]) expect(post([f], "run/t1")).toEqual({ cell: "run/t1", alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a failure records stamped as blaming the request is debited, a 200 refusal included; one blaming the callee is not", () => {
    expect(post([fail(sel, { status: 200, blames: "request" })], "run/t1")).toEqual({ cell: "run/t1", alpha: 1, beta: 2 })
    expect(post([fail(sel, { status: 422, blames: "callee" })], "run/t1")).toEqual({ cell: "run/t1", alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a refusal of what a request asked lowers the produce that wrote the request, not the call that carried it", () => {
    const wroteIt = row("selection", "walk", { arm: "treated", cell: "produce/request" })
    const asked = row("request", "described", { selection_ref: wroteIt.id, pointer: { type: "fs_edit" } })
    const called = row("selection", "walk", { arm: "treated", cell: "call/fs_edit", from: asked.id })
    const at = (rows: Row[], cell: string) => fold([sel, wroteIt, asked, called, ...rows], [cell], seq, seq)[0]
    const refused = fail(called, { status: 200, blames: "request" })
    expect(at([refused], "produce/request")).toEqual({ cell: "produce/request", alpha: 1, beta: 2 })
    expect(at([refused], "call/fs_edit")).toEqual({ cell: "call/fs_edit", alpha: 1, beta: 1 })
    // a call with no request behind it, or one whose request no treated produce wrote, is the move's own, as before
    const bare = row("selection", "walk", { arm: "treated", cell: "call/bare" })
    expect(at([bare, fail(bare, { status: 422 })], "call/bare")).toEqual({ cell: "call/bare", alpha: 1, beta: 2 })
    const untreated = row("selection", "walk", { arm: "control", cell: "produce/request" })
    const asked2 = row("request", "described", { selection_ref: untreated.id })
    const called2 = row("selection", "walk", { arm: "treated", cell: "call/fs_edit2", from: asked2.id })
    expect(at([untreated, asked2, called2, fail(called2, { status: 422 })], "call/fs_edit2")).toEqual({ cell: "call/fs_edit2", alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] a failure credits no chain: the steps before it are untouched", () => {
    expect(post([fail(chained, {})], "run/t2")).toEqual({ cell: "run/t2", alpha: 1, beta: 2 })
    expect(post([fail(chained, {})], "step2")).toEqual({ cell: "step2", alpha: 1, beta: 1 })
  })
})

describe("a step whose move failed", () => {
  const ask = row("world_changed", "person", { what: "q" })
  const okStep = row("selection", "walk", { arm: "treated", cell: "ok-step" })
  const badStep = row("selection", "walk", { arm: "treated", cell: "bad-step" })
  const answerSel = row("selection", "walk", { arm: "treated", cell: "answer-cell", pool_refs: [ask.id, okStep.id, badStep.id] })
  // Each step made a row the answer used (uses), so a verdict on the answer reaches both steps, one edge away (w·0.7).
  const okOut = row("hop", "walk", { selection_ref: okStep.id, output: { text: "ok" } })
  const badOut = row("hop", "walk", { selection_ref: badStep.id, output: { text: "bad" } })
  const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, okOut.id, badOut.id], uses: [okOut.id, badOut.id] })
  const verdict = (r: number) => row("outcome", "person", { r, input_refs: [answer.id] })
  const failOf = (s: Row, fields: Record<string, unknown>) => row("failure", "walk", { selection_ref: s.id, status: 500, body: "x", ...fields })
  const post = (rows: Row[], cell: string) => fold([ask, okStep, badStep, answerSel, okOut, badOut, answer, ...rows], [cell], seq, seq)[0]

  test("[MUST-FAIL] (a) a step that failed with a 500 gets no credit from a grade of the answer it preceded", () => {
    expect(post([failOf(badStep, {}), verdict(1)], "bad-step")).toEqual({ cell: "bad-step", alpha: 1, beta: 1 })
  })

  test("(b) a skip row names a template, not the move it was written beside: that step keeps its credit (a pin)", () => {
    expect(post([failOf(badStep, { kind: "skip", status: undefined }), verdict(1)], "bad-step")).toEqual({ cell: "bad-step", alpha: 1.7, beta: 1 })
  })

  test("[MUST-FAIL] (c) a step that failed with a 422 gets only that failure's r 0, never the answer's credit", () => {
    expect(post([failOf(badStep, { status: 422 }), verdict(1)], "bad-step")).toEqual({ cell: "bad-step", alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] (d) a failure the walk records for its own decline (too_big, unrunnable) also leaves the step out", () => {
    for (const kind of ["too_big", "unrunnable"]) {
      expect(post([failOf(badStep, { kind, status: kind === "unrunnable" ? 400 : undefined }), verdict(1)], "bad-step").alpha).toBe(1)
    }
  })

  test("(e) a sibling step with no failure, and the answer's own selection, are still credited (a guard)", () => {
    const rows = [failOf(badStep, {}), verdict(1)]
    expect(post(rows, "ok-step")).toEqual({ cell: "ok-step", alpha: 1.7, beta: 1 })
    expect(post(rows, "answer-cell")).toEqual({ cell: "answer-cell", alpha: 2, beta: 1 })
  })

  test("(f) a failure row another writer wrote does not remove the step (a guard)", () => {
    expect(post([failOf(badStep, { writer: "someone-else" }), verdict(1)], "bad-step")).toEqual({ cell: "bad-step", alpha: 1.7, beta: 1 })
  })

  test("(g) a lapse no longer debits the waits after the deadline: it travels only along what was consumed", () => {
    const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", pool_refs: [ask.id] })
    const due = row("due", "described", { selection_ref: dueSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const waitSel = row("selection", "walk", { arm: "treated", cell: "wait-cell" })
    const graderSel = row("selection", "walk", { arm: "treated", cell: "judge", pool_refs: [ask.id, dueSel.id, due.id, waitSel.id] })
    const lapse = row("outcome", "described", { r: 0, selection_ref: graderSel.id, input_refs: [ask.id, due.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z" })
    expect(fold([ask, dueSel, due, waitSel, graderSel, lapse], ["wait-cell"], seq, seq)[0]).toEqual({ cell: "wait-cell", alpha: 1, beta: 1 })
    expect(fold([ask, dueSel, due, waitSel, graderSel, lapse], ["due-cell"], seq, seq)[0]).toEqual({ cell: "due-cell", alpha: 1, beta: 2 })
  })
})

describe("a cell with no evidence of its own backs off to a coarser one", () => {
  const ask = row("world_changed", "person", { what: "q" })
  const A = "produce/answer/ch1"
  const cell = (ctx: string, who = "person") => `${A}|${ctx},asker:${who},age:0`
  // one graded composition per (cell, r): an answer whose selection is that cell, judged by a person
  const graded = (c: string, r: number): Row[] => {
    const sel = row("selection", "walk", { arm: "treated", cell: c, pool_refs: [ask.id] })
    const answer = row("answer", "described", { selection_ref: sel.id, input_refs: [ask.id] })
    return [sel, answer, row("outcome", "person", { r, input_refs: [answer.id], writer: `p-${sel.id}` })]
  }
  const post = (rows: Row[], c: string) => fold([ask, ...rows], [c], seq, seq)[0]

  test("[MUST-FAIL] a cell never graded takes the evidence of the same move for the same asker", () => {
    const rows = [...graded(cell("hop"), 1), ...graded(cell("hop,failure"), 1)]
    expect(post(rows, cell("answer,hop"))).toEqual({ cell: cell("answer,hop"), alpha: 3, beta: 1 })
  })

  test("[MUST-FAIL] with none for that asker, the same move anywhere", () => {
    const rows = graded(cell("hop", "owner"), 0)
    expect(post(rows, cell("hop", "person"))).toEqual({ cell: cell("hop", "person"), alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] the answer says which level it came from", () => {
    const rows = [...graded(cell("hop"), 1), ...graded(cell("x", "owner"), 0)]
    const from = (c: string) => F.foldFrom?.([ask, ...rows], [c], seq, seq)[0]?.from
    expect([from(cell("hop")), from(cell("y")), from(cell("y", "detector")), from("produce/due/ch1|hop,asker:person,age:0")])
      .toEqual(["cell", "asker", "move", "none"])
  })

  test("the finest level with evidence answers: a cell's own grades are not mixed with the move's (a guard)", () => {
    const rows = [...graded(cell("hop"), 1), ...graded(cell("other"), 0), ...graded(cell("other2"), 0)]
    expect(post(rows, cell("hop"))).toEqual({ cell: cell("hop"), alpha: 2, beta: 1 })
  })

  test("another move's evidence is never shared (a guard)", () => {
    expect(post(graded(cell("hop"), 1), "produce/due/ch1|hop,asker:person,age:0")).toEqual({ cell: "produce/due/ch1|hop,asker:person,age:0", alpha: 1, beta: 1 })
  })
})

describe("a detector's gap row", () => {
  test("a person's grade on a gap row judges nothing: refused as judged, no cell moves (a guard: answers keep only described rows)", () => {
    const sel = row("selection", "walk", { arm: "treated", cell: "x" })
    const gap = row("gap", "detector", { gap_id: "g1", status: "open", selection_ref: sel.id, input_refs: [sel.id] })
    const right = row("outcome", "person", { r: 1, input_refs: [gap.id] })
    const wrong = row("outcome", "person", { r: 0, input_refs: [gap.id] })
    const gs = F.grades([sel, gap, right, wrong], seq, seq)
    expect(gs.slice(-2)).toMatchObject([{ ok: false, refused: "judged" }, { ok: false, refused: "judged" }])
    expect(fold([sel, gap, right, wrong], ["x"], seq, seq)[0]).toEqual({ cell: "x", alpha: 1, beta: 1 })
  })
  test("never counts as a grade or a move's failure (a pin: fold never read gap rows)", () => {
    const sel = row("selection", "walk", { arm: "treated", cell: "x" })
    const gap = row("gap", "detector", { gap_id: "g1", status: "open", r: 0, selection_ref: sel.id, status_code: 422 })
    const closed = row("gap", "detector", { gap_id: "g1", status: "closed", r: 1, input_refs: [sel.id] })
    expect(fold([sel, gap, closed], ["x"], seq, seq)[0]).toEqual({ cell: "x", alpha: 1, beta: 1 })
  })
})

// A gap no one asks for is closed by its detector; that closing credits the walk's steps on it only after the walk
// changed something there (a call of the owner's credits.by_call that ended, in a selection that did not fail). Rows are
// in the live forms: the started hop names the shape called, the ended hop only its call_id; a gap row is the detector's.
describe("a detector closing a gap", () => {
  let n = 0
  const at = (shape: string, role: string, fields: Record<string, unknown>): Row =>
    ({ shape, role, writer: role, id: `${shape}-g${++n}`, seq: 0, t: "", input_refs: [], ...fields }) as Row
  const build = (steps: Array<(rows: Row[]) => Row[] | Row>) => {
    const rows: Row[] = []
    for (const s of steps) for (const r of [s(rows)].flat()) rows.push({ ...r, seq: rows.length + 1 })
    return rows
  }
  const rule = () => at("credits", "owner", { target: "gap", by_call: "land_it" })
  const gapRow = (status: string) => () => at("gap", "detector", { gap_id: "g1", status })
  const last = (rows: Row[], shape: string) => [...rows].reverse().find((r) => r.shape === shape)!
  const sel = (cell: string) => (rows: Row[]) => at("selection", "walk", { arm: "treated", cell, pool_refs: [last(rows, "gap").id] })
  const call = (type: string, ok = true) => (rows: Row[]) => {
    const s = last(rows, "selection")
    const id = `call-${++n}`
    return [
      at("hop", "walk", { phase: "started", kind: "call", pointer_type: type, call_id: id, selection_ref: s.id }),
      ok ? at("hop", "walk", { phase: "ended", call_id: id, selection_ref: s.id, output: { pushed: true } })
        : at("failure", "walk", { call_id: id, selection_ref: s.id, status: 200, body: "refused" }),
    ]
  }
  const post = (rows: Row[], cell: string) => fold(rows, [cell], rows.length, rows.length)[0]

  test("[MUST-FAIL] a closing after the walk's landing on the gap credits every step it took there", () => {
    const rows = build([rule, gapRow("open"), sel("ask"), sel("land"), call("land_it"), gapRow("closed")])
    expect(post(rows, "ask")).toEqual({ cell: "ask", alpha: 2, beta: 1 })
    expect(post(rows, "land")).toEqual({ cell: "land", alpha: 2, beta: 1 })
    expect(F.tally(rows, rows.length, rows.length).counted.detector).toBe(1)
  })

  test("[MUST-FAIL] a closing with no landing, or after a landing that failed, credits nothing and is refused as no_change", () => {
    const none = build([rule, gapRow("open"), sel("ask"), sel("other"), call("read_it"), gapRow("closed")])
    expect(post(none, "ask")).toEqual({ cell: "ask", alpha: 1, beta: 1 })
    const failed = build([rule, gapRow("open"), sel("ask"), sel("land"), call("land_it", false), gapRow("closed")])
    expect(post(failed, "ask")).toEqual({ cell: "ask", alpha: 1, beta: 1 })
    const t = F.tally(failed, failed.length, failed.length)
    expect([t.written.detector, t.counted.detector, t.refused.no_change]).toEqual([1, 0, 1])
  })

  test("[MUST-FAIL] a gap that reopens credits each closing only with the work since it reopened", () => {
    const rows = build([rule, gapRow("open"), sel("first"), call("land_it"), gapRow("closed"),
      gapRow("open"), sel("second"), call("land_it"), gapRow("closed")])
    expect(post(rows, "first")).toEqual({ cell: "first", alpha: 2, beta: 1 }) // once, by the first closing
    expect(post(rows, "second")).toEqual({ cell: "second", alpha: 2, beta: 1 })
  })

  test("with no credits row the owner has not said what a change is: nothing is credited (a guard)", () => {
    const rows = build([gapRow("open"), sel("ask"), call("land_it"), gapRow("closed")])
    expect(post(rows, "ask")).toEqual({ cell: "ask", alpha: 1, beta: 1 })
  })

  test("a detector's closing is never a grade of an answer: it closes no request (a guard)", () => {
    const rows = build([rule, gapRow("open"), sel("ask"), call("land_it"), gapRow("closed")])
    expect(F.standing(rows, rows.length, rows.length)).toEqual([])
  })
})


describe("credit travels along consumption", () => {
  const ask = row("world_changed", "person", { what: "q" })
  const sel = (cell: string, fields: Record<string, unknown> = {}) => row("selection", "walk", { arm: "treated", cell, ...fields })
  const out = (s: Row, fields: Record<string, unknown> = {}) => row("hop", "walk", { selection_ref: s.id, output: {}, ...fields })
  const at = (rows: Row[], cell: string) => fold(rows, [cell], seq, seq)[0]

  test("[MUST-FAIL] a diamond credits the shared ancestor once, at its shortest distance, never once per path", () => {
    const root = sel("root-step")
    const rootOut = out(root)
    const left = sel("left", { a: "produce/x/ch" })
    const leftRow = row("note", "described", { selection_ref: left.id, input_refs: [rootOut.id], uses: [rootOut.id] })
    const right = sel("right", { a: "produce/x/ch" })
    const rightRow = row("note", "described", { selection_ref: right.id, input_refs: [rootOut.id], uses: [rootOut.id] })
    const answerSel = sel("answer-cell")
    const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, leftRow.id, rightRow.id], uses: [leftRow.id, rightRow.id] })
    const v = row("outcome", "person", { r: 1, input_refs: [answer.id] })
    const rows = [ask, root, rootOut, left, leftRow, right, rightRow, answerSel, answer, v]
    expect(at(rows, "left")).toEqual({ cell: "left", alpha: 1.7, beta: 1 })
    expect(at(rows, "right")).toEqual({ cell: "right", alpha: 1.7, beta: 1 })
    const shared = at(rows, "root-step")
    expect(shared.alpha).toBeCloseTo(1 + 0.49, 10) // once, at depth 2: 0.7², not 0.49 + 0.49
    expect(shared.beta).toBe(1)
  })

  test("[MUST-FAIL] a call passes credit to the produce that wrote its request, and nothing passes beyond the owner's depth", () => {
    const reqSel = sel("request-produce", { a: "produce/request/ch" })
    const request = row("request", "described", { selection_ref: reqSel.id, input_refs: [ask.id], pointer: { type: "fs_read" } })
    const callSel = sel("call-cell", { a: "call/fs_read", from: request.id })
    const callOut = out(callSel)
    const answerSel = sel("answer-cell")
    const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, callOut.id], uses: [callOut.id] })
    const v = row("outcome", "person", { r: 1, input_refs: [answer.id] })
    const rows = [ask, reqSel, request, callSel, callOut, answerSel, answer, v]
    expect(at(rows, "call-cell")).toEqual({ cell: "call-cell", alpha: 1.7, beta: 1 })
    expect(at(rows, "request-produce").alpha).toBeCloseTo(1.49, 10)
    const shallow = row("credits", "owner", { target: "selection", depth: 1 })
    expect(at([...rows, shallow], "call-cell")).toEqual({ cell: "call-cell", alpha: 1.7, beta: 1 })
    expect(at([...rows, shallow], "request-produce")).toEqual({ cell: "request-produce", alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a cell whose calls end but are never consumed keeps its prior: ending earns nothing", () => {
    const callSel = sel("busy-call", { a: "call/fs_read" })
    const started = row("hop", "walk", { selection_ref: callSel.id, phase: "started", call_id: "k1", pointer_type: "fs_read" })
    const ended = row("hop", "walk", { selection_ref: callSel.id, phase: "ended", call_id: "k1", output: { text: "x" } })
    const answerSel = sel("answer-cell")
    const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id, ended.id] }) // shown, not used
    const v = row("outcome", "person", { r: 1, input_refs: [answer.id] })
    expect(at([ask, callSel, started, ended, answerSel, answer, v], "busy-call")).toEqual({ cell: "busy-call", alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] the walk's own lapse row originates r 0 at w_lapse, and its own non-lapse grade nothing (keyed on the lapse, not the role)", () => {
    const dueSel = sel("due-cell")
    const due = row("due", "described", { selection_ref: dueSel.id, within_ms: 60_000, at: Date.parse("2026-11-10T10:00:00Z"), input_refs: [ask.id] })
    const graderSel = sel("judge")
    const lapse = row("outcome", "described", { r: 0, selection_ref: graderSel.id, input_refs: [ask.id, due.id], evidence_refs: [due.id], t: "2026-11-10T10:30:00Z" })
    expect(at([ask, dueSel, due, graderSel, lapse], "due-cell")).toEqual({ cell: "due-cell", alpha: 1, beta: 2 })
    const answerSel = sel("answer-cell")
    const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id] })
    const own = row("outcome", "described", { r: 1, selection_ref: graderSel.id, input_refs: [ask.id, answer.id] })
    expect(at([ask, graderSel, answerSel, answer, own], "answer-cell")).toEqual({ cell: "answer-cell", alpha: 1, beta: 1 })
  })
})
