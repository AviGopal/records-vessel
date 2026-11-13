// SPDX-License-Identifier: MIT
// Which request the walk works, and what it sees of it. Measured on a running node before this: the root was the
// single NEWEST exogenous row, so a person request was evicted unanswered a minute after it was made, and a request the
// walk had graded as answered 37 times was still worked. Now the root is the oldest open request: closed by a person's
// verdict at r 1 or by a lapse, never by the walk grading itself; the walk's arm only when none is open; and the
// episode holds only rows descended from the root.
import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { type Fake, fake, freePort, healthy, run, until } from "./harness"

const NODE_KEY = "node-key-for-test"
const PERSON_KEY = "person-key-for-test"
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
    ? Response.json({ success: true, data: { authenticated: true, keyId: "kid-person" } })
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

describe("the walk's episode", () => {
  test("[MUST-FAIL] an arm older than both requests does not pin the root: the oldest open request is it", async () => {
    const r = await fresh()
    const arm = await r.arm()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const ep = await r.episode()
    expect(ep).toContain(first.id)
    expect(ep).not.toContain(second.id)
    expect(ep).not.toContain(arm.id)
  })

  test("[MUST-FAIL] the walk grading its own answer r 1 does not close a request; a person's verdict does", async () => {
    const r = await fresh()
    await r.arm()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const sel = await r.select(first.id)
    const answer = await r.write(NODE_KEY, { shape: "answer", text: "a", selection_ref: sel.id, input_refs: [first.id] }, desc)
    const gradeSel = await r.select(first.id)
    await r.write(NODE_KEY, { shape: "outcome", r: 1, selection_ref: gradeSel.id, input_refs: [first.id, answer.id], evidence_refs: [answer.id] }, desc)
    expect(await r.episode()).toContain(first.id)
    await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [answer.id] })
    const ep = await r.episode()
    expect(ep).not.toContain(first.id)
    expect(ep).toContain(second.id)
  })

  test("[MUST-FAIL] a lapse closes a request as failed, and the next request becomes the root", async () => {
    const r = await fresh()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const third = await r.ask("third")
    const sel = await r.select(first.id)
    const due = await r.write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: sel.id, input_refs: [first.id] }, desc)
    await Bun.sleep(20)
    const gradeSel = await r.select(first.id)
    await r.write(NODE_KEY, { shape: "outcome", r: 0, selection_ref: gradeSel.id, input_refs: [first.id, due.id], evidence_refs: [due.id] }, desc)
    const ep = await r.episode()
    expect(ep).not.toContain(first.id)
    expect(ep).toContain(second.id) // the next open request, not the newest
    expect(ep).not.toContain(third.id)
  })

  test("[MUST-FAIL] a newer request's work is not in the older root's episode", async () => {
    const r = await fresh()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const mine = await r.select(first.id)
    const theirs = await r.select(second.id)
    const hop = await r.write(NODE_KEY, { shape: "hop", phase: "ended", selection_ref: theirs.id, input_refs: [theirs.id] }, walk)
    const ep = await r.episode()
    expect(ep).toContain(mine.id)
    expect(ep).not.toContain(theirs.id)
    expect(ep).not.toContain(hop.id)
  })

  test("[MUST-FAIL] read with roots all: every open request, oldest first, each with only its own work; shared rows once", async () => {
    const r = await fresh()
    await r.arm()
    const ch = await r.write(NODE_KEY, { shape: "channel", calls: [] }, owner)
    const first = await r.ask("first")
    const second = await r.ask("second")
    const mine = await r.select(first.id)
    const theirs = await r.select(second.id)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([first.id, second.id])
    expect(all.roots[0].rows.map((x) => x.id)).toContain(mine.id)
    expect(all.roots[0].rows.map((x) => x.id)).not.toContain(theirs.id)
    expect(all.roots[1].rows.map((x) => x.id)).toContain(theirs.id)
    expect(all.shared.filter((x) => x.id === ch.id)).toHaveLength(1)
    for (const e of all.roots) expect(e.rows.map((x) => x.id)).not.toContain(ch.id)
    expect(await r.episode()).toContain(first.id) // the old form is unchanged
    expect(await r.episode()).not.toContain(second.id)
  })

  test("[MUST-FAIL] an owner repository row is configuration: never a root, and shared once with every root's work", async () => {
    const r = await fresh()
    await r.arm()
    const repo = await r.write(NODE_KEY, { shape: "repository", repo: "some-repo", units: ["some.service"], roles: ["compute"], retired: false }, owner)
    const first = await r.ask("first")
    const second = await r.ask("second")
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([first.id, second.id])
    expect(all.shared.filter((x) => x.id === repo.id)).toHaveLength(1)
    const ep = await r.episode()
    expect(ep).toContain(repo.id)
    expect(ep).toContain(first.id)
  })

  test("[MUST-FAIL] only the owner writes a repository row: a walk, described or person write is refused, so none is shared", async () => {
    const r = await fresh()
    await r.arm()
    const first = await r.ask("first")
    const row = { shape: "repository", repo: "some-repo", units: [], roles: [], retired: false }
    for (const [key, as] of [[NODE_KEY, walk], [NODE_KEY, desc], [PERSON_KEY, undefined]] as const) {
      const w = await r.write(key, row, as)
      expect([as?.role ?? "person", w?.failure?.status]).toEqual([as?.role ?? "person", 403])
    }
    const all = await r.episodes()
    expect(all.shared.filter((x: any) => x.shape === "repository")).toHaveLength(0)
    expect(all.roots.map((x) => x.root.id)).toEqual([first.id])
  })

  test("[MUST-FAIL] a row the walk recorded from a tool's answer is in its request's episode, and only in its request's", async () => {
    const r = await fresh()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const mine = await r.select(first.id)
    const theirs = await r.select(second.id)
    const diff = await r.write(NODE_KEY, { shape: "gitDiff", tree: "t1", selection_ref: mine.id, input_refs: [first.id] }, walk)
    const other = await r.write(NODE_KEY, { shape: "gitDiff", tree: "t2", selection_ref: theirs.id, input_refs: [second.id] }, walk)
    const all = await r.episodes()
    expect(all.roots[0].rows.map((x) => x.id)).toContain(diff.id)
    expect(all.roots[0].rows.map((x) => x.id)).not.toContain(other.id)
    expect(all.roots[1].rows.map((x) => x.id)).toContain(other.id)
  })

  test("[MUST-FAIL] a request answered only by its walk lapses at its FIRST deadline; a later deadline does not move it", async () => {
    const r = await fresh()
    const ask = await r.ask("first")
    const sel = await r.select(ask.id)
    const firstDue = await r.write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await r.write(NODE_KEY, { shape: "answer", text: "a", selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await r.write(NODE_KEY, { shape: "due", within_ms: 3_600_000, selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await Bun.sleep(20)
    expect(await r.lapsed()).toEqual([firstDue.id])
  })

  test("[MUST-FAIL] a lapsed read naming its requests answers only their deadlines; one naming none answers every request's", async () => {
    const r = await fresh()
    const first = await r.ask("first")
    const second = await r.ask("second")
    const mine = await r.write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: (await r.select(first.id)).id, input_refs: [first.id] }, desc)
    const theirs = await r.write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: (await r.select(second.id)).id, input_refs: [second.id] }, desc)
    await Bun.sleep(20)
    expect(await r.lapsed({ asks: [first.id] })).toEqual([mine.id])
    expect((await r.lapsed()).sort()).toEqual([mine.id, theirs.id].sort())
  })

  test("[MUST-FAIL] a failed move never closes a request or hides a lapse", async () => {
    const r = await fresh()
    const ask = await r.ask("first")
    const sel = await r.select(ask.id)
    const due = await r.write(NODE_KEY, { shape: "due", within_ms: 1, selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await r.write(NODE_KEY, { shape: "failure", status: 422, body: "x", selection_ref: sel.id, input_refs: [ask.id, due.id] }, walk)
    await Bun.sleep(20)
    expect(await r.lapsed()).toEqual([due.id])
    expect((await r.episodes()).roots.map((x) => x.root.id)).toContain(ask.id)
  })

  test("a person's verdict before the first deadline ends the request: nothing lapses", async () => {
    const r = await fresh()
    const ask = await r.ask("first")
    const sel = await r.select(ask.id)
    await r.write(NODE_KEY, { shape: "due", within_ms: 300, selection_ref: sel.id, input_refs: [ask.id] }, desc)
    const answer = await r.write(NODE_KEY, { shape: "answer", text: "a", selection_ref: sel.id, input_refs: [ask.id] }, desc)
    await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [answer.id] })
    await Bun.sleep(350)
    expect(await r.lapsed()).toEqual([])
  })

  test("[MUST-FAIL] the owner's precondition on a call is configuration every root shares, never a request; only the owner writes one", async () => {
    const r = await fresh()
    const arm = await r.arm()
    const req = await r.write(NODE_KEY, { shape: "requires", for: "git_worktree", needs: "change_wanted", where: { wanted: true } }, owner)
    let all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([arm.id]) // idle: nothing to work
    expect(all.shared.map((x) => x.id)).toContain(req.id)
    const a = await r.ask("hello")
    all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([a.id])
    expect(all.shared.map((x) => x.id)).toContain(req.id)
    expect((await r.write(PERSON_KEY, { shape: "requires", for: "x", needs: "y" })).failure?.status).toBe(403)
  })

  test("[MUST-FAIL] the owner's description of a shape is configuration, not a request", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, { shape: "shape_description", of: "gap", description: "what a gap row is" }, owner)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.shape)).toEqual(["arm"]) // idle: nothing to work
    expect((await r.write(PERSON_KEY, { shape: "shape_description", of: "x" })).failure?.status).toBe(403) // owner rows only
  })

  test("[MUST-FAIL] the owner's credits rule is configuration, not a request, and only the owner writes one", async () => {
    const r = await fresh()
    await r.arm()
    await r.write(NODE_KEY, { shape: "credits", target: "gap", by_call: "land_it" }, owner)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.shape)).toEqual(["arm"]) // idle: nothing to work
    expect((await r.write(PERSON_KEY, { shape: "credits", target: "gap", by_call: "x" })).failure?.status).toBe(403) // owner rows only
  })

  test("[MUST-FAIL] a read of the walk's calls of named shapes answers each with its root, the root's state and the call's (abandoned once the walk moved on), never the rows behind them", async () => {
    const r = await fresh()
    await r.arm()
    const w1 = await r.ask("open request")
    const w2 = await r.ask("closed request")
    // the live forms: a selection names its root; a started hop names the shape called; an ended hop carries only call_id
    const sel = (root: string) => r.write(NODE_KEY, { shape: "selection", arm: "treated", cell: "c", root, pool_refs: [root], input_refs: [root], cands: "x".repeat(40_000) }, walk)
    // the walk's own order: a selection, then the calls it makes, one move at a time
    const started = (s: { id: string }, type: string, call: string) =>
      r.write(NODE_KEY, { shape: "hop", phase: "started", kind: "call", pointer_type: type, call_id: call, selection_ref: s.id, input_refs: [s.id] }, walk)
    const s1 = await sel(w1.id)
    await started(s1, "clone_it", "c1")
    await r.write(NODE_KEY, { shape: "hop", phase: "ended", kind: "call", call_id: "c1", selection_ref: s1.id, output: { cwd: "/trees/a" }, input_refs: [s1.id] }, walk)
    await started(s1, "read_it", "c5") // a shape not asked for, ended: not answered
    await r.write(NODE_KEY, { shape: "hop", phase: "ended", kind: "call", call_id: "c5", selection_ref: s1.id, output: {}, input_refs: [s1.id] }, walk)
    const s2 = await sel(w2.id)
    await started(s2, "clone_it", "c3")
    await r.write(NODE_KEY, { shape: "failure", call_id: "c3", selection_ref: s2.id, status: 0, body: "x", input_refs: [s2.id] }, walk)
    const s3 = await sel(w1.id) // the walk's newest move: a run of two calls, both still in flight
    await started(s3, "clone_it", "c2")
    await started(s3, "read_it", "c4") // a shape not asked for, in flight: answered, since a reader must not disturb it
    await r.write(PERSON_KEY, { shape: "outcome", r: 1, input_refs: [w2.id] }) // not an answer: w2 stays open too
    const got = (await r.call(NODE_KEY, { type: "record_read", episode: WALK, calls: ["clone_it"] })) as Array<Record<string, unknown>>
    const by = Object.fromEntries(got.map((c) => [c.call_id, c]))
    expect(Object.keys(by).sort()).toEqual(["c1", "c2", "c3", "c4"])
    expect([by.c4.type, by.c4.state]).toEqual(["read_it", "started"])
    // the walk moves on (a newer selection): a call left unsettled under an older one was cut off, not in flight
    await sel(w1.id)
    const after = (await r.call(NODE_KEY, { type: "record_read", episode: WALK, calls: ["clone_it"] })) as Array<Record<string, unknown>>
    const by2 = Object.fromEntries(after.map((c) => [c.call_id, c]))
    expect(Object.keys(by2).sort()).toEqual(["c1", "c2", "c3"]) // c4, of another shape, is no longer in flight
    expect([by2.c1.state, by2.c2.state, by2.c3.state]).toEqual(["ended", "abandoned", "failed"])
    // a call under a selection records does not hold cannot be placed: read as in flight, never as abandoned
    await r.write(NODE_KEY, { shape: "hop", phase: "started", kind: "call", pointer_type: "read_it", call_id: "c6", selection_ref: "sel-unheld", input_refs: [] }, walk)
    const unplaced = ((await r.call(NODE_KEY, { type: "record_read", episode: WALK, calls: ["clone_it"] })) as Array<Record<string, unknown>>).find((c) => c.call_id === "c6")
    expect(unplaced?.state).toBe("started")
    expect([by.c1.state, by.c2.state, by.c3.state]).toEqual(["ended", "started", "failed"])
    expect(by.c1.root).toBe(w1.id)
    expect(by.c1.open).toBe(true)
    expect((by.c1.output as { cwd: string }).cwd).toBe("/trees/a")
    expect(JSON.stringify(got)).not.toContain("x".repeat(100)) // no selection row rides along
  })

  const detector = { writer: "pull-sync", role: "detector" }
  const gap = (r: Awaited<ReturnType<typeof fresh>>, id: string, status: string) =>
    r.write(NODE_KEY, { shape: "gap", gap_id: id, status, summary: "a check fails" }, detector)

  test("[MUST-FAIL] a gap a detector opened is work: a root, with only its own rows", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const sel = await r.select(g.id)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([g.id]) // not idle on the arm
    expect(all.roots[0].rows.map((x) => x.id)).toEqual([g.id, sel.id])
  })

  test("[MUST-FAIL] a gap written again while open is the same root: its earlier rows and the work on them stay in its episode", async () => {
    const r = await fresh()
    await r.arm()
    const first = await gap(r, "g1", "open")
    const work = await r.select(first.id)
    const again = await r.write(NODE_KEY, { shape: "gap", gap_id: "g1", status: "open", summary: "a check fails", repo: "x" }, detector)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([again.id]) // the latest row speaks for the gap
    const ids = all.roots[0].rows.map((x) => x.id)
    expect(ids).toContain(work.id) // the work done on the earlier row is not lost
    expect(ids).toContain(first.id)
  })

  test("a gap closed and opened again starts a new episode (a guard): the work before its close is not carried", async () => {
    const r = await fresh()
    await r.arm()
    const first = await gap(r, "g1", "open")
    const before = await r.select(first.id)
    await gap(r, "g1", "closed")
    const reopened = await gap(r, "g1", "open")
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([reopened.id])
    expect(all.roots[0].rows.map((x) => x.id)).not.toContain(before.id)
    expect(all.roots[0].rows.map((x) => x.id)).not.toContain(first.id)
  })

  test("a hold on the latest row holds the whole gap (a guard): the earlier rows' work does not make it a root", async () => {
    const r = await fresh()
    const arm = await r.arm()
    const first = await gap(r, "g1", "open")
    await r.select(first.id)
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g1", status: "open", meta: { operator_hold: true } }, detector)
    expect((await r.episodes()).roots.map((x) => x.root.id)).toEqual([arm.id])
  })

  test("[MUST-FAIL] a gap a person holds is no one's work: not a root while held, a root again once a later row lifts it", async () => {
    const r = await fresh()
    const arm = await r.arm()
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-held", status: "open", meta: { operator_hold: true } }, detector)
    await r.write(NODE_KEY, { shape: "gap", gap_id: "g-top", status: "open", operator_hold: true }, detector)
    expect((await r.episodes()).roots.map((x) => x.root.id)).toEqual([arm.id])
    const lifted = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-held", status: "open", meta: { operator_hold: false } }, detector)
    expect((await r.episodes()).roots.map((x) => x.root.id)).toEqual([lifted.id])
  })

  test("a person's grade on a gap row neither lifts a hold, closes a gap nor is a root: only a detector's row does (a guard)", async () => {
    const r = await fresh()
    const arm = await r.arm()
    const held = await r.write(NODE_KEY, { shape: "gap", gap_id: "g-held", status: "open", meta: { operator_hold: true } }, detector)
    const open = await gap(r, "g-open", "open")
    for (const [ref, v] of [[held.id, 1], [held.id, 0], [open.id, 1], [open.id, 0]] as const) {
      expect((await r.write(PERSON_KEY, { shape: "outcome", r: v, input_refs: [ref] })).role).toBe("person")
    }
    expect((await r.episodes()).roots.map((x) => x.root.id)).toEqual([open.id]) // the held gap stays held, the open one open
    expect(arm.id).toBeDefined()
  })

  test("[MUST-FAIL] a person's ask and an open gap are both roots, oldest first, each with its own work", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const a = await r.ask("hello")
    const onAsk = await r.select(a.id)
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([g.id, a.id])
    expect(all.roots[0].rows.map((x) => x.id)).not.toContain(onAsk.id)
    expect(all.roots[1].rows.map((x) => x.id)).toContain(onAsk.id)
  })

  test("a later detector row that is not open closes the gap: the walk idles again (a pin; the parent never opened it)", async () => {
    const r = await fresh()
    const arm = await r.arm()
    await gap(r, "g1", "open")
    await gap(r, "g1", "closed")
    const all = await r.episodes()
    expect(all.roots.map((x) => x.root.id)).toEqual([arm.id])
  })

  test("a closed row anyone but a detector writes closes nothing; a gap row not a detector's is no root (a guard)", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const notClosing = await r.write(NODE_KEY, { shape: "gap", gap_id: "g1", status: "closed" }, walk)
    const notOpening = await r.write(NODE_KEY, { shape: "gap", gap_id: "g2", status: "open" }, walk)
    const roots = (await r.episodes()).roots.map((x) => x.root.id)
    expect(roots).not.toContain(notClosing.id)
    expect(roots).not.toContain(notOpening.id)
    expect(roots.includes(g.id) || roots.length === 1).toBe(true)
  })

  test("[MUST-FAIL] a wait is answered by a detector's row closing a gap, so a walk waiting on that gap sees it end", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const waiting = r.call(NODE_KEY, { type: "record_wait", shapes: [], after_seq: g.seq })
    await Bun.sleep(50)
    const closing = await gap(r, "g1", "closed")
    const got = await Promise.race([waiting, Bun.sleep(3000).then(() => null)])
    expect(got?.id).toBe(closing.id)
  })

  test("[MUST-FAIL] a wait is answered by a gap a detector opens, as by a person's ask", async () => {
    const r = await fresh()
    await r.arm()
    const waiting = r.call(NODE_KEY, { type: "record_wait", shapes: [], after_seq: 1 })
    await Bun.sleep(50)
    const g = await gap(r, "g1", "open")
    const got = await Promise.race([waiting, Bun.sleep(3000).then(() => null)])
    expect(got?.id).toBe(g.id)
  })

  // A run that reached: the ask, a call that ended in its work, an answer, and a person's verdict on it.
  const reached = async (r: Awaited<ReturnType<typeof fresh>>, verdict: number | null) => {
    await r.arm()
    const a = await r.ask("make the change")
    const sel = await r.select(a.id)
    await r.write(NODE_KEY, { shape: "hop", call_id: "c1", phase: "started", kind: "call", pointer_type: "git_worktree", selection_ref: sel.id, input_refs: [sel.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "c1", phase: "ended", kind: "call", selection_ref: sel.id, input_refs: [sel.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "c2", phase: "started", kind: "call", pointer_type: "git_commit", selection_ref: sel.id, input_refs: [sel.id] }, walk)
    await r.write(NODE_KEY, { shape: "hop", call_id: "c2", phase: "ended", kind: "call", selection_ref: sel.id, input_refs: [sel.id] }, walk)
    const answerSel = await r.select(a.id)
    const answer = await r.write(NODE_KEY, { shape: "answer", text: "done", selection_ref: answerSel.id, input_refs: [a.id] }, desc)
    if (verdict !== null) await r.write(PERSON_KEY, { shape: "outcome", r: verdict, input_refs: [answer.id] })
    const template = async (calls: string[], root = a.id) => {
      const tSel = await r.select(root)
      return r.write(NODE_KEY, { shape: "activity_template", sig: { in: ["world_changed"], out: ["answer"] }, calls: calls.map((shape) => ({ shape, pointer: {} })), selection_ref: tSel.id, input_refs: [root] }, desc)
    }
    return { a, template }
  }
  const sharedIds = async (r: Awaited<ReturnType<typeof fresh>>) => (await r.episodes()).shared.map((x) => x.id)

  test("a template that replays, in order, calls that ended in a request a person graded done is the walk's to run (a guard)", async () => {
    const r = await fresh()
    const run = await reached(r, 1)
    const whole = await run.template(["git_worktree", "git_commit"])
    const part = await run.template(["git_commit"])
    const ids = await sharedIds(r)
    expect(ids).toContain(whole.id)
    expect(ids).toContain(part.id)
  })

  test("[MUST-FAIL] a template declared from a request no person graded done, or graded r 0, is not offered", async () => {
    for (const verdict of [null, 0]) {
      const r = await fresh()
      const run = await reached(r, verdict)
      const t = await run.template(["git_worktree", "git_commit"])
      expect(await sharedIds(r)).not.toContain(t.id)
      stop()
    }
  })

  test("[MUST-FAIL] a template calling what the run never called, or in another order, or nothing, is not offered", async () => {
    const r = await fresh()
    const run = await reached(r, 1)
    const never = await run.template(["hop"])
    const extra = await run.template(["git_worktree", "fs_edit", "git_commit"])
    const swapped = await run.template(["git_commit", "git_worktree"])
    const empty = await run.template([])
    const ids = await sharedIds(r)
    for (const t of [never, extra, swapped, empty]) expect(ids).not.toContain(t.id)
  })

  test("[MUST-FAIL] a template whose own selection worked another request is not earned by this one's verdict", async () => {
    const r = await fresh()
    const run = await reached(r, 1)
    const other = await r.ask("something else")
    const t = await run.template(["git_worktree"], other.id)
    expect(await sharedIds(r)).not.toContain(t.id)
  })

  test("[MUST-FAIL] a person who grades an answer r 1 and then r 0 has not closed the request, nor earned a template", async () => {
    const r = await fresh()
    const run = await reached(r, 1)
    const answer = (await r.episodes()).roots.find((x) => x.root.id === run.a.id)
    expect(answer).toBeUndefined() // r 1 alone closes it
    const answers = ((await r.call(NODE_KEY, { type: "record_read", shape: "answer" })) as Array<{ id: string }>)
    await r.write(PERSON_KEY, { shape: "outcome", r: 0, input_refs: [answers[0].id] }) // the same person takes it back
    expect((await r.episodes()).roots.map((x) => x.root.id)).toContain(run.a.id)
    const t = await run.template(["git_worktree", "git_commit"])
    expect(await sharedIds(r)).not.toContain(t.id)
  })

  test("[MUST-FAIL] a person's verdict on what a row cites is a grade, not a request: it is never a root", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("change something")
    const v = await r.write(PERSON_KEY, { shape: "land_verdict", repo: "demo", tree: "a".repeat(40), r: 1, input_refs: [a.id] })
    const roots = (await r.episodes()).roots.map((x: any) => x.root.id)
    expect(roots).toContain(a.id)
    expect(roots).not.toContain(v.id)
    // an ask that happens to carry an r but judges nothing is still a request; a person's outcome stays a grade as before
    const odd = await r.write(PERSON_KEY, { shape: "world_changed", what: "r is a word here", r: 1 })
    const o = await r.write(PERSON_KEY, { shape: "outcome", r: 0, input_refs: [a.id] })
    const after = (await r.episodes()).roots.map((x: any) => x.root.id)
    expect(after).toContain(odd.id)
    expect(after).not.toContain(o.id)
  })

  test("[MUST-FAIL] every root says whether an answer is awaited: a person's ask and a detector's gap do; the walk's arm does not", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const a = await r.ask("hello")
    const by = new Map((await r.episodes()).roots.map((x: any) => [x.root.id, x.awaits]))
    // a gap awaits the change its detector checks for: the walk waits on it only by a deadline, never unbounded, since a
    // wait ends on a person's or the owner's row, which no one writes for a gap
    expect([by.get(g.id), by.get(a.id)]).toEqual([true, true])
    const idle = await fresh()
    const arm = await idle.arm()
    expect(((await idle.episodes()).roots as any[]).find((x) => x.root.id === arm.id)?.awaits).toBe(false)
  })

  test("[MUST-FAIL] a walk's failure row is stamped with whom it blames, by records, whatever the writer said", async () => {
    const r = await fresh()
    await r.arm()
    const a = await r.ask("x")
    const sel = await r.select(a.id)
    const stamp = async (f: Record<string, unknown>) =>
      (await r.write(NODE_KEY, { shape: "failure", selection_ref: sel.id, input_refs: [sel.id], ...f }, walk)).blames
    expect([
      await stamp({ status: 422, blames: "callee" }), await stamp({ status: 200 }), await stamp({ status: 400 }),
      await stamp({ status: 503 }), await stamp({ status: 401 }), await stamp({ status: 429 }), await stamp({ status: 0 }),
      await stamp({ kind: "skip" }),
    ]).toEqual(["request", "request", "request", "callee", "callee", "callee", "callee", "walk"])
  })

  test("[MUST-FAIL] a request whose deadline lapsed is closed by the lapse grade, even when the grader also saw the walk's hops", async () => {
    const r = await fresh()
    const arm = await r.arm()
    const a = await r.ask("what is the time")
    const sel = await r.select(a.id)
    const due = await r.write(NODE_KEY, { shape: "due", within_ms: 0, selection_ref: sel.id, input_refs: [a.id] }, desc)
    const h = await r.write(NODE_KEY, { shape: "hop", call_id: "c1", phase: "ended", kind: "call", selection_ref: sel.id, input_refs: [sel.id] }, walk)
    await Bun.sleep(5)
    const gSel = await r.select(a.id)
    await r.write(NODE_KEY, { shape: "outcome", r: 0, selection_ref: gSel.id, input_refs: [a.id, due.id, h.id], evidence_refs: [due.id] }, desc)
    expect((await r.episodes()).roots.map((x) => x.root.id)).toEqual([arm.id])
  })

  test("with no request open, the walk idles on its arm, as before", async () => {
    const r = await fresh()
    const arm = await r.arm()
    expect(await r.episode()).toContain(arm.id)
  })
})
