// SPDX-License-Identifier: MIT
// A plan a request cannot fill failed as written: r 0 for the selection that wrote the template, once per request,
// template and placeholder (the USER: "Debit the writer once"). The rows are the shapes the walk and described-shape write.
import { describe, expect, test } from "bun:test"
import { foldFrom } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

const WROTE = "produce/activity_template/ch1|outcome,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = () => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  const writer = add(row("selection", "walk", { arm: "treated", cell: WROTE, a: "produce/activity_template/ch1", root: "w0" }))
  const t = add(row("activity_template", "described", { selection_ref: writer.id, calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } }] }))
  // a selection of request `root` carrying the walk's row about the template
  const said = (root: string, fields: Record<string, unknown>) => {
    const s = add(row("selection", "walk", { arm: "treated", cell: "produce/answer/ch1|world_changed,asker:person,age:0", root }))
    add(row("failure", "walk", { selection_ref: s.id, template_ref: t.id, ...fields }))
  }
  const post = () => foldFrom(rows, [WROTE], 1e9, 1e9)[0]
  return { rows, add, t, writer, said, post }
}
const SKIP = { kind: "skip", unserved: ["unbound {{ sig.in[0].cwd }}: this request has no such field"], unbound: ["sig.in[0].cwd"] }

describe("an unfillable plan debits its writer", () => {
  test("[MUST-FAIL] a skip naming an unbound placeholder is r 0 on the writer's cell", () => {
    const b = build()
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 })
    b.said("w1", SKIP)
    expect(b.post()).toMatchObject({ alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] once per request, template and placeholder: the same hole again in the same request counts nothing; another request counts", () => {
    const b = build()
    b.said("w1", SKIP); b.said("w1", SKIP)
    b.said("w1", { kind: "unbound", unbound: ["sig.in[0].cwd"] })
    expect(b.post().beta).toBe(2)
    b.said("w2", SKIP)
    expect(b.post().beta).toBe(3)
    b.said("w2", { kind: "unbound", unbound: ["calls.0.output.cwd"] }) // another placeholder of the same template
    expect(b.post().beta).toBe(4)
  })

  test("[MUST-FAIL] a run stopped at an unfilled placeholder (kind unbound) counts the same way", () => {
    const b = build()
    b.said("w1", { kind: "unbound", unbound: ["calls.0.output.cwd"] })
    expect(b.post().beta).toBe(2)
  })

  test("a skip for another reason (a shape nothing serves) debits no one, as before", () => {
    const b = build()
    b.said("w1", { kind: "skip", unserved: ["hop"] })
    expect(b.post().beta).toBe(1)
  })

  test("a row not written by the walk, or a template no treated selection wrote, debits no one", () => {
    const b = build()
    const s = b.add(row("selection", "walk", { arm: "treated", cell: "x", root: "w1" }))
    b.add(row("failure", "described", { selection_ref: s.id, template_ref: b.t.id, ...SKIP }))
    b.add(row("failure", "described", { writer: "walk", selection_ref: s.id, template_ref: b.t.id, ...SKIP })) // the walk's name, not its role
    const orphan = b.add(row("activity_template", "described", { calls: [] }))
    b.add(row("failure", "walk", { selection_ref: s.id, template_ref: orphan.id, ...SKIP }))
    expect(b.post().beta).toBe(1)
  })
})
