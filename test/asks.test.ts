// SPDX-License-Identifier: MIT
// WHAT AN ASK IS (the USER, 11-17: "Approve"): once the owner's request schema declares the input it answers (ask: true),
// a root is a person's, owner's or operator's row of that shape, and every other owner row is configuration the walk is
// given (episodes().shared). Until then, today's rule. Through a real records process, as the walk reads it.
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
  const dir = mkdtempSync(join(tmpdir(), "records-asks-"))
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

// The owner's schema that declares what an ask is: the request answers a world_changed (inputs entry ask: true).
const ASK_MARK = { shape: "shape_schema", target: "request", inputs: [{ shape: "world_changed", ask: true }] }
const ids = (xs: Array<{ id: string }> | undefined) => (xs ?? []).map((x) => x.id)

describe("what an ask is, as the owner declares it", () => {
  test("[MUST-FAIL] once asks are declared, an owner setting of any shape opens no root and reaches the walk as shared", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, ASK_MARK, owner)
    const rule = await r.write(NODE_KEY, { shape: "stall_rule", after_rows: 240 }, owner)
    const seeded = await r.write(NODE_KEY, { shape: "owner_seeded", what: "a marker the seeder wrote" }, owner)
    const all = await r.episodes()
    const roots = all.roots.map((x) => x.root.id)
    expect(roots).not.toContain(rule.id)
    expect(roots).not.toContain(seeded.id) // the phantom ask: a setting, not work
    expect(ids(all.shared)).toContain(rule.id) // the walk reads its stall rule from here
    expect(ids(all.shared)).toContain(seeded.id)
  })

  test("[MUST-FAIL] an owner's world_changed is an ask: a root, and not shared with every other root", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, ASK_MARK, owner)
    const ask = await r.write(NODE_KEY, { shape: "world_changed", what: "a goal from the owner" }, owner)
    const person = await r.ask("a person's ask")
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual(expect.arrayContaining([ask.id, person.id]))
    expect(ids(all.shared)).not.toContain(ask.id)
    expect(ids(all.shared)).not.toContain(person.id)
  })

  test("[MUST-FAIL] a person's outcome is neither a root nor shared", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, ASK_MARK, owner)
    const person = await r.ask("a person's ask")
    const mark = await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [person.id] })
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).not.toContain(mark.id)
    expect(ids(all.shared)).not.toContain(mark.id)
  })

  test("[MUST-FAIL] with no ask declared, episodes() is exactly today's: the same roots and the same shared rows, row for row", async () => {
    // Every kind of row the live store holds, with no ask mark: today's rule makes any exogenous row of an unlisted shape a
    // root (the phantom), and shares only channels, schemas, requires, repositories and rhythms.
    const r = await fresh()
    await r.arm()
    const ch = await r.write(NODE_KEY, { shape: "channel", calls: [] }, owner)
    const schema = await r.write(NODE_KEY, { shape: "shape_schema", target: "request", inputs: ["world_changed"] }, owner)
    const req = await r.write(NODE_KEY, { shape: "requires", for: "x", needs: "y" }, owner)
    const repo = await r.write(NODE_KEY, { shape: "repository", repo: "r" }, owner)
    const credits = await r.write(NODE_KEY, { shape: "credits", target: "selection" }, owner)
    const desc = await r.write(NODE_KEY, { shape: "shape_description", of: "gap" }, owner)
    const seeded = await r.write(NODE_KEY, { shape: "owner_seeded", what: "a marker" }, owner)
    const goal = await r.write(NODE_KEY, { shape: "world_changed", what: "a goal from the owner" }, owner)
    const person = await r.ask("a person's ask")
    const mark = await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [person.id] })
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id).sort()).toEqual([seeded.id, goal.id, person.id].sort())
    expect(ids(all.shared).sort()).toEqual([ch.id, schema.id, req.id, repo.id].sort())
    expect([credits.id, desc.id, mark.id].filter((id) => ids(all.shared).includes(id))).toEqual([])
  })
})
