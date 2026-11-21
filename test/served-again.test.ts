// SPDX-License-Identifier: MIT
// A shape served again is a detector's row ({served: <shape>}). It is a root's when the root holds a failure of the walk's
// that named that shape unserved before it, and it ends a wait of that walk's: the recovery of what held the root's
// moves, seen where it held them. It grades nothing: the fold gives every cell, grade and tally the same with it as
// without it.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Row } from "../src/store"

const dir = mkdtempSync(join(tmpdir(), "records-served-again-"))
Object.assign(process.env, {
  RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
  RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
})
const store = await import("../src/store")
const { foldFrom, fresh, standing, tally } = await import("../src/fold")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const W = "walk-test"
const put = (shape: string, role: string, fields: Record<string, unknown> = {}, writer = `${role}-test`): string => {
  const out = store.write({ shape, ...fields }, writer, role)
  expect(out.status).toBe(200)
  return (out.body as { id: string }).id
}
// an open gap, a selection of the walk's working it, and that selection's produce going unserved on llm_completion
const gap = put("gap", "detector", { gap_id: "g-held", status: "open", category: "failing_test" })
const sel = put("selection", "walk", { pool_refs: [gap], input_refs: [gap], root: gap }, W)
put("failure", "walk", { selection_ref: sel, status: 404, unserved: "llm_completion" }, W)

// the wait as the walk sends it, through the pointer record_wait's handler reads
const waitOf = (episode: string | undefined) => {
  let got: Row | null | undefined
  const p = store.waitAsked({ shapes: [], after_seq: store.lastSeq(), ...(episode === undefined ? {} : { episode }) }).then((r) => { got = r })
  return { p, ended: async () => { await Bun.sleep(0); return got } }
}
const rowsOfRoot = (): string[] => store.episodes(W).roots.find((r) => r.root.id === gap)?.rows.map((r) => r.id) ?? []

describe("a shape served again", () => {
  test("[GUARD] a detector's row served again on another shape is no root's and ends no wait; nor does a served row of another role", async () => {
    const w = waitOf(W)
    const other = put("shape_served", "detector", { served: "git_diff" })
    const walks = put("shape_served", "walk", { served: "llm_completion" }, W)
    // the walk's own row under the root's selection is the root's, and is no observation: it ends nothing
    const hop = put("hop", "walk", { selection_ref: sel, phase: "started", call_id: "c-own" }, W)
    expect(rowsOfRoot()).toContain(hop)
    expect(await w.ended()).toBeUndefined()
    expect(rowsOfRoot()).not.toContain(other)
    expect(rowsOfRoot()).not.toContain(walks)
    put("world_changed", "person")
    await w.p
  })

  test("[MUST-FAIL] served again on the shape the root's failure named: the root is shown it, and it ends the walk's wait", async () => {
    const w = waitOf(W)
    const id = put("shape_served", "detector", { served: "llm_completion" })
    expect(await w.ended()).toMatchObject({ id, served: "llm_completion" })
    expect(rowsOfRoot()).toContain(id)
  })

  test("[GUARD] a wait that names no walk is not ended by it, and a walk with no failure on that shape is not shown it", async () => {
    const anon = waitOf(undefined)
    const stranger = waitOf("walk-other")
    put("shape_served", "detector", { served: "llm_completion" })
    expect(await anon.ended()).toBeUndefined()
    expect(await stranger.ended()).toBeUndefined()
    put("world_changed", "person")
    await Promise.all([anon.p, stranger.p])
  })

  test("[GUARD] a failure after the served row does not draw it in: only a recovery after the shape went unserved is the root's", () => {
    const early = put("shape_served", "detector", { served: "described_shape" })
    put("failure", "walk", { selection_ref: sel, status: 404, unserved: "described_shape" }, W)
    expect(rowsOfRoot()).not.toContain(early)
  })

  test("[MUST-FAIL] a recovery between two failures on the shape is the root's: it came after the shape first went unserved", async () => {
    put("failure", "walk", { selection_ref: sel, status: 404, unserved: "tool_a" }, W)
    const w = waitOf(W)
    const id = put("shape_served", "detector", { served: "tool_a" })
    expect(await w.ended()).toMatchObject({ id })
    put("failure", "walk", { selection_ref: sel, status: 404, unserved: "tool_a" }, W)
    expect(rowsOfRoot()).toContain(id)
  })

  test("[GUARD] a failure on the root that is not this walk's own does not draw a served row in", async () => {
    // a person's row citing the root's selection is the root's; one naming a shape unserved is not this walk's failure
    const theirs = put("failure", "person", { unserved: "tool_b", input_refs: [sel] })
    expect(rowsOfRoot()).toContain(theirs)
    const w = waitOf(W)
    const id = put("shape_served", "detector", { served: "tool_b" })
    expect(await w.ended()).toBeUndefined()
    expect(rowsOfRoot()).not.toContain(id)
    put("world_changed", "person")
    await w.p
  })

  test("[GUARD] the root stays open: a served row closes nothing", () => {
    expect(store.episodes(W).roots.map((r) => r.root.id)).toContain(gap)
  })
})

