// SPDX-License-Identifier: MIT
// A failure the walk writes about a root itself (kind stall: the root sat with no move, no selection_ref, citing the
// root) is among that root's rows, through a real records process as the walk reads them (episodes): so it is the
// root's newest row, the walk counts its next K selections from it, and the root's producers are shown it. Another
// root's such row is not this root's. (Written by qa as the leg the hand-built walk test could not be.)
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"
const OPERATOR_KEY = "operator-key-for-test"
const UNMARKED_KEY = "unmarked-key-for-test"
const WALK = "walk-test"
const walk = { writer: WALK, role: "walk" }
const desc = { writer: "described-test", role: "described" }
const owner = { writer: "owner", role: "owner" }

let stop: () => void = () => {}
afterEach(() => stop())

// One records process on a fresh store per test: the episode depends on every row.
const fresh = async () => {
  const discovery: Fake = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
  const identity: Fake = fake((_p, body) => body?.impulse?.pointer?.apiKey === PERSON_KEY
    ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-person", ownerKind: "person" } })
    : body?.impulse?.pointer?.apiKey === OPERATOR_KEY
      ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-operator", ownerKind: "operator" } })
      : body?.impulse?.pointer?.apiKey === UNMARKED_KEY
        ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-unmarked", ownerKind: "unclassified" } })
        : Response.json({ success: false }, { status: 401 }))
  const dir = mkdtempSync(join(tmpdir(), "records-episode-"))
  const port = freePort()
  const vessel = run("src/index.ts", {
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: String(port), DISCOVERY_URL: discovery.url,
    RECORDS_ENDPOINT: `http://127.0.0.1:${port}`, RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: identity.url, METABOB_API_KEY: NODE_KEY,
  })
  stop = () => { vessel.kill(); discovery.stop(); identity.stop(); rmSync(dir, { recursive: true, force: true }) }
  await healthy(port)
  await until(() => discovery.seen.some((s) => s.path === "/register"), "/register")
  const call = async (key: string, pointer: object) => {
    const r = await fetch(`http://127.0.0.1:${port}/v2/impulses/resolve`, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `ApiKey ${key}` }, body: JSON.stringify({ impulse: { pointer } }),
    })
    return (await r.json()) as any
  }
  const write = (key: string, row: object, as?: { writer: string; role: string }) => call(key, { type: "record_write", row, ...(as ?? {}) })
  const episode = async (): Promise<string[]> => ((await call(NODE_KEY, { type: "record_read", episode: WALK })) as Array<{ id: string }>).map((r) => r.id)
  const episodes = async () => (await call(NODE_KEY, { type: "record_read", episode: WALK, roots: "all" })) as
    { shared: Array<{ id: string }>; roots: Array<{ root: { id: string }; rows: Array<{ id: string }> }> }
  const lapsed = async (more: Record<string, unknown> = {}): Promise<string[]> =>
    ((await call(NODE_KEY, { type: "record_lapsed", deadline_shape: "due", answer_shape: "answer", ...more })) as Array<{ id: string }>).map((r) => r.id)
  const ask = (what: string) => write(PERSON_KEY, { shape: "world_changed", what })
  const arm = () => write(NODE_KEY, { shape: "arm", vessel_id: WALK, arm: "treated" }, owner)
  const select = (root: string) => write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c", pool_refs: [root], input_refs: [root] }, walk)
  return { write, episode, episodes, lapsed, ask, arm, select, call }
}

describe("qa: a stall row in the root's episode", () => {
  test("[MUST-FAIL] the stall row as the walk writes it (no selection_ref) is among its root's rows", async () => {
    const r = await fresh()
    await r.arm()
    const ask = await r.ask("make a change")
    await r.select(ask.id)
    const st = await r.write(NODE_KEY, { shape: "failure", kind: "stall", root: ask.id, selections: 60, since_seq: 3, input_refs: [ask.id] }, walk)
    expect(st.id).toBeDefined()
    const all = await r.episodes()
    const mine = all.roots.find((x) => x.root.id === ask.id)
    expect(mine?.rows.map((x) => x.id)).toContain(st.id)
  })

  test("[MUST-FAIL] another root's stall row is not this root's", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("make a change")
    const b = await r.ask("make another change")
    await r.select(a.id)
    await r.select(b.id)
    const st = await r.write(NODE_KEY, { shape: "failure", kind: "stall", root: b.id, selections: 60, since_seq: 4, input_refs: [b.id] }, walk)
    const all = await r.episodes()
    expect(all.roots.find((x) => x.root.id === a.id)?.rows.map((x) => x.id)).not.toContain(st.id)
    expect(all.roots.find((x) => x.root.id === b.id)?.rows.map((x) => x.id)).toContain(st.id)
  })
})

describe("a held request's skip row on a root with no move, in the root's episode", () => {
  // The walk writes it for a root that offered no move this tick: no selection_ref, citing the root and the held request.
  // In the root's rows it is the root's newest row, so the walk's next ticks read it as said (written once per reason), and
  // the root's producers are handed it with the root's other rows.
  test("is among its root's rows, and not another root's", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("make a change")
    const b = await r.ask("make another change")
    const sa = await r.select(a.id)
    await r.select(b.id)
    const req = await r.write(NODE_KEY, { shape: "request", pointer: { type: "git_land" }, selection_ref: sa.id, input_refs: [a.id] }, desc)
    expect(req.id).toBeDefined()
    const skip = await r.write(NODE_KEY, { shape: "failure", kind: "skip", request_ref: req.id, unserved: ["git_land (requires land_verdict)"],
      input_refs: [a.id, req.id] }, walk)
    expect(skip.id).toBeDefined()
    const all = await r.episodes()
    const rowsOf = (id: string) => all.roots.find((x) => x.root.id === id)?.rows.map((x) => x.id) ?? []
    expect(rowsOf(a.id)).toContain(skip.id)
    expect(rowsOf(a.id)).toContain(req.id)
    expect(rowsOf(b.id)).not.toContain(skip.id)
  })
})
