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

  test("grades after as_of_seq are left out", () => {
    const g = verdict({})
    expect(post([g], "c", g.seq - 1)).toEqual({ cell: "c", ...still })
  })

  test("the latest owner prior for the cell replaces Beta(1,1)", () => {
    const prior = row("prior", "owner", { cell: "c", alpha0: 3, beta0: 5 })
    expect(post([prior, verdict({ r: 0 })], "c")).toEqual({ cell: "c", alpha: 3, beta: 6 })
  })
})
