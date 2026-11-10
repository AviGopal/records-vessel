// SPDX-License-Identifier: MIT
import { describe, expect, test } from "bun:test"
import { fold } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

describe("posterior fold", () => {
  const answerSel = row("selection", "walk", { arm: "treated", cell: "c" })
  const outcomeSel = row("selection", "walk", { arm: "treated", cell: "judge" })
  const controlSel = row("selection", "walk", { arm: "control", cell: "judge" })
  const answer = row("answer", "described", { selection_ref: answerSel.id, producer: "model-a" })
  const win = row("outcome", "described", { cell: "c", r: 1, selection_ref: outcomeSel.id, producer: "model-b" })

  test("an outcome on the treated arm moves the cell it names", () => {
    const all = [answerSel, outcomeSel, answer, win]
    expect(fold(all, ["c"], seq, seq)).toEqual([{ cell: "c", alpha: 2, beta: 1 }])
  })

  test("an outcome by the producer that answered in that cell is not counted (no self-grading)", () => {
    const self = row("outcome", "described", { cell: "c", r: 1, selection_ref: outcomeSel.id, producer: "model-a" })
    expect(fold([answerSel, outcomeSel, answer, self], ["c"], seq, seq)).toEqual([{ cell: "c", alpha: 1, beta: 1 }])
  })

  test("an outcome chosen by the control arm is not counted", () => {
    const ctl = row("outcome", "described", { cell: "c", r: 0, selection_ref: controlSel.id, producer: "model-b" })
    expect(fold([answerSel, controlSel, answer, ctl], ["c"], seq, seq)).toEqual([{ cell: "c", alpha: 1, beta: 1 }])
  })

  test("outcomes after as_of_seq are left out", () => {
    expect(fold([answerSel, outcomeSel, answer, win], ["c"], win.seq - 1, seq)).toEqual([{ cell: "c", alpha: 1, beta: 1 }])
  })

  test("an outcome naming another cell does not move this one", () => {
    expect(fold([answerSel, outcomeSel, answer, win], ["other"], seq, seq)).toEqual([{ cell: "other", alpha: 1, beta: 1 }])
  })

  test("the latest owner prior for the cell replaces Beta(1,1)", () => {
    const prior = row("prior", "owner", { cell: "c", alpha0: 3, beta0: 5 })
    expect(fold([prior, answerSel, outcomeSel, answer, win], ["c"], seq, seq)).toEqual([{ cell: "c", alpha: 4, beta: 5 }])
  })
})
