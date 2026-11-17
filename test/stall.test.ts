// SPDX-License-Identifier: MIT
// A stall row (the walk's: a root with no options while K selections passed) names its root and no selection_ref. It
// is a finding about the root, not a move: it fails no selection and debits no cell, whichever selection the root's
// chain made last.
import { describe, expect, test } from "bun:test"
import { foldFrom, fresh, indexOf } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const CELL = "produce/request/ch1|world_changed,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = (stall: boolean) => {
  seq = 0
  const rows: Row[] = [row("credits", "owner", CREDITS)]
  const root = row("request", "described", { pointer: { type: "some_tool" } })
  rows.push(root)
  const s = row("selection", "walk", { arm: "treated", cell: CELL, a: "produce/request/ch1", root: root.id })
  rows.push(s)
  if (stall) rows.push(row("failure", "walk", { kind: "stall", root: root.id, selections: 60, since_seq: s.seq, input_refs: [root.id] }))
  return rows
}

describe("a stall row", () => {
  test("fails no selection and debits nothing: the root's last move posts as it would without it", () => {
    const rows = build(true)
    expect(indexOf(rows).failed.size).toBe(0)
    expect(fresh.moveFailures(rows, 1e9, 1e9)).toEqual([])
    expect(foldFrom(rows, [CELL], 1e9, 1e9)[0]).toMatchObject(foldFrom(build(false), [CELL], 1e9, 1e9)[0])
    expect(foldFrom(rows, [CELL], 1e9, 1e9)[0]).toMatchObject({ alpha: 1, beta: 1 })
  })
})
