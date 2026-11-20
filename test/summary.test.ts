// SPDX-License-Identifier: MIT
// record_summary: what rows of a shape hold, as counts, never the rows (agf_yn70bvzk53ud). A shape of its own, so the
// only read declared to schema-filling callers cannot answer a row whatever it is asked (qa, deployment).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { SERVED_BY_MS, summarize, unheld } from "../src/summary"
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

  test("[MUST-FAIL] a shape no row holds says held: false, and who serves it as a call when asked", async () => {
    const asked: string[] = []
    const s = await unheld(summarize([row("request", {})], "vesselList", ["status"]), async (shape) => { asked.push(shape); return ["discovery-a"] })
    expect(s).toMatchObject({ shape: "vesselList", count: 0, newest_seq: null, held: false, served_by: ["discovery-a"] })
    expect(asked).toEqual(["vesselList"])
  })

  test("[MUST-FAIL] with no one to ask, or no answer, held: false stays and nothing is said of who serves it", async () => {
    const none = summarize([], "vesselList", ["status"])
    for (const producers of [undefined, async () => undefined, async () => { throw new Error("down") }]) {
      const s = await unheld(none, producers)
      expect([s.held, "served_by" in s]).toEqual([false, false])
    }
  })

  test("[MUST-FAIL] who serves it is waited for no longer than the bound", async () => {
    const t0 = performance.now()
    const s = await unheld(summarize([], "vesselList", ["status"]), () => new Promise(() => {}), 50)
    expect(performance.now() - t0).toBeLessThan(1000)
    expect([s.held, "served_by" in s]).toEqual([false, false])
  })

  test("[GUARD] a shape some row holds is answered as before: no held, nobody asked", async () => {
    let asked = 0
    const s = summarize([row("request", { pointer: { type: "fs_read" } })], "request", ["pointer.type"])
    const out = await unheld(s, async () => { asked++; return ["x"] })
    expect(out).toBe(s)
    expect(["held" in out, "served_by" in out, asked]).toEqual([false, false, 0])
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
// what discovery says of shapeProducers: the vessels serving the shape, or (hang) no answer for longer than the bound
let hang = false
const call = async (pointer: object, key = KEY) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { pointer } }),
  })
  return { status: r.status, body: (await r.json()) as any }
}
describe("records serving the summary", () => {
  beforeAll(async () => {
    discovery = fake(async (path, body) => {
      if (path === "/resolve" && body?.pointer?.type === "shapeProducers") {
        if (hang) await Bun.sleep(SERVED_BY_MS + 2500)
        return Response.json({ content: { shape: body.pointer.shape, vesselIds: ["discovery-test"] } })
      }
      return Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true })
    })
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

  test("[MUST-FAIL] a summary call exactly as the walk forwards it (its transport keys included) answers counts (agf_a1p01pv553ex)", async () => {
    const r = await call({ type: "record_summary", shape: "request", summarize: ["pointer.type"], selection_ref: "sel-1", call_id: "c-1", input_refs: ["w1", "x2"] })
    expect(r.status).toBe(200)
    expect(r.body.fields["pointer.type"].top).toEqual([["fs_read", 1]])
  })

  test("[MUST-FAIL] a summary query with any other key is refused, never answered wider than asked (qa)", async () => {
    for (const extra of [{ root: "w1", calls: "all" }, { ids: ["x"] }, { where: { role: "person" } }]) {
      const r = await call({ type: "record_summary", shape: "request", summarize: ["pointer.type"], ...extra })
      expect([r.status, String(r.body.failure?.body)]).toEqual([400, `Error: record_summary takes only shape, summarize and top: not ${Object.keys(extra).join(", ")}`])
    }
  })
  const producersAsked = () => discovery.seen.filter((s) => s.path === "/resolve" && (s.body as any)?.pointer?.type === "shapeProducers").map((s) => (s.body as any).pointer.shape)

  test("[MUST-FAIL] a summary of a shape records holds none of (one discovery serves) says held: false and who serves it", async () => {
    const r = await call({ type: "record_summary", shape: "vesselList", summarize: ["status"] })
    expect(r.status).toBe(200)
    expect(r.body).toMatchObject({ shape: "vesselList", count: 0, newest_seq: null, held: false, served_by: ["discovery-test"] })
    expect(producersAsked()).toContain("vesselList")
  })

  test("[GUARD] a summary of a shape records holds is answered as before: no held, discovery not asked", async () => {
    await call({ type: "record_write", row: { shape: "request", pointer: { type: "fs_read", path: "/y" } }, writer: "walk-test", role: "walk" })
    const r = await call({ type: "record_summary", shape: "request", summarize: ["pointer.type"] })
    expect(r.status).toBe(200)
    expect(["held" in r.body, "served_by" in r.body]).toEqual([false, false])
    expect(producersAsked()).not.toContain("request")
  })

  test("[MUST-FAIL] another key is told held: false alone: who serves it is read under the node key, which sees every org", async () => {
    const before = producersAsked().length
    const r = await call({ type: "record_summary", shape: "shapeProducers", summarize: ["status"] }, "another-key-for-test")
    expect(r.status).toBe(200)
    expect([r.body.held, "served_by" in r.body]).toEqual([false, false])
    expect(producersAsked().length).toBe(before)
  })

  test("[MUST-FAIL] discovery not answering delays the answer no longer than the bound, and held: false still comes", async () => {
    hang = true
    try {
      const t0 = performance.now()
      const r = await call({ type: "record_summary", shape: "vesselHealth", summarize: ["status"] })
      expect(performance.now() - t0).toBeLessThan(SERVED_BY_MS + 1000)
      expect([r.status, r.body.held, "served_by" in r.body]).toEqual([200, false, false])
    } finally { hang = false }
  }, 10_000)
})
