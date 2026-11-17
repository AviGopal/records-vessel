// SPDX-License-Identifier: MIT
// Who is waiting on a person now (the person-waits ruling): record_read {shape: "person_wait"} answers one derived row per
// root whose latest walk failure saying waits_for person has had no person row about the root since, by the fold's own
// person-wait reading, through a real records process. A person row about the root after the wait ends it, read the
// fold's way (a row citing the root, or citing a row that cites it); one about another root, or before the wait, does
// not. A stored person_wait is refused. Rows in the forms the walk, described and a person's key write them.
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
  const waits = async () => (await call(NODE_KEY, { type: "record_read", shape: "person_wait" })) as Array<Record<string, unknown>>
  // an ask, and a git_land call made for it that waits on a person: its selection names the root, its failure cites the
  // selection (failure -> selection -> root), as the walk writes them
  const ask = async (what: string) => (await write(PERSON_KEY, { shape: "world_changed", what })) as { id: string }
  const landWait = async (root: string, n: number) => {
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: `land-${n}`, root, a: "call/git_land" }, walk)) as { id: string }
    return (await write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: `c-land-${n}`, status: 200, waits_for: "person",
      body: JSON.stringify({ error: "the change touches what judges changes: only a person's verdict lands it", waits_for: "person" }), input_refs: [sel.id] }, walk)) as { id: string; seq: number }
  }
  // a person's mark on the root's answer: the answer cites the root, the mark cites the answer (two hops, as on the page)
  const personMark = async (root: string, n: number) => {
    const sel = (await write(NODE_KEY, { shape: "selection", arm: "treated", cell: `ans-${n}`, root, a: "produce/answer/ch1" }, walk)) as { id: string }
    const answer = (await write(NODE_KEY, { shape: "answer", text: `answer ${n}`, selection_ref: sel.id, input_refs: [root] }, desc)) as { id: string }
    return write(PERSON_KEY, { shape: "outcome", r: 0, input_refs: [answer.id] })
  }
  return { call, write, waits, ask, landWait, personMark }
}

