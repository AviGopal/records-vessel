// SPDX-License-Identifier: MIT
// A produce refused only for citing values it was shown (described's context_gap, which the walk lifts from described's
// own refusal) is not charged: no r 0 for the cell that chose it. The refusal still stands: the selection is a failed
// move, uncredited. A refusal citing anything seen nowhere carries no context_gap and is charged as before.
import { describe, expect, test } from "bun:test"
import { fresh, indexOf } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const add = (out: Row[], r: Record<string, unknown>): Row => { const row = { input_refs: [], t: "", ...r, seq: ++seq, id: `x-${seq}` } as Row; out.push(row); return row }
// a treated produce selection, and the walk's failure for its refusal, as calls.ts writes a 422 schema refusal
const refusedProduce = (gap?: unknown) => {
  seq = 0
  const rows: Row[] = []
  const s = add(rows, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: "produce/request|a", a: "produce/request/ch1", pool_refs: [] })
  add(rows, { shape: "failure", role: "walk", writer: "walk", call_id: "c1", selection_ref: s.id, status: 422, refused: "schema",
    body: "{\"failure\":{\"status\":422,\"refused\":\"schema\"}}", input_refs: [s.id], ...(gap === undefined ? {} : { context_gap: gap }) })
  return { rows, s }
}
const charged = (rows: Row[], s: Row) => fresh.moveFailures(rows, seq, seq).filter((g) => g.key === `fail|${s.id}`).map((g) => [g.r, [...g.cells]])

describe("a refusal for citing what the producer was shown is not charged", () => {
  test("[MUST-FAIL] a refusal carrying a context gap charges no one", () => {
    const { rows, s } = refusedProduce([{ value: "86353", seen_in: "x-9" }])
    expect(charged(rows, s)).toEqual([])
  })
  test("a refusal with no context gap is charged to the cell that chose it, as before (a guard)", () => {
    const { rows, s } = refusedProduce()
    expect(charged(rows, s)).toEqual([[0, ["produce/request|a"]]])
  })
  test("an empty or malformed context_gap is no context gap: charged (a guard)", () => {
    for (const gap of [[], "86353", { value: "86353" }, null]) {
      const { rows, s } = refusedProduce(gap)
      expect([JSON.stringify(gap), charged(rows, s)]).toEqual([JSON.stringify(gap), [[0, ["produce/request|a"]]]])
    }
  })
  test("a template run's failure carrying the field is still charged, to its move and to the template's writer (a guard)", () => {
    seq = 0
    const rows: Row[] = []
    const w = add(rows, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: "produce/activity_template|a", a: "produce/activity_template/ch1", pool_refs: [] })
    const tpl = add(rows, { shape: "activity_template", role: "described", writer: "described", selection_ref: w.id, input_refs: [] })
    const s = add(rows, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: `run/${tpl.id}|a`, a: `run/${tpl.id}`, pool_refs: [] })
    add(rows, { shape: "failure", role: "walk", writer: "walk", call_id: "c1", selection_ref: s.id, status: 422, body: "x", input_refs: [s.id],
      context_gap: [{ value: "86353", seen_in: "x-9" }] })
    const keys = fresh.moveFailures(rows, seq, seq).map((g) => [g.key, [...g.cells]])
    expect(keys).toEqual([[`fail|${s.id}`, [`run/${tpl.id}|a`]], [`mint|${s.id}`, ["produce/activity_template|a"]]])
  })
  test("a call's failure carrying the field is still charged, to the produce that wrote its request (a guard)", () => {
    seq = 0
    const rows: Row[] = []
    const p = add(rows, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: "produce/request|a", a: "produce/request/ch1", pool_refs: [] })
    const req = add(rows, { shape: "request", role: "described", writer: "described", selection_ref: p.id, input_refs: [] })
    const s = add(rows, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: "call/fs_edit|a", a: "call/fs_edit", from: req.id, pool_refs: [] })
    add(rows, { shape: "failure", role: "walk", writer: "walk", call_id: "c1", selection_ref: s.id, status: 422, refused: "schema",
      body: "{\"failure\":{\"status\":422,\"refused\":\"schema\"}}", input_refs: [s.id], context_gap: [{ value: "86353", seen_in: "x-9" }] })
    expect(charged(rows, s)).toEqual([[0, ["produce/request|a"]]])
  })
  test("the refusal still stands: a context gap's selection is a failed move, uncredited (a guard)", () => {
    const { rows, s } = refusedProduce([{ value: "86353", seen_in: "x-9" }])
    expect(indexOf(rows).failed.has(s.id)).toBe(true)
  })
})
