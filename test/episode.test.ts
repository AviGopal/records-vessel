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
  const lapsed = async (): Promise<string[]> =>
    ((await call(NODE_KEY, { type: "record_lapsed", deadline_shape: "due", answer_shape: "answer" })) as Array<{ id: string }>).map((r) => r.id)
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

  test("[MUST-FAIL] every root says whether an answer is awaited: a person's ask does; a detector's gap and the walk's arm do not", async () => {
    const r = await fresh()
    await r.arm()
    const g = await gap(r, "g1", "open")
    const a = await r.ask("hello")
    const by = new Map((await r.episodes()).roots.map((x: any) => [x.root.id, x.awaits]))
    expect([by.get(g.id), by.get(a.id)]).toEqual([false, true])
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

  test("with no request open, the walk idles on its arm, as before", async () => {
    const r = await fresh()
    const arm = await r.arm()
    expect(await r.episode()).toContain(arm.id)
  })
})
