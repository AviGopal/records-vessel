// SPDX-License-Identifier: MIT
// Where each open ask stands now: record_read {shape: "ask_state"} answers one derived row per open ask, through a real
// records process, carrying each state that holds as its own field (waiting_pick, working, answered, waiting_on_you) and
// none that does not. A person's Right on a result or a lapse closes the ask, and its row drops out. Rows are in the
// forms the walk, described, the owner and a person's key write them. A stored ask_state is refused.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"
const PERSON2_KEY = "person2-key-for-test"
const UNMARKED_KEY = "unmarked-key-for-test"
const WALK = "walk-test"
const walk = { writer: WALK, role: "walk" }
const desc = { writer: "described-test", role: "described" }
const owner = { writer: "owner", role: "owner" }

let stop: () => void = () => {}
afterEach(() => stop())

type R = Record<string, any>
// pre: rows already stored when records starts (rows written before a rule records now enforces at write)
const fresh = async (pre: R[] = []) => {
  const discovery: Fake = fake((path) => Response.json(path === "/heartbeat" ? { nextHeartbeatMs: 600000 } : { ok: true }))
  const kid = (k: unknown) => k === PERSON_KEY ? ["kid-person", "person"] : k === PERSON2_KEY ? ["kid-person2", "person"] : k === UNMARKED_KEY ? ["kid-unmarked", "unclassified"] : undefined
  const identity: Fake = fake((_p, body) => {
    const k = kid(body?.impulse?.pointer?.apiKey)
    return k ? Response.json({ success: true, data: { authenticated: true, keyId: k[0], ownerKind: k[1] } }) : Response.json({ success: false }, { status: 401 })
  })
  const dir = mkdtempSync(join(tmpdir(), "records-askstate-"))
  if (pre.length > 0) writeFileSync(join(dir, "rows"), pre.map((r) => `${JSON.stringify(r)}\n`).join(""))
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
  const write = (key: string, row: object, as?: { writer: string; role: string }) => call(key, { type: "record_write", row, ...(as ?? {}) }) as Promise<R>
  const states = async (where?: object) => (await call(NODE_KEY, { type: "record_read", shape: "ask_state", ...(where ? { where } : {}) })) as R[]
  // the owner's declarations, as the seed writes them: what an ask is (the request schema's ask: true input) and what a
  // grade judges as the answer (the outcome schema's evidence; its context lets a grade judge an answer or a due)
  await write(NODE_KEY, { shape: "shape_schema", target: "request", inputs: [{ shape: "world_changed", ask: true }] }, owner)
  await write(NODE_KEY, { shape: "shape_schema", target: "outcome", context: ["answer", "due"], evidence: [{ shape: "answer", deferred_by: "next_act" }] }, owner)
  const ask = (what: string, key = PERSON_KEY) => write(key, { shape: "world_changed", what })
  const select = (root: string, a: string, n: number) => write(NODE_KEY, { shape: "selection", arm: "treated", cell: `c-${n}`, root, a }, walk)
  const started = (sel: string, call_id: string, pointer_type: string) =>
    write(NODE_KEY, { shape: "hop", selection_ref: sel, call_id, phase: "started", kind: "call", pointer_type, input_refs: [sel] }, walk)
  const ended = (sel: string, call_id: string) => write(NODE_KEY, { shape: "hop", selection_ref: sel, call_id, phase: "ended", kind: "call", output: {}, input_refs: [sel] }, walk)
  const answer = async (root: string, n: number, extra: object = {}) => {
    const sel = await select(root, "produce/answer/ch1", n)
    return write(NODE_KEY, { shape: "answer", text: `answer ${n}`, selection_ref: sel.id, input_refs: [root], ...extra }, desc)
  }
  // a git_land call for the root that waits on a person: its selection names the root, its failure cites the selection
  const landWait = async (root: string, n: number, extra: object = {}) => {
    const sel = await select(root, "call/git_land", n)
    const f = await write(NODE_KEY, { shape: "failure", selection_ref: sel.id, call_id: `c-land-${n}`, status: 200, waits_for: "person",
      body: JSON.stringify({ error: "only a person's verdict lands it", waits_for: "person" }), input_refs: [sel.id], ...extra }, walk)
    return { sel, f }
  }
  return { call, write, states, ask, select, started, ended, answer, landWait }
}

