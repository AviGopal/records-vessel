// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test"
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

  test("a clean grade credits the answer's cell and the earlier steps of its composition, even from the same model", () => {
    const g = grade({})
    expect(post([g], "c")).toEqual({ cell: "c", ...moved })
    expect(post([g], "step")).toEqual({ cell: "step", ...moved })
    expect(post([g], "judge")).toEqual({ cell: "judge", ...still })
  })

  test("a person's verdict citing the answer credits the same composition", () => {
    expect(post([verdict({})], "c")).toEqual({ cell: "c", ...moved })
    expect(post([verdict({})], "step")).toEqual({ cell: "step", ...moved })
    expect(post([verdict({ r: 0 })], "c")).toEqual({ cell: "c", alpha: 1, beta: 2 })
  })

  test("the cell comes from the answer, not from a cell copied onto the grade", () => {
    expect(post([grade({ cell: "mis-copied" })], "c")).toEqual({ cell: "c", ...moved })
  })

  test("a described grade that saw the walk's own rows does not count", () => {
    expect(post([grade({ input_refs: [ask.id, answer.id, hop.id] })], "c")).toEqual({ cell: "c", ...still })
  })

  test("a described grade that saw another grade does not count", () => {
    const earlier = grade({})
    const later = grade({ r: 0, input_refs: [ask.id, answer.id, earlier.id] })
    expect(post([earlier, later], "c")).toEqual({ cell: "c", ...moved })
  })

  test("a grade that saw several answers judges the one its evidence_refs names", () => {
    const two = [ask.id, answer.id, otherAnswer.id]
    expect(post([grade({ input_refs: two, evidence_refs: [answer.id] })], "c")).toEqual({ cell: "c", ...moved })
    expect(post([grade({ input_refs: two, evidence_refs: ["not-seen"] })], "c")).toEqual({ cell: "c", ...still })
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

  test("a lapsed deadline counts only as r 0, only after its time, and credits the waits that let it lapse", () => {
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
    expect(at(late, "step")).toEqual({ cell: "step", alpha: 1, beta: 2 })
    expect(at(late, "wait-cell")).toEqual({ cell: "wait-cell", alpha: 1, beta: 2 })
    expect(at(lapse({ t: "2026-11-10T09:59:00Z" }), "due-cell")).toEqual({ cell: "due-cell", ...still })
    expect(at(lapse({ r: 1 }), "due-cell")).toEqual({ cell: "due-cell", ...still })
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
