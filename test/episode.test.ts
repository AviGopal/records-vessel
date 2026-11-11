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
  return { write, episode, episodes, lapsed, ask, arm, select }
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

  test("with no request open, the walk idles on its arm, as before", async () => {
    const r = await fresh()
    const arm = await r.arm()
    expect(await r.episode()).toContain(arm.id)
  })
})
