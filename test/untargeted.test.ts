// SPDX-License-Identifier: MIT
// The exit is counted: of the model's counted grades of 1 on an answer, how many were of a request that named no target,
// while the owner's grader holds grades to targets (its outcome schema's x-reach). Where targets live is the owner's
// schema's word ({from, field}); the request's newest such row at the grade decides.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

describe("grades with no target", () => {
  const build = (opts: { rule?: boolean; targets?: unknown; late?: boolean; none?: boolean }) => {
    seq = 0
    const rows: Row[] = [row("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 })]
    if (opts.rule !== false) rows.push(row("shape_schema", "owner", { target: "outcome", context: ["answer"], schema: { type: "object", "x-reach": { from: "change_wanted", field: "targets" } } }))
    const ask = row("world_changed", "person", { what: "q" })
    const answerSel = row("selection", "walk", { arm: "treated", cell: "c", pool_refs: [ask.id] })
    const outcomeSel = row("selection", "walk", { arm: "treated", cell: "judge" })
    rows.push(ask, answerSel, outcomeSel)
    const cw = () => row("change_wanted", "described", { wanted: false, input_refs: [ask.id], ...(opts.targets !== undefined ? { targets: opts.targets } : {}) })
    if (!opts.late && !opts.none) rows.push(cw())
    const answer = row("answer", "described", { selection_ref: answerSel.id, input_refs: [ask.id] })
    rows.push(answer, row("outcome", "described", { r: 1, event_ref: ask.id, selection_ref: outcomeSel.id, input_refs: [ask.id, answer.id], evidence_refs: [answer.id] }))
    if (opts.late) rows.push(cw())
    return F.tally(rows, seq, seq)
  }
  const target = [{ shape: "uiViewState", where: { region: "landing" } }]

  test("[MUST-FAIL] a counted model grade of 1 on a request with no target is counted as untargeted while the grader holds to targets", () => {
    expect(build({}).untargeted).toBe(1) // its row names none
    expect(build({ targets: [] }).untargeted).toBe(1) // an empty list names none
    expect(build({ none: true }).untargeted).toBe(1) // no such row at all
    expect(build({ targets: target, late: true }).untargeted).toBe(1) // a target named only after the grade
  })

  test("[MUST-FAIL] one with a target, or with no reach rule held by the owner, is not", () => {
    expect(build({ targets: target }).untargeted).toBe(0)
    expect(build({ rule: false }).untargeted).toBe(0)
    expect(build({ targets: target }).counted.answer).toBe(1) // the grade itself still counts as it did
  })
})
