// SPDX-License-Identifier: MIT
// A root said stalled again and again with nothing changing ends its attempt: the walk writes one row per selection
// whose answer moved nothing (ends: "stall", citing it). The row blames the request, read before any kind, so the one
// debit path (moveFailuresOf) charges that selection's cell once; a selection already charged by its own refusal is not
// charged again. A stall row alone (kind: "stall") still debits no one.
import { describe, expect, test } from "bun:test"
import { blames, foldFrom } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const ANS = "produce/request/ch1|stalled,asker:detector,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = () => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  const produce = () => {
    const s = add(row("selection", "walk", { arm: "treated", cell: ANS, a: "produce/request/ch1", root: "g1" }))
    add(row("request", "described", { selection_ref: s.id, root: "g1" }))
    return s
  }
  // a walk failure stamped as the store stamps it
  const fail = (fields: Record<string, unknown>) => add(row("failure", "walk", { ...fields, blames: blames(fields) }))
  const post = () => foldFrom(rows, [ANS], 1e9, 1e9)[0]
  return { produce, fail, post }
}

describe("a stalled root's attempt ends", () => {
  test("[MUST-FAIL] ends stall blames the request, read before any kind; another ends value does not", () => {
    expect(blames({ ends: "stall", root: "g1", selection_ref: "s" })).toBe("request")
    expect(blames({ ends: "stall", kind: "stall", root: "g1", selection_ref: "s" })).toBe("request")
    expect(blames({ ends: "other", kind: "stall", root: "g1" })).toBe("walk")
    expect(blames({ ends: "Stall", root: "g1" })).toBe("callee")
  })

  test("[MUST-FAIL] an end row adds 1 β to the cell of the selection it cites, one per selection cited", () => {
    const b = build()
    const s1 = b.produce(), s2 = b.produce()
    b.fail({ ends: "stall", root: "g1", selection_ref: s1.id, input_refs: ["g1"] })
    expect(b.post()).toMatchObject({ beta: 2 })
    b.fail({ ends: "stall", root: "g1", selection_ref: s2.id, input_refs: ["g1"] })
    expect(b.post()).toMatchObject({ beta: 3 })
  })

  test("[GUARD] once: a selection already charged by its own refusal is not charged again by its end row", () => {
    const b = build()
    const s = b.produce()
    b.fail({ selection_ref: s.id, status: 422, body: "{}" })
    expect(b.post()).toMatchObject({ beta: 2 })
    b.fail({ ends: "stall", root: "g1", selection_ref: s.id, input_refs: ["g1"] })
    b.fail({ ends: "stall", root: "g1", selection_ref: s.id, input_refs: ["g1"] })
    expect(b.post()).toMatchObject({ beta: 2 })
  })

  test("[GUARD] a stall row alone, and an end row citing no selection, debit no one", () => {
    const b = build()
    const s = b.produce()
    b.fail({ kind: "stall", root: "g1", rows: 240, since_seq: s.seq, input_refs: ["g1"] })
    b.fail({ ends: "stall", root: "g1", input_refs: ["g1"] })
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 })
  })
})