describe("who is waiting on a person now", () => {
  test("[MUST-FAIL] a land waiting on a person, with no person row about the root since, is one person_wait row naming its root", async () => {
    const s = await fresh()
    expect(await s.waits()).toEqual([])
    const a = await s.ask("change the shell gate")
    const f = await s.landWait(a.id, 1)
    const got = await s.waits()
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({ shape: "person_wait", id: `person_wait:${f.id}`, root: a.id, waits_for: "person", seq: f.seq, input_refs: [f.id], tree: null, repo: null })
    // every served field is its source's: the time and selection the wait's failure states (a page draws the time
    // beside the ask), and records as the row's writer
    const src = f as { t?: unknown; selection_ref?: unknown }
    expect([typeof got[0].t, got[0].t, got[0].selection_ref, got[0].writer, got[0].role])
      .toEqual(["string", src.t, src.selection_ref, "records", "records"])
  })

  test("[MUST-FAIL] a person's mark about the root after the wait ends it, read through the answer it grades", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    await s.landWait(a.id, 1)
    await s.personMark(a.id, 1)
    expect(await s.waits()).toEqual([])
  })

  test("[MUST-FAIL] a person row about another root, or one before the wait, does not end it", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const b = await s.ask("another ask")
    await s.personMark(a.id, 0) // before the wait
    const f = await s.landWait(a.id, 1)
    await s.personMark(b.id, 2) // about another root
    expect((await s.waits()).map((w) => [w.root, w.id])).toEqual([[a.id, `person_wait:${f.id}`]])
  })

  test("[MUST-FAIL] the root's newest wait decides: a wait after a person spoke is open again, named for the newest failure", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    await s.landWait(a.id, 1)
    await s.personMark(a.id, 1)
    const f2 = await s.landWait(a.id, 2)
    expect((await s.waits()).map((w) => w.id)).toEqual([`person_wait:${f2.id}`])
  })

  test("[MUST-FAIL] a person_wait is never stored: a write of one is refused, and the read is still derived", async () => {
    const s = await fresh()
    const refused = await s.write(NODE_KEY, { shape: "person_wait", root: "forged", waits_for: "person" }, walk)
    expect(JSON.stringify(refused)).toContain("person_wait: derived on read")
    expect(await s.waits()).toEqual([])
  })

  test("[MUST-FAIL] the tree and repo the wait is about are carried as the failure states them, null when it states none, never read from its text", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const sel = (await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "land-t", root: a.id, a: "call/git_land" }, walk)) as { id: string }
    await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: "c-t", status: 200, waits_for: "person", tree: "TREE_WAITED_ON", repo: "local-tools-vessel",
      body: JSON.stringify({ error: "only a person's verdict lands it", waits_for: "person", tree: "TREE_WAITED_ON" }), input_refs: [sel.id] }, walk)
    const b = await s.ask("another ask")
    await s.landWait(b.id, 2) // its body says no tree as a field
    const got = await s.waits()
    expect(got.map((w) => [w.root, w.tree, w.repo])).toEqual([[a.id, "TREE_WAITED_ON", "local-tools-vessel"], [b.id, null, null]])
  })

  test("[MUST-FAIL] the row names the person wait itself, never a later row on the root that is not one", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const f = await s.landWait(a.id, 1)
    const sel = (await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "later", root: a.id, a: "call/git_diff" }, walk)) as { id: string }
    // a later walk failure that waits on no one; a walk row of another shape saying waits_for; a model's failure saying it
    await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: "c-later", status: 422, tree: "LATER_TREE", body: "{}", input_refs: [sel.id] }, walk)
    await s.write(NODE_KEY, { shape: "hop", selection_ref: sel.id, call_id: "c-hop", phase: "ended", waits_for: "person", tree: "HOP_TREE", input_refs: [sel.id] }, walk)
    await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: "c-model", status: 422, waits_for: "person", tree: "MODEL_TREE", body: "{}", input_refs: [a.id] }, desc)
    const got = await s.waits()
    expect(got.map((w) => [w.id, w.input_refs, w.tree])).toEqual([[`person_wait:${f.id}`, [f.id], null]])
  })

  test("[MUST-FAIL] a wait whose selection names no root is no one's wait", async () => {
    const s = await fresh()
    const sel = (await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "rootless", a: "call/git_land" }, walk)) as { id: string }
    await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: "c-r", status: 200, waits_for: "person", body: "{}", input_refs: [sel.id] }, walk)
    expect(await s.waits()).toEqual([])
  })

  test("[MUST-FAIL] a limit keeps the newest waits; a tree or repo that is not a string is null", async () => {
    const s = await fresh()
    const ids: string[] = []
    for (const n of [1, 2, 3]) {
      const a = await s.ask(`ask ${n}`)
      const sel = (await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: `land-${n}`, root: a.id, a: "call/git_land" }, walk)) as { id: string }
      const f = (await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: `c-${n}`, status: 200, waits_for: "person",
        tree: n === 3 ? { not: "a tree" } : `TREE_${n}`, repo: n === 3 ? 7 : "r", body: "{}", input_refs: [sel.id] }, walk)) as { id: string }
      ids.push(`person_wait:${f.id}`)
    }
    const two = (await s.call(NODE_KEY, { type: "record_read", shape: "person_wait", limit: 2 })) as Array<Record<string, unknown>>
    expect(two.map((w) => w.id)).toEqual(ids.slice(1))
    expect([two[1].tree, two[1].repo]).toEqual([null, null])
  })

  test("[GUARD] a failure that does not say waits_for person is no wait", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const sel = (await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "land-x", root: a.id, a: "call/git_land" }, walk)) as { id: string }
    await s.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: "c-x", status: 422, body: "{}", input_refs: [sel.id] }, walk)
    expect(await s.waits()).toEqual([])
  })
})
