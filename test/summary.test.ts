// SPDX-License-Identifier: MIT
// record_read's summary form: what rows of a shape hold, as counts, never the rows (agf_yn70bvzk53ud).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { summarize } from "../src/summary"
import type { Row } from "../src/store"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

let seq = 0
const row = (shape: string, fields: Record<string, unknown>): Row =>
  ({ shape, id: `r${++seq}`, seq, t: "", writer: "w", role: "walk", input_refs: [], ...fields }) as Row

describe("the summary", () => {
  test("[MUST-FAIL] a nested field (pointer.type) lists the values rows carry; one no row carries is absent", () => {
    const rows = [row("request", { pointer: { type: "fs_read" } }), row("request", { pointer: { type: "fs_edit" } }),
      row("request", { pointer: { type: "fs_read" } }), row("request", { none: "done" }), row("hop", { pointer_type: "git_diff" })]
    const s = summarize(rows, "request", ["pointer.type"])
    expect(s.count).toBe(4)
    expect(s.fields["pointer.type"]).toEqual({ distinct: 2, missing: 1, long: 0, top: [["fs_read", 2], ["fs_edit", 1]] })
    expect(s.fields["pointer.type"]!.top.map(([v]) => v)).not.toContain("test_suite_report")
  })

  test("[MUST-FAIL] a list counts each element, at any step of the path", () => {
    const rows = [row("selection", { input_refs: ["a", "b"] }), row("selection", { input_refs: ["a"] }),
      row("answer", { acts: [{ tool: "git_land" }, { tool: "git_diff" }] })]
    expect(summarize(rows, "selection", ["input_refs"]).fields.input_refs!.top).toEqual([["a", 2], ["b", 1]])
    expect(summarize(rows, "answer", ["acts.tool"]).fields["acts.tool"]!.top).toEqual([["git_diff", 1], ["git_land", 1]])
  })

  test("[MUST-FAIL] text longer than an identifier is counted as long and never shown", () => {
    const words = "my private words about what I want changed in the reports page, please"
    const rows = [row("world_changed", { what: words }), row("world_changed", { what: "short" })]
    const s = summarize(rows, "world_changed", ["what"])
    expect(JSON.stringify(s)).not.toContain("private words")
    expect(s.fields.what).toEqual({ distinct: 1, missing: 0, long: 1, top: [["short", 1]] })
  })

  test("the bounds hold: at most 8 fields and the asked number of top values", () => {
    const rows = Array.from({ length: 30 }, (_, i) => row("hop", { pointer_type: `t${i}` }))
    const s = summarize(rows, "hop", ["pointer_type", ...Array.from({ length: 10 }, (_, i) => `f${i}`)], 3)
    expect([Object.keys(s.fields).length, s.fields.pointer_type!.top.length, s.fields.pointer_type!.distinct]).toEqual([8, 3, 30])
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

  test("[MUST-FAIL] the registration declares record_read's summary form only", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")!.body as any
    expect(reg.shape_inputs.record_read.required).toEqual(["shape", "summarize"])
    expect(Object.keys(reg.shape_inputs)).toEqual(["record_read"])
    expect(typeof reg.shape_descriptions.record_read).toBe("string")
  })

  test("[MUST-FAIL] a summary read answers counts and no row", async () => {
    await call({ type: "record_write", row: { shape: "request", pointer: { type: "fs_read", path: "/x" } }, writer: "walk-test", role: "walk" })
    const r = await call({ type: "record_read", shape: "request", summarize: ["pointer.type", "pointer.path"] })
    expect(r.status).toBe(200)
    expect(Array.isArray(r.body)).toBe(false)
    expect(r.body.fields["pointer.type"].top).toEqual([["fs_read", 1]])
    expect(JSON.stringify(r.body)).not.toContain('"id"')
  })
})
