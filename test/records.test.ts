// SPDX-License-Identifier: MIT
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, exitsNaming, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"

let discovery: Fake
let identity: Fake
let dir: string
let port: number
let vessel: ReturnType<typeof run>

const env = (): Record<string, string> => ({
  RECORDS_VESSEL_ID: "records-test",
  RECORDS_PORT: String(port),
  DISCOVERY_URL: discovery.url,
  RECORDS_ENDPOINT: `http://127.0.0.1:${port}`,
  RECORDS_DATA_DIR: dir,
  IDENTITY_VESSEL_URL: identity.url,
  METABOB_API_KEY: NODE_KEY,
})

const call = async (key: string, pointer: object) => {
  const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` },
    body: JSON.stringify({ impulse: { pointer } }),
  })
  return { status: r.status, body: (await r.json()) as any }
}

const write = (key: string, row: object, as?: { writer: string; role: string }) =>
  call(key, { type: "record_write", row, ...(as ?? {}) })

beforeAll(async () => {
  discovery = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
  identity = fake((_path, body) =>
    body?.impulse?.pointer?.apiKey === PERSON_KEY
      ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-person" } })
      : Response.json({ success: false }, { status: 401 }))
  dir = mkdtempSync(join(tmpdir(), "records-test-"))
  port = freePort()
  vessel = run("src/index.ts", env())
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
})

afterAll(() => {
  vessel?.kill()
  discovery?.stop()
  identity?.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe("records vessel", () => {
  test("/health answers 200 with the vessel id only", async () => {
    const r = await fetch(`http://127.0.0.1:${port}/health`)
    expect(r.status).toBe(200)
    expect(await r.json()).toEqual({ vessel: "records-test" })
  })

  test("registers its shapes with discovery under the node key, with no forward time limit", () => {
    const reg = discovery.seen.find((s) => s.path === "/register")
    expect(reg?.auth).toBe(`ApiKey ${NODE_KEY}`)
    const body = reg?.body as { shapes: string[]; resolve_timeout_ms: number; endpoint: string }
    expect(body.shapes).toEqual(expect.arrayContaining(["record_write", "record_read", "record_wait", "posterior"]))
    expect(body.resolve_timeout_ms).toBe(2147483647)
  })

  test("node-self writes under the writer and role it declares, without asking identity", async () => {
    const before = identity.seen.length
    const r = await write(NODE_KEY, { shape: "note", text: "a" }, { writer: "walk-test", role: "walk" })
    expect(r.status).toBe(200)
    expect(r.body.writer).toBe("walk-test")
    expect(r.body.role).toBe("walk")
    expect(identity.seen.length).toBe(before)
  })

  test("node-self must declare writer and role", async () => {
    expect((await write(NODE_KEY, { shape: "note" })).status).toBe(400)
  })

  test("another key is validated by identity and written as a person under its key id", async () => {
    const r = await write(PERSON_KEY, { shape: "note", text: "b" }, { writer: "walk-test", role: "owner" })
    expect(r.status).toBe(200)
    expect(r.body.writer).toBe("kid-person")
    expect(r.body.role).toBe("person")
  })

  test("a key identity rejects gets 401", async () => {
    expect((await write("not-a-key", { shape: "note" })).status).toBe(401)
  })

  test("owner shapes take owner rows only", async () => {
    expect((await write(PERSON_KEY, { shape: "channel", calls: [] })).status).toBe(403)
    expect((await write(NODE_KEY, { shape: "channel", calls: [] }, { writer: "walk-test", role: "walk" })).status).toBe(403)
    expect((await write(NODE_KEY, { shape: "channel", calls: [] }, { writer: "owner", role: "owner" })).status).toBe(200)
  })

  test("a described row must cite an existing selection", async () => {
    const as = { writer: "described-test", role: "described" }
    expect((await write(NODE_KEY, { shape: "answer", selection_ref: "missing" }, as)).status).toBe(403)
    const sel = await write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c" }, { writer: "walk-test", role: "walk" })
    expect((await write(NODE_KEY, { shape: "answer", selection_ref: sel.body.id }, as)).status).toBe(200)
  })

  test("rows are appended to the data dir and read back in seq order", async () => {
    const lines = readFileSync(join(dir, "rows"), "utf-8").trim().split("\n").map((l) => JSON.parse(l))
    expect(lines.length).toBeGreaterThan(0)
    const read = await call(NODE_KEY, { type: "record_read", shape: "note" })
    expect(read.status).toBe(200)
    const seqs = (read.body as Array<{ seq: number }>).map((r) => r.seq)
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b))
  })

  test("record_lapsed lists a past deadline whose request has no answer and no grade", async () => {
    const walk = { writer: "walk-test", role: "walk" }
    const desc = { writer: "described-test", role: "described" }
    const ask = (await write(PERSON_KEY, { shape: "world_changed", what: "q" })).body
    const ask2 = (await write(PERSON_KEY, { shape: "world_changed", what: "q2" })).body
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c" }, walk)).body
    const due = (within_ms: number, req: string) => write(NODE_KEY, { shape: "due", within_ms, selection_ref: sel.id, input_refs: [req] }, desc)
    const lapsedDue = (await due(1, ask.id)).body
    await due(3_600_000, ask.id)
    const answeredDue = (await due(1, ask2.id)).body
    await write(NODE_KEY, { shape: "answer", text: "a", selection_ref: sel.id, input_refs: [ask2.id] }, desc)
    const gradedDue = (await due(1, ask.id)).body
    await write(PERSON_KEY, { shape: "world_changed", what: "guessed" })
    await write(NODE_KEY, { shape: "due", at: Date.now() - 86_400_000, selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await Bun.sleep(20)
    await write(NODE_KEY, { shape: "outcome", r: 0, selection_ref: sel.id, input_refs: [ask.id, gradedDue.id], evidence_refs: [gradedDue.id] }, desc)
    const got = await call(NODE_KEY, { type: "record_lapsed", deadline_shape: "due", answer_shape: "answer" })
    expect(got.status).toBe(200)
    expect((got.body as Array<{ id: string }>).map((r) => r.id)).toEqual([lapsedDue.id])
    expect(answeredDue.id).toBeDefined()
    expect((await call(NODE_KEY, { type: "record_lapsed" })).status).toBe(400)
  })

  test("a grade written before the deadline does not hide the lapse", async () => {
    const walk = { writer: "walk-test", role: "walk" }
    const desc = { writer: "described-test", role: "described" }
    const ask = (await write(PERSON_KEY, { shape: "world_changed", what: "q3" })).body
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c" }, walk)).body
    const soon = (await write(NODE_KEY, { shape: "due", within_ms: 1500, selection_ref: sel.id, input_refs: [ask.id] }, desc)).body
    await write(NODE_KEY, { shape: "outcome", r: 0, selection_ref: sel.id, input_refs: [ask.id, soon.id], evidence_refs: [soon.id] }, desc)
    await Bun.sleep(2000)
    const got = await call(NODE_KEY, { type: "record_lapsed", deadline_shape: "due", answer_shape: "answer" })
    expect((got.body as Array<{ id: string }>).map((r) => r.id)).toContain(soon.id)
  })

  test("a late grade the fold refuses (r 1 on a deadline) does not hide the lapse", async () => {
    const desc = { writer: "described-test", role: "described" }
    const ask = (await write(PERSON_KEY, { shape: "world_changed", what: "q4" })).body
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c" }, { writer: "walk-test", role: "walk" })).body
    const d = (await write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: sel.id, input_refs: [ask.id] }, desc)).body
    await Bun.sleep(20)
    await write(NODE_KEY, { shape: "outcome", r: 1, selection_ref: sel.id, input_refs: [ask.id, d.id], evidence_refs: [d.id] }, desc)
    const got = await call(NODE_KEY, { type: "record_lapsed", deadline_shape: "due", answer_shape: "answer" })
    expect((got.body as Array<{ id: string }>).map((r) => r.id)).toContain(d.id)
  })

  test("a row's deadline comes from records' clock and its within_ms, never from the writer", async () => {
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c" }, { writer: "walk-test", role: "walk" })).body
    const before = Date.now()
    const due = (await write(NODE_KEY, { shape: "due", within_ms: 600_000, at: 1, selection_ref: sel.id }, { writer: "described-test", role: "described" })).body
    expect(due.at).toBe(Date.parse(due.t) + 600_000)
    expect(due.at).toBeGreaterThanOrEqual(before + 600_000)
  })

  test("registers record_lapsed as a shape it serves", () => {
    const body = discovery.seen.find((s) => s.path === "/register")?.body as { shapes: string[] }
    expect(body.shapes).toContain("record_lapsed")
  })

  test("a missing boot value exits 1 and names it, never its value", async () => {
    const { METABOB_API_KEY: _, ...rest } = env()
    const { code, stderr } = await exitsNaming("src/index.ts", { ...rest, RECORDS_PORT: String(freePort()) })
    expect(code).toBe(1)
    expect(stderr).toContain("missing env METABOB_API_KEY")
    expect(stderr).not.toContain(NODE_KEY)
  })
})
