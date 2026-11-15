// SPDX-License-Identifier: MIT
// A template's run that failed is the plan's failure too: r 0 for the selection that wrote the template, every failing
// run (the USER: "a failed run debits the writer"). Never a credit.
import { describe, expect, test } from "bun:test"
import { foldFrom } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const WROTE = "produce/activity_template/ch1|outcome,asker:person,age:0"
const RUN = "run/t|gitWorktree,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = (arm = "treated") => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  const writer = add(row("selection", "walk", { arm, cell: WROTE, root: "w0" }))
  const t = add(row("activity_template", "described", { selection_ref: writer.id, calls: [{ shape: "git_diff", pointer: {} }] }))
  const runOnce = (status?: number) => {
    const s = add(row("selection", "walk", { arm: "treated", cell: RUN, a: `run/${t.id}`, root: "w1" }))
    if (status !== undefined) add(row("failure", "walk", { selection_ref: s.id, call_id: `c${seq}`, status, body: "no commit since the clone was made" }))
  }
  const post = (cell: string) => foldFrom(rows, [cell], 1e9, 1e9)[0]
  return { runOnce, post }
}

describe("a failed run debits the template's writer", () => {
  test("[MUST-FAIL] every failing run is r 0 on the writer's cell, with no dedupe; the run's own cell is debited too, as before", () => {
    const b = build()
    b.runOnce(422)
    expect(b.post(WROTE)).toMatchObject({ alpha: 1, beta: 2 })
    expect(b.post(RUN)).toMatchObject({ alpha: 1, beta: 2 })
    b.runOnce(422)
    expect(b.post(WROTE).beta).toBe(3)
  })

  test("[MUST-FAIL] a run whose failure blames the callee (a 5xx) debits neither; a run that did not fail gives the writer nothing", () => {
    const b = build()
    b.runOnce(500)
    b.runOnce()
    expect(b.post(WROTE)).toMatchObject({ alpha: 1, beta: 1 })
  })

  test("a template no treated selection wrote debits no one", () => {
    const b = build("control")
    b.runOnce(422)
    expect(b.post(WROTE)).toMatchObject({ alpha: 1, beta: 1 })
  })
})
