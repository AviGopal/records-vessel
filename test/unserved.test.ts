// SPDX-License-Identifier: MIT
// A call that never reached a producer (unserved: the shape, a field on the failure row) is the callee's: no producer
// and none of the chain is debited, whatever its status, a routed 404 included (qa: a call to a cooled model adds 0 β to
// the requesting cell). A producer's own 404, with no such field, still blames the request.
import { describe, expect, test } from "bun:test"
import { blames, foldFrom } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const REQ = "produce/request/ch1|world_changed,asker:person,age:0"
const ANS = "produce/answer/ch1|world_changed,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = () => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  // a request written by a produce, and the call made for it
  const wrote = add(row("selection", "walk", { arm: "treated", cell: REQ, a: "produce/request/ch1", root: "w1" }))
  const req = add(row("request", "described", { selection_ref: wrote.id, pointer: { type: "some_tool" } }))
  const callFails = (fields: Record<string, unknown>) => {
    const s = add(row("selection", "walk", { arm: "treated", cell: "call/some_tool|x", a: "call/some_tool", from: req.id, root: "w1" }))
    add(row("failure", "walk", { selection_ref: s.id, call_id: `c${seq}`, ...fields }))
  }
  const produceFails = (fields: Record<string, unknown>) => {
    const s = add(row("selection", "walk", { arm: "treated", cell: ANS, a: "produce/answer/ch1", root: "w1" }))
    add(row("failure", "walk", { selection_ref: s.id, call_id: `c${seq}`, ...fields }))
  }
  const post = (cell: string) => foldFrom(rows, [cell], 1e9, 1e9)[0]
  return { callFails, produceFails, post }
}

describe("a call nothing answered", () => {
  test("[MUST-FAIL] unserved blames the callee, whatever the status; without it a 404 blames the request", () => {
    expect(blames({ status: 404, body: "{}", unserved: "some_tool" })).toBe("callee")
    expect(blames({ status: 200, body: "{}", unserved: "llm_completion" })).toBe("callee")
    expect(blames({ status: 404, body: "{}" })).toBe("request")
    expect(blames({ status: 404, body: "{}", unserved: "" })).toBe("request")
  })

  test("[MUST-FAIL] a routed 404 for the request's call adds 0 β to the cell that wrote the request; a producer's 404 adds 1", () => {
    const b = build()
    b.callFails({ status: 404, body: "{}", unserved: "some_tool" })
    expect(b.post(REQ)).toMatchObject({ alpha: 1, beta: 1 })
    b.callFails({ status: 404, body: "{}" })
    expect(b.post(REQ)).toMatchObject({ alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] a produce whose model call was unserved (a cooled model, a dark plane) adds 0 β to its own cell", () => {
    const b = build()
    b.produceFails({ status: 502, body: "{}", unserved: "llm_completion" })
    b.produceFails({ status: 404, body: "{}", unserved: "llm_completion" })
    expect(b.post(ANS)).toMatchObject({ alpha: 1, beta: 1 })
  })

  test("a row already stamped by the store keeps its stamp (the fold reads the stamp first)", () => {
    const b = build()
    b.callFails({ status: 404, body: "{}", blames: "request" })
    expect(b.post(REQ).beta).toBe(2)
  })
})
