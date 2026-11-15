// SPDX-License-Identifier: MIT
// The owner marks a span of the store as an outage (the USER: "Owner row marks window"). A walk failure inside the span,
// of a status the row names, debits no one; anything else counts as before: a status it does not name (a real refusal in
// the same span), a failure outside it, a retracted window, or a row not the owner's.
import { describe, expect, test } from "bun:test"
import { foldFrom } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const REQ = "produce/request/ch1|world_changed,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }

const build = () => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  const wrote = add(row("selection", "walk", { arm: "treated", cell: REQ, a: "produce/request/ch1", root: "w1" }))
  const req = add(row("request", "described", { selection_ref: wrote.id, pointer: { type: "some_tool" } }))
  const callFails = (status: number) => {
    const s = add(row("selection", "walk", { arm: "treated", cell: "call/some_tool|x", a: "call/some_tool", from: req.id, root: "w1" }))
    return add(row("failure", "walk", { selection_ref: s.id, call_id: `c${seq}`, status, body: "{}" })).seq
  }
  const mark = (role: string, fields: Record<string, unknown>) => add(row("infra_window", role, { reason: "provider credit outage", ...fields }))
  const beta = () => foldFrom(rows, [REQ], 1e9, 1e9)[0].beta
  return { callFails, mark, beta, at: () => seq }
}

describe("an owner-marked infra window", () => {
  test("[MUST-FAIL] a failure inside the window, of a status it names, debits no one; outside it, the same failure does", () => {
    const b = build()
    const first = b.callFails(404)
    const second = b.callFails(404)
    b.callFails(404) // after the window
    b.mark("owner", { window_id: "w-1", from_seq: first, to_seq: second, statuses: [404] })
    expect(b.beta()).toBe(2) // 1 prior + only the one outside
  })

  test("[MUST-FAIL] a real refusal in the span (a status the row does not name) still counts", () => {
    const b = build()
    const a = b.callFails(404)
    const c = b.callFails(422)
    b.mark("owner", { window_id: "w-1", from_seq: a, to_seq: c, statuses: [404, 402] })
    expect(b.beta()).toBe(2)
  })

  test("a retracted window, a row missing a field, and a row not the owner's change nothing", () => {
    const b = build()
    const a = b.callFails(404)
    b.mark("owner", { window_id: "w-1", from_seq: a, to_seq: a, statuses: [404] })
    b.mark("owner", { window_id: "w-1", retracted: true })
    b.mark("owner", { window_id: "w-2", from_seq: a, to_seq: a }) // no statuses
    b.mark("walk", { window_id: "w-3", from_seq: a, to_seq: a, statuses: [404] })
    expect(b.beta()).toBe(2)
  })
})

test("[MUST-FAIL] only the owner may write an infra window", async () => {
  const { mkdtempSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = join(mkdtempSync(join(tmpdir(), "rec-iw-")), "records-vessel")
  const p = Bun.spawnSync(["bun", "-e", `const s = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))}); const r = s.write({ shape: "infra_window", from_seq: 1, to_seq: 2, statuses: [404], input_refs: [] }, "walk-x", "walk"); console.log(JSON.stringify(r.status))`], {
    env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root", RECORDS_VESSEL_ID: "r", RECORDS_PORT: "1", DISCOVERY_URL: "http://d.test",
      RECORDS_ENDPOINT: "http://r.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://i.test", METABOB_API_KEY: "k" },
  })
  expect(p.stdout.toString().trim()).toBe("403")
})
