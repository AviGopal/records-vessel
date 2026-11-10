// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test"
import { fold } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

describe("posterior fold", () => {
  const ask = row("world_changed", "person", { what: "q" })
  const answerSel = row("selection", "walk", { arm: "treated", cell: "c" })
  const outcomeSel = row("selection", "walk", { arm: "treated", cell: "judge" })
  const controlSel = row("selection", "walk", { arm: "control", cell: "judge" })
  const answer = row("answer", "described", { selection_ref: answerSel.id, producer: "model-a", input_refs: [ask.id] })
  const otherSel = row("selection", "walk", { arm: "treated", cell: "elsewhere" })
  const otherAnswer = row("answer", "described", { selection_ref: otherSel.id, producer: "model-a" })
  const hop = row("hop", "walk", { output: { text: "draft" } })
  const grade = (fields: Record<string, unknown>) =>
    row("outcome", "described", { cell: "c", r: 1, selection_ref: outcomeSel.id, producer: "model-a", input_refs: [ask.id, answer.id], ...fields })
  const base = [ask, answerSel, outcomeSel, controlSel, answer, otherSel, otherAnswer, hop]
  const one = (o: Row, cell = "c", asOf = seq) => fold([...base, o], [cell], asOf, seq)[0]

  test("a grade that saw only the request and the answer it grades moves that cell, even from the same model", () => {
    expect(one(grade({}))).toEqual({ cell: "c", alpha: 2, beta: 1 })
  })

  test("a grade that saw the walk's own rows does not count", () => {
    expect(one(grade({ input_refs: [ask.id, answer.id, hop.id] }))).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("a grade that saw another grade does not count", () => {
    const earlier = grade({})
    const later = row("outcome", "described", { cell: "c", r: 0, selection_ref: outcomeSel.id, producer: "model-b", input_refs: [ask.id, answer.id, earlier.id] })
    expect(fold([...base, earlier, later], ["c"], seq, seq)[0]).toEqual({ cell: "c", alpha: 2, beta: 1 })
  })

  test("a grade made in the graded cell is never the answer another grade grades", () => {
    const sameCellSel = row("selection", "walk", { arm: "treated", cell: "c" })
    const earlier = row("outcome", "described", { cell: "c", r: 1, selection_ref: sameCellSel.id, producer: "model-a", input_refs: [ask.id, answer.id] })
    const later = row("outcome", "described", { cell: "c", r: 0, selection_ref: outcomeSel.id, producer: "model-a", input_refs: [ask.id, earlier.id] })
    // the earlier grade saw the request and the answer, so it counts; the later one saw only that grade, so it does not
    expect(fold([...base, sameCellSel, earlier, later], ["c"], seq, seq)[0]).toEqual({ cell: "c", alpha: 2, beta: 1 })
  })

  test("a grade whose answer was made in another cell does not count", () => {
    expect(one(grade({ input_refs: [ask.id, otherAnswer.id] }))).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("a grade that saw no answer does not count", () => {
    expect(one(grade({ input_refs: [ask.id] }))).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("a grade citing a row that does not exist does not count", () => {
    expect(one(grade({ input_refs: [ask.id, answer.id, "nowhere"] }))).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("a grade chosen by the control arm is not counted", () => {
    expect(one(grade({ selection_ref: controlSel.id }))).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("grades after as_of_seq are left out", () => {
    const g = grade({})
    expect(one(g, "c", g.seq - 1)).toEqual({ cell: "c", alpha: 1, beta: 1 })
  })

  test("a grade naming another cell does not move this one", () => {
    expect(one(grade({}), "other")).toEqual({ cell: "other", alpha: 1, beta: 1 })
  })

  test("the latest owner prior for the cell replaces Beta(1,1)", () => {
    const prior = row("prior", "owner", { cell: "c", alpha0: 3, beta0: 5 })
    expect(fold([prior, ...base, grade({ r: 0 })], ["c"], seq, seq)[0]).toEqual({ cell: "c", alpha: 3, beta: 6 })
  })
})