describe("the fold does not read it", () => {
  // A request answered, graded by a person, a promise kept, a move that failed unserved, and the selection after the
  // recovery citing the served row in its pool and its inputs, as the walk will once it is shown the row.
  let seq = 0
  const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
    ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
  const CELL = "produce/answer/ch1|world_changed,did:none,asker:person,age:0"
  const CALL = "call/fs_edit|request,did:none,asker:person,age:0"
  const build = (served: boolean): Row[] => {
    seq = 0
    const rows: Row[] = []
    const add = (r: Row): Row => { rows.push(r); return r }
    add(row("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4, w_check: 0.5, promise_window: 3 }))
    add(row("requires", "owner", { for: "fs_edit", needs: "change_wanted", where: { wanted: true } }))
    const ask = add(row("world_changed", "person", { what: "make the message box 10 lines" }))
    add(row("change_wanted", "described", { wanted: true, repo: "human-surface-vessel", input_refs: [ask.id] }))
    const s0 = add(row("selection", "walk", { arm: "treated", cell: CELL, root: ask.id, a: "produce/answer/ch1" }))
    add(row("failure", "walk", { selection_ref: s0.id, status: 404, unserved: "llm_completion", input_refs: [ask.id] }))
    const back = served ? add(row("shape_served", "detector", { served: "llm_completion" })) : undefined
    const s1 = add(row("selection", "walk", { arm: "treated", cell: CELL, root: ask.id, a: "produce/answer/ch1",
      pool_refs: [ask.id, ...(back ? [back.id] : [])], input_refs: [ask.id, ...(back ? [back.id] : [])] }))
    const answer = add(row("answer", "described", { selection_ref: s1.id, input_refs: [ask.id, ...(back ? [back.id] : [])], text: "I will edit src/limits.ts next.",
      next_act: { tool: "fs_edit", target: "src/limits.ts" } }))
    const req = add(row("request", "described", { pointer: { type: "fs_edit", path: "src/limits.ts" }, input_refs: [ask.id] }))
    const s2 = add(row("selection", "walk", { arm: "treated", cell: CALL, root: ask.id, a: "call/fs_edit", from: req.id }))
    add(row("hop", "walk", { selection_ref: s2.id, call_id: `c${seq}`, phase: "started", kind: "call", pointer_type: "fs_edit" }))
    add(row("outcome", "person", { r: 1, input_refs: [answer.id] }))
    return rows
  }
  // Seqs differ by the one row, so each grade is compared by what it judged, as rows of the same build stand in order.
  const ids = (rows: Row[]) => new Map(rows.map((r) => [r.id, `${r.shape}#${rows.filter((x) => x.shape === r.shape).indexOf(r)}`]))
  const same = (rows: Row[]) => {
    const name = ids(rows)
    // an id may stand inside a string (a grade's key), so each is put by its name wherever it stands
    const named = (x: string): string => x.replace(/[a-z_]+-\d+/g, (id) => name.get(id) ?? id)
    const norm = (v: unknown): unknown => JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === "string" ? named(x) : x)))
    const g = Object.fromEntries(Object.entries(fresh).map(([k, f]) => [k, norm((f as (a: Row[], b: number, c: number) => unknown)(rows, 1e9, 1e9))]))
    return { ...g, standing: norm(standing(rows, 1e9, 1e9)), tally: norm(tally(rows, 1e9, 1e9)), posts: norm(foldFrom(rows, [CELL, CALL], 1e9, 1e9)) }
  }

  test("[GUARD] every grade, the standing grades, the tally and the posteriors are the same with the served row as without it", () => {
    const without = same(build(false))
    expect((without as { grades: unknown[] }).grades.length + (without as { promiseGrades: unknown[] }).promiseGrades.length).toBeGreaterThan(0)
    expect(same(build(true))).toEqual(without)
  })
})

// Last in the file: a wait_bound row stays in the store, and the waits above are held with none.
const status = (shape: string, role: string, fields: Record<string, unknown> = {}): number => store.write({ shape, ...fields }, `${role}-test`, role).status
const waitFor = (deadline?: number) => {
  let got: unknown = "pending"
  const p = store.waitAsked({ shapes: [], after_seq: store.lastSeq(), episode: "walk-test", ...(deadline === undefined ? {} : { until: deadline }) }).then((r) => { got = r })
  return { p, now: () => got }
}

describe("the owner's bound on a wait", () => {
  test("[GUARD] with no wait_bound row a wait is held until a row answers it", async () => {
    const w = waitFor()
    await Bun.sleep(60)
    expect(w.now()).toBe("pending")
    status("world_changed", "person")
    await w.p
    expect(w.now()).toMatchObject({ shape: "world_changed" })
  })

  test("[MUST-FAIL] only the owner writes it, and it wakes no wait: it is configuration", async () => {
    expect(status("wait_bound", "person", { within_ms: 1 })).toBe(403)
    const w = waitFor()
    expect(status("wait_bound", "owner", { within_ms: 100000 })).toBe(200)
    await Bun.sleep(20)
    expect(w.now()).toBe("pending")
    status("world_changed", "person")
    await w.p
  })

  test("[MUST-FAIL] at the latest wait_bound a wait nothing answers is answered null", async () => {
    status("wait_bound", "owner", { within_ms: 30 })
    const w = waitFor()
    await Bun.sleep(10)
    expect(w.now()).toBe("pending")
    await Bun.sleep(80)
    expect(w.now()).toBeNull()
  })

  test("[GUARD] a caller's deadline before the bound ends it first; a row before either answers it", async () => {
    const t0 = Date.now()
    const early = waitFor(Date.now() + 5)
    await early.p
    expect([early.now(), Date.now() - t0 < 30]).toEqual([null, true])
    const answered = waitFor()
    status("world_changed", "person")
    await answered.p
    expect(answered.now()).toMatchObject({ shape: "world_changed" })
  })

  for (const within_ms of ["30", 0, -1]) {
    test(`[GUARD] a wait_bound that is not a positive number (${JSON.stringify(within_ms)}) bounds nothing: no wait is answered at once`, async () => {
      status("wait_bound", "owner", { within_ms })
      const w = waitFor()
      await Bun.sleep(80)
      expect(w.now()).toBe("pending")
      status("world_changed", "person")
      await w.p
    })
  }
})