const STATES = ["waiting_pick", "working", "answered", "waiting_on_you"]
// the one ask_state row a leg expects, asserted to be there first (so a store with none fails by assertion)
const only = async (s: { states: () => Promise<R[]> }): Promise<R> => {
  const got = await s.states()
  expect(got).toHaveLength(1)
  return got[0]!
}
const held = (r: R) => STATES.filter((k) => k in r)

describe("where each open ask stands", () => {
  test("[MUST-FAIL] an ask no selection names is waiting_pick alone, a row named for it, naming its asker", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const got = await s.states()
    expect(got).toHaveLength(1)
    expect(got[0]).toEqual({ shape: "ask_state", id: `ask_state:${a.id}`, writer: "records", role: "records", root: a.id, asker: "kid-person",
      asker_role: "person", asker_user: null, seq: a.seq, t: a.t, input_refs: [a.id], waiting_pick: true })
    // another ask picked by a selection is no longer waiting to be picked, and the first still is
    const b = await s.ask("another")
    await s.select(b.id, "call/git_diff", 1)
    expect((await s.states()).map((r) => [r.root, "waiting_pick" in r])).toEqual([[a.id, true], [b.id, false]])
    // the walk saying an ask sat with no move (a stall failure naming it as root) is no pick: it still waits to be picked
    await s.write(NODE_KEY, { shape: "failure", kind: "stall", root: a.id, selections: 60, since_seq: 1, input_refs: [a.id] }, walk)
    expect((await s.states()).map((r) => [r.root, "waiting_pick" in r])).toEqual([[a.id, true], [b.id, false]])
  })

  test("[MUST-FAIL] a call in flight for the ask is working alone, with its pointer_type and call_id; several are all carried", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const sel = await s.select(a.id, "call/git_diff", 1)
    await s.started(sel.id, "k1", "git_diff")
    await s.started(sel.id, "k2", "fs_read")
    const got = await only(s)
    expect(held(got)).toEqual(["working"])
    expect(got.working).toEqual([{ pointer_type: "git_diff", call_id: "k1" }, { pointer_type: "fs_read", call_id: "k2" }])
    // a call that ended is no longer in flight
    await s.ended(sel.id, "k1")
    expect((await only(s)).working).toEqual([{ pointer_type: "fs_read", call_id: "k2" }])
  })

  test("[MUST-FAIL] a picked ask with no call in flight is not working; a call under an older selection is not in flight", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const old = await s.select(a.id, "call/git_diff", 1)
    await s.started(old.id, "k-old", "git_diff")
    await s.select(a.id, "call/fs_read", 2) // the walk moved on: the older call was cut off
    const got = await only(s)
    expect(held(got)).toEqual([])
  })

  test("[MUST-FAIL] an answer to the ask is answered alone, naming the newest answer's id", async () => {
    const s = await fresh()
    const a = await s.ask("what is the gate")
    await s.answer(a.id, 1)
    const second = await s.answer(a.id, 2)
    const got = await only(s)
    expect(held(got)).toEqual(["answered"])
    expect(got.answered).toBe(second.id)
  })

  test("[MUST-FAIL] an answer made for one ask that cites another answers only its own: the cited ask is not answered", async () => {
    const s = await fresh()
    const a = await s.ask("the first ask")
    const b = await s.ask("the second ask")
    const selB = await s.select(b.id, "produce/answer/ch1", 1)
    const ans = await s.write(NODE_KEY, { shape: "answer", text: "for b", selection_ref: selB.id, input_refs: [b.id, a.id] }, desc)
    expect((await s.states()).map((r) => [r.root, r.answered ?? null])).toEqual([[a.id, null], [b.id, ans.id]])
  })

  test("[MUST-FAIL] a rootless answer citing nothing is the answer of its selection's root", async () => {
    const s = await fresh()
    const a = await s.ask("the ask")
    const sel = await s.select(a.id, "produce/answer/ch1", 1)
    const ans = await s.write(NODE_KEY, { shape: "answer", text: "by selection", selection_ref: sel.id, input_refs: [] }, desc)
    expect((await only(s)).answered).toBe(ans.id)
  })

  test("[MUST-FAIL] an answer's stated root decides it over its selection's; an empty one is no root, so the selection's decides", async () => {
    const s = await fresh()
    const a = await s.ask("the first ask")
    const b = await s.ask("the second ask")
    const selB = await s.select(b.id, "produce/answer/ch1", 1)
    const toA = await s.write(NODE_KEY, { shape: "answer", text: "states a", root: a.id, selection_ref: selB.id, input_refs: [] }, desc)
    expect((await s.states()).map((r) => [r.root, r.answered ?? null])).toEqual([[a.id, toA.id], [b.id, null]])
    const toB = await s.write(NODE_KEY, { shape: "answer", text: "empty root", root: "", selection_ref: selB.id, input_refs: [] }, desc)
    expect((await s.states()).map((r) => [r.root, r.answered ?? null])).toEqual([[a.id, toA.id], [b.id, toB.id]])
    // a root that is not a string is no root either: the selection's decides
    const toB2 = await s.write(NODE_KEY, { shape: "answer", text: "numeric root", root: 7, selection_ref: selB.id, input_refs: [] }, desc)
    expect((await s.states()).map((r) => [r.root, r.answered ?? null])).toEqual([[a.id, toA.id], [b.id, toB2.id]])
  })

  test("[MUST-FAIL] an answer with no own root answers no ask, whatever it cites: no selection, an unknown one, a rootless one", async () => {
    const s = await fresh()
    const a = await s.ask("the ask")
    // a selection with no root (as the walk wrote before selections named one) and one with an empty root
    const bare = await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c-bare", a: "produce/answer/ch1" }, walk)
    const empty = await s.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c-empty", root: "", a: "produce/answer/ch1" }, walk)
    expect((await s.write(NODE_KEY, { shape: "answer", text: "rootless selection", selection_ref: bare.id, input_refs: [a.id] }, desc)).id).toBeString()
    expect((await s.write(NODE_KEY, { shape: "answer", text: "empty-root selection", selection_ref: empty.id, input_refs: [a.id] }, desc)).id).toBeString()
    // records refuses a producer's row naming no selection at write, so these are never stored (the next leg reads ones
    // stored before that rule)
    const stall = await s.write(NODE_KEY, { shape: "failure", kind: "stall", root: a.id, selections: 60, since_seq: 1, input_refs: [a.id] }, walk)
    for (const ref of [{}, { selection_ref: "no-such-selection" }, { selection_ref: stall.id }]) {
      expect((await s.write(NODE_KEY, { shape: "answer", text: "refused", ...ref, input_refs: [a.id] }, desc)).id).toBeUndefined()
    }
    const got = await only(s)
    expect("answered" in got).toBe(false)
  })

  test("[MUST-FAIL] a stored answer naming no selection, an unknown one, or a row that is no selection answers no ask", async () => {
    // rows stored before records refused a producer's row naming no selection: the ask, the walk's stall failure naming
    // it as root, and three answers citing it whose selection_ref resolves to no selection
    const t = "2026-11-01T00:00:00.000Z"
    const row = (n: number, r: R): R => ({ input_refs: [], ...r, seq: n, t, id: `stored-${n}` })
    const ask = row(1, { shape: "world_changed", what: "stored ask", writer: "kid-person", role: "person" })
    const stall = row(2, { shape: "failure", kind: "stall", root: ask.id, selections: 60, since_seq: 1, input_refs: [ask.id], writer: WALK, role: "walk" })
    const s = await fresh([ask, stall,
      row(3, { shape: "answer", text: "no selection", input_refs: [ask.id], ...desc }),
      row(4, { shape: "answer", text: "unknown selection", selection_ref: "no-such-selection", input_refs: [ask.id], ...desc }),
      row(5, { shape: "answer", text: "not a selection", selection_ref: stall.id, input_refs: [ask.id], ...desc }),
    ])
    const got = await only(s)
    expect(got.root).toBe(ask.id)
    expect("answered" in got).toBe(false)
  })

  test("[MUST-FAIL] a described row the outcome schema does not name as evidence is no answer", async () => {
    const s = await fresh()
    const a = await s.ask("what is the gate")
    const sel = await s.select(a.id, "produce/change_wanted/ch1", 1)
    await s.write(NODE_KEY, { shape: "change_wanted", wanted: true, selection_ref: sel.id, input_refs: [a.id] }, desc)
    // nor is a row of the answer's shape that the walk's producer did not make (a person's, rooted at the ask)
    await s.write(PERSON_KEY, { shape: "answer", text: "my own answer", root: a.id, selection_ref: sel.id, input_refs: [a.id] })
    const got = await only(s)
    expect(held(got)).toEqual([])
  })

  test("[MUST-FAIL] a wait on a person is waiting_on_you alone, with the person_wait, its failure, tree, repo and time", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const { f } = await s.landWait(a.id, 1, { tree: "TREE_WAITED_ON", repo: "local-tools-vessel" })
    const got = await only(s)
    expect(held(got)).toEqual(["waiting_on_you"])
    expect(got.waiting_on_you).toEqual({ person_wait: `person_wait:${f.id}`, failure: f.id, tree: "TREE_WAITED_ON", repo: "local-tools-vessel", t: f.t })
  })

  test("[MUST-FAIL] when several states hold all are carried: waiting_on_you with working, and with answered", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    const fa = (await s.landWait(a.id, 1)).f
    const sel = await s.select(a.id, "call/git_diff", 2)
    await s.started(sel.id, "k1", "git_diff")
    const got = await only(s)
    expect(held(got)).toEqual(["working", "waiting_on_you"])
    expect(got.working).toEqual([{ pointer_type: "git_diff", call_id: "k1" }])
    const b = await s.ask("another")
    const ans = await s.answer(b.id, 3)
    const fb = (await s.landWait(b.id, 4)).f
    const both = (await s.states()).find((r) => r.root === b.id)!
    expect(held(both)).toEqual(["answered", "waiting_on_you"])
    expect(both.answered).toBe(ans.id)
    // each ask's own wait: a's names a's failure, b's names b's
    const now = await s.states()
    expect(now.map((r) => [r.root, r.waiting_on_you?.failure])).toEqual([[a.id, fa.id], [b.id, fb.id]])
  })

  test("[MUST-FAIL] a person's Right on a result closes the ask: its row drops out; a Wrong leaves it open, still answered", async () => {
    const s = await fresh()
    const a = await s.ask("what is the gate")
    const b = await s.ask("another")
    const ansA = await s.answer(a.id, 1)
    const ansB = await s.answer(b.id, 2)
    await s.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [ansA.id] })
    await s.write(PERSON_KEY, { shape: "outcome", r: 0, input_refs: [ansB.id] })
    const got = await s.states()
    expect(got.map((r) => [r.root, r.answered])).toEqual([[b.id, ansB.id]])
  })

  test("[MUST-FAIL] a lapse closes the ask: its row drops out", async () => {
    const s = await fresh()
    const a = await s.ask("what is the gate")
    const b = await s.ask("another")
    const sel = await s.select(a.id, "produce/due/ch1", 1)
    await s.write(NODE_KEY, { shape: "due", within_ms: 0, at: 0, selection_ref: sel.id, input_refs: [a.id] }, desc)
    await Bun.sleep(20)
    await s.select(b.id, "call/git_diff", 2) // a row after the deadline: the store's clock has passed it
    const got = await s.states()
    expect(got.map((r) => r.root)).toEqual([b.id])
  })

  test("[MUST-FAIL] keyed by writer: where {asker} answers that writer's asks only", async () => {
    const s = await fresh()
    const a = await s.ask("mine", PERSON_KEY)
    const b = await s.ask("theirs", PERSON2_KEY)
    expect((await s.states({ asker: "kid-person" })).map((r) => r.root)).toEqual([a.id])
    expect((await s.states({ asker: "kid-person2" })).map((r) => r.root)).toEqual([b.id])
    expect((await s.states()).map((r) => r.root)).toEqual([a.id, b.id])
  })

  test("[MUST-FAIL] an ask_state is never stored: a write of one is refused, and the read is still derived", async () => {
    const s = await fresh()
    const refused = await s.write(NODE_KEY, { shape: "ask_state", root: "forged", waiting_pick: true }, walk)
    expect(JSON.stringify(refused)).toContain("ask_state: derived on read")
    const byPerson = await s.write(PERSON_KEY, { shape: "ask_state", root: "forged" })
    expect(JSON.stringify(byPerson)).toContain("ask_state: derived on read")
    expect(await s.states()).toEqual([])
  })

  test("[MUST-FAIL] a limit keeps the newest asks' states", async () => {
    const s = await fresh()
    const ids: string[] = []
    for (const n of [1, 2, 3]) ids.push((await s.ask(`ask ${n}`)).id)
    const two = (await s.call(NODE_KEY, { type: "record_read", shape: "ask_state", limit: 2 })) as R[]
    expect(two.map((r) => r.root)).toEqual(ids.slice(1))
  })

  test("[GUARD] a read of ask_state writes nothing and changes no other read: the episodes, the posterior and the head are as before", async () => {
    const s = await fresh()
    const a = await s.ask("change the shell gate")
    await s.landWait(a.id, 1)
    const sel = await s.select(a.id, "call/git_diff", 2)
    await s.started(sel.id, "k1", "git_diff")
    const b = await s.ask("another")
    const ans = await s.answer(b.id, 3)
    await s.write(PERSON_KEY, { shape: "outcome", r: 0, input_refs: [ans.id] })
    const reads = async () => Promise.all([
      s.call(NODE_KEY, { type: "record_read", head: true }),
      s.call(NODE_KEY, { type: "record_read", episode: WALK, roots: "all" }),
      s.call(NODE_KEY, { type: "posterior", cells: ["c-1", "c-2", "c-3"], as_of_seq: 1e9 }),
    ]).then((x) => JSON.stringify(x, (k, v) => (k === "cost" ? undefined : v)))
    const before = await reads()
    expect((await s.states()).length).toBe(2)
    expect(await reads()).toBe(before)
    expect(before).not.toContain("ask_state")
  })

  test("[GUARD] rows of no ask shape get no ask_state: a person's other row, an unmarked key's world_changed, a grade", async () => {
    const s = await fresh()
    await s.write(PERSON_KEY, { shape: "note", what: "not an ask" })
    await s.write(UNMARKED_KEY, { shape: "world_changed", what: "unmarked" })
    expect(await s.states()).toEqual([])
  })

  test("[GUARD] a gap is no person's ask: an open gap root has no ask_state", async () => {
    const s = await fresh()
    await s.write(NODE_KEY, { shape: "gap", gap_id: "g1", status: "open", summary: "s" }, { writer: "pull-sync", role: "detector" })
    const eps = (await s.call(NODE_KEY, { type: "record_read", episode: WALK, roots: "all" })) as { roots: Array<{ root: R }> }
    expect(eps.roots.map((x) => x.root.shape)).toEqual(["gap"])
    expect(await s.states()).toEqual([])
  })
})
