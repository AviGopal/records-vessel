// SPDX-License-Identifier: MIT
// record_summary: what rows of a shape hold, as counts, never the rows (agf_yn70bvzk53ud). A shape of its own, so the
// only read declared to schema-filling callers cannot answer a row whatever it is asked (qa, deployment).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summarize } from "../src/summary"
import type { Row } from "../src/store"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

let seq = 0
const row = (shape: string, fields: Record<string, unknown>, role = "walk"): Row =>
  ({ shape, id: `r${++seq}`, seq, t: "", writer: "w", role, input_refs: [], ...fields }) as Row

describe("the summary", () => {
  test("[MUST-FAIL] a nested field (pointer.type) lists the values rows carry; one no row carries is absent", () => {
    const rows = [row("request", { pointer: { type: "fs_read" } }), row("request", { pointer: { type: "fs_edit" } }),
      row("request", { pointer: { type: "fs_read" } }), row("request", { none: "done" }), row("hop", { pointer_type: "git_diff" })]
    const s = summarize(rows, "request", ["pointer.type"])
    expect(s.count).toBe(4)
    expect(s.fields["pointer.type"]).toEqual({ distinct: 2, missing: 1, long: 0, withheld: 0, top: [["fs_read", 2], ["fs_edit", 1]] })
    expect((s.fields["pointer.type"] as { top: Array<[string, number]> }).top.map(([v]) => v)).not.toContain("test_suite_report")
  })

  test("[MUST-FAIL] a list counts each element, at any step of the path", () => {
    const rows = [row("selection", { input_refs: ["a", "b"] }), row("selection", { input_refs: ["a"] }),
      row("answer", { acts: [{ tool: "git_land" }, { tool: "git_diff" }] })]
    expect(summarize(rows, "selection", ["input_refs"]).fields.input_refs).toMatchObject({ top: [["a", 2], ["b", 1]] })
    expect(summarize(rows, "answer", ["acts.tool"]).fields["acts.tool"]).toMatchObject({ top: [["git_diff", 1], ["git_land", 1]] })
  })

  test("[MUST-FAIL] text longer than an identifier is counted as long and never shown", () => {
    const words = "my private words about what I want changed in the reports page, please"
    const rows = [row("world_changed", { what: words }), row("world_changed", { what: "short" })]
    const s = summarize(rows, "world_changed", ["what"])
    expect(JSON.stringify(s)).not.toContain("private words")
    expect(s.fields.what).toEqual({ distinct: 1, missing: 0, long: 1, withheld: 0, top: [["short", 1]] })
  })

  test("[MUST-FAIL] a person's row shows no value, however short; the same value on a producer's row is shown (qa)", () => {
    const rows = [row("outcome", { note: "Wrong" }, "person"), row("outcome", { note: "Wrong" }, "described"), row("outcome", { note: "Right" }, "owner")]
    expect(summarize(rows, "outcome", ["note"]).fields.note).toEqual({ distinct: 1, missing: 0, long: 0, withheld: 2, top: [["Wrong", 1]] })
  })

  test("[MUST-FAIL] who wrote a row, and key-like fields, are never summarized (qa)", () => {
    const rows = [row("answer", { writer: "kid-person", by_key: "k1", api_key: "x" })]
    const s = summarize(rows, "answer", ["writer", "by_key", "meta.api_key"])
    expect(Object.values(s.fields).every((f) => "refused" in f)).toBe(true)
    expect(JSON.stringify(s)).not.toContain("kid-person")
  })

  test("two paths sharing a long prefix are two fields", () => {
    const p = "a".repeat(45)
    const s = summarize([row("x", { [p]: { b: 1, c: 2 } })], "x", [`${p}.b`, `${p}.c`])
    expect(Object.keys(s.fields).length).toBe(2)
  })

  test("[MUST-FAIL] top is capped at the declared maximum (deployment)", () => {
    const rows = Array.from({ length: 60 }, (_, i) => row("hop", { pointer_type: `t${i}` }))
    expect(summarize(rows, "hop", ["pointer_type"], 50).fields.pointer_type).toMatchObject({ distinct: 60 })
    expect((summarize(rows, "hop", ["pointer_type"], 50).fields.pointer_type as { top: unknown[] }).top.length).toBe(20)
  })

  test("the bounds hold: at most 8 fields and the asked number of top values", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row("hop", { pointer_type: `t${i}` }))
    const s = summarize(rows, "hop", ["pointer_type", ...Array.from({ length: 10 }, (_, i) => `f${i}`)], 3)
    const pt = s.fields.pointer_type as { top: unknown[]; distinct: number }
    expect([Object.keys(s.fields).length, pt.top.length, pt.distinct]).toEqual([8, 3, 30])
  })
})

// Through the vessel: the declared form reaches discovery, and a summary read answers counts, not rows.
let discovery: Fake
let identity: Fake
let dir: string
let port: number
let vessel: ReturnType<typeof run>
const KEY = "node-key-for-test"
const call = async (pointer: object) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${KEY}` },
    body: JSON.stringify({ impulse: { pointer } }),
  })
  return { status: r.status, body: (await r.json()) as any }
}
describe("records serving the summary", () => {
  beforeAll(async () => {
    discovery = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
    identity = fake(() => Response.json({ success: true, data: { authenticated: true, keyId: "kid-node" } }))
    dir = mkdtempSync(join(tmpdir(), "records-summary-"))
    port = freePort()
    vessel = run("src/index.ts", {
      RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
      RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: KEY,
    })
    await healthy(port)
    await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
  })
  afterAll(() => { vessel?.kill(); discovery?.stop(); identity?.stop(); rmSync(dir, { recursive: true, force: true }) })

  test("[MUST-FAIL] the registration declares record_summary only: record_read is served but never declared", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")!.body as any
    expect(reg.shapes).toEqual(expect.arrayContaining(["record_read", "record_summary"]))
    expect(Object.keys(reg.shape_inputs)).toEqual(["record_summary"])
    expect(reg.shape_inputs.record_summary.required).toEqual(["shape", "summarize"])
    expect(Object.keys(reg.shape_descriptions)).toEqual(["record_summary"])
  })

  test("[MUST-FAIL] a summary read answers counts and no row", async () => {
    await call({ type: "record_write", row: { shape: "request", pointer: { type: "fs_read", path: "/x" } }, writer: "walk-test", role: "walk" })
    const r = await call({ type: "record_summary", shape: "request", summarize: ["pointer.type", "pointer.path"] })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(false)
    expect(r.body.fields["pointer.type"].top).toEqual([["fs_read", 1]])
    expect(JSON.stringify(r.body)).not.toContain('"id"')
  })

  test("[MUST-FAIL] a summary query with any other key is refused, never answered wider than asked (qa)", async () => {
    for (const extra of [{ root: "w1", calls: "all" }, { ids: ["x"] }, { where: { role: "person" } }]) {
      const r = await call({ type: "record_summary", shape: "request", summarize: ["pointer.type"], ...extra })
      expect([r.status, String(r.body.failure?.body)]).toEqual([400, `Error: record_summary takes only shape, summarize and top: not ${Object.keys(extra).join(", ")}`])
    }
  })
})
