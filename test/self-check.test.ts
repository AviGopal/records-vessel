// SPDX-License-Identifier: MIT
// The self-check (self-check.ts): a composition's expectation must move at its next offer after its move failed, or was
// made again on its root with no act since its last choice. Unmoved files a gap about the composition; moved closes it.
// The real-row cases keep the rows' seqs, cells, moves and posteriors as the store held them; ids are hashes of a label,
// and a field the case does not turn on is filled where noted.
import { describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checker, compositionOf, gapIdOf, parityOf, selfCheck, unmoved } from "../src/self-check"
import type { Row } from "../src/store"

const W = "walk-a"
const id = (label: string): string => createHash("sha256").update(label).digest("hex")
const T = "2026-01-01T00:00:00.000Z"
type Post = { alpha: number; beta: number; from?: string }
// A treated selection of the walk choosing `a` at `cell` on root `root`, as the walk writes it before options carried
// their context: the chosen option's cell only.
const sel = (seq: number, a: string, cell: string, post: Post, root = "r1", more: Record<string, unknown> = {}): Row => ({
  shape: "selection", id: id(`sel${seq}`), seq, t: T, writer: W, role: "walk", input_refs: [], arm: "treated", root,
  a, cell, cands: [{ id: a, kind: a.split("/")[0], root }], posts: [post], posts_seq: seq - 1, ...more,
})
const fail = (seq: number, on: Row, more: Record<string, unknown> = {}): Row => ({
  shape: "failure", id: id(`fail${seq}`), seq, t: T, writer: W, role: "walk", input_refs: [], selection_ref: on.id, ...more,
})
const made = (seq: number, shape: string, by: Row, more: Record<string, unknown> = {}): Row => ({
  shape, id: id(`${shape}${seq}`), seq, t: T, writer: "described-a", role: "described", input_refs: [], selection_ref: by.id, ...more,
})
const credits = (seq: number): Row => ({
  shape: "credits", id: id(`credits${seq}`), seq, t: T, writer: "owner", role: "owner", input_refs: [], target: "selection",
  w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12,
})
const unmovedOf = (rows: Row[]) => selfCheck(rows).filter((f) => f.unmoved)

describe("compositions and what counts as moved", () => {
  test("[MUST-FAIL] a composition is its cell without the root's age; another read shape is another composition", () => {
    const a = compositionOf("call/code_verify_typecheck|request,asker:detector,age:12")
    expect(a).toBe("call/code_verify_typecheck|request,asker:detector")
    expect(compositionOf("call/code_verify_typecheck|request,asker:detector,age:3")).toBe(a)
    expect(compositionOf("call/code_verify_typecheck|gap,request,asker:detector,age:12")).not.toBe(a)
  })
  test("[MUST-FAIL] at one level only a debit (beta) moves it; across levels a mean that fell does", () => {
    expect(unmoved({ alpha: 2.5, beta: 2, from: "cell" }, { alpha: 3, beta: 2, from: "cell" })).toBe(true)
    expect(unmoved({ alpha: 2.5, beta: 2, from: "cell" }, { alpha: 2.5, beta: 3, from: "cell" })).toBe(false)
    expect(unmoved({ alpha: 3, beta: 2, from: "cell" }, { alpha: 3, beta: 2, from: "asker" })).toBe(true)
    expect(unmoved({ alpha: 3, beta: 2, from: "cell" }, { alpha: 3, beta: 2.5, from: "asker" })).toBe(false)
    // across levels the mean decides, where beta alone would say the opposite
    expect(unmoved({ alpha: 2, beta: 2, from: "cell" }, { alpha: 4, beta: 3, from: "asker" })).toBe(true)
    expect(unmoved({ alpha: 3, beta: 2, from: "cell" }, { alpha: 1, beta: 1.5, from: "asker" })).toBe(false)
  })
})

describe("a repeat: offered again on its root with no act since its last choice (real rows)", () => {
  test("[MUST-FAIL] a typecheck asked again with only explanations, requests and a refused repeat between, its expectation unchanged, files", () => {
    const tc = "call/code_verify_typecheck"
    const cell = `${tc}|request,asker:detector,age:12`
    const c = sel(156900, tc, cell, { alpha: 4.5, beta: 1, from: "cell" })
    // between: an explanation and a request drafted, and the walk refusing a call as changing nothing (a skip)
    const ae = sel(156904, "produce/attempt_explanation/tmpl01", "produce/attempt_explanation/tmpl01|gap,asker:detector,age:12", { alpha: 1.847, beta: 30.653, from: "cell" })
    const rq = sel(156910, "produce/request/x", "produce/request/x|gap,asker:detector,age:12", { alpha: 1.305, beta: 42.7, from: "cell" })
    const skip = fail(156905, sel(156902, tc, cell, { alpha: 4.5, beta: 1, from: "cell" }), { kind: "skip" })
    const s2 = sel(156947, tc, cell, { alpha: 4.5, beta: 1, from: "cell" })
    const found = unmovedOf([c, ae, rq, skip, s2])
    expect(found.map((f) => [f.trigger, f.composition, f.after.sel])).toContainEqual(["repeat", compositionOf(cell), s2.id])
  })
  test("[MUST-FAIL] an explanation drafted again after a refused read, at a younger age, files", () => {
    const a = "produce/attempt_explanation/dd19"
    const c = sel(158272, a, `${a}|attempt_explanation,gap,asker:detector,age:6`, { alpha: 1.802, beta: 7.698, from: "cell" })
    const read = sel(158300, "call/fs_read", "call/fs_read|request,asker:detector,age:6", { alpha: 3, beta: 2, from: "cell" })
    const s2 = sel(158399, a, `${a}|attempt_explanation,gap,asker:detector,age:7`, { alpha: 1.329, beta: 5.671, from: "cell" })
    const found = unmovedOf([c, read, fail(158305, read, { kind: "skip" }), s2])
    expect(found.map((f) => [f.trigger, f.after.sel])).toEqual([["repeat", s2.id]])
  })
  test("[MUST-FAIL] a template drafted again while credited (alpha up, beta fixed) files", () => {
    const a = "produce/activity_template/tmpl01"
    const c = sel(157969, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" })
    const s2 = sel(158148, a, `${a}|outcome,asker:detector,age:5`, { alpha: 3, beta: 2, from: "cell" })
    expect(unmovedOf([c, s2]).map((f) => f.trigger)).toEqual(["repeat"])
  })
  test("[MUST-FAIL] an edit that acted between two choices is an attempt: no repeat (and a refused one is not)", () => {
    const a = "produce/attempt_explanation/dd19"
    // the first choice's posterior was not read out; the second's is used for both, which the attempt makes moot
    const post = { alpha: 1.346, beta: 6.654, from: "cell" }
    const c = sel(158491, a, `${a}|attempt_explanation,gap,asker:detector,age:7`, post)
    const edit = sel(158500, "call/fs_edit", "call/fs_edit|request,asker:detector,age:7", { alpha: 2, beta: 1, from: "cell" })
    const s2 = sel(158524, a, `${a}|attempt_explanation,gap,asker:detector,age:7`, post)
    expect(unmovedOf([c, edit, s2])).toEqual([])
    expect(unmovedOf([c, edit, fail(158505, edit, { kind: "skip" }), s2]).map((f) => f.trigger)).toEqual(["repeat"])
  })
  test("[MUST-FAIL] a repeat whose expectation took a debit does not file", () => {
    const a = "produce/attempt_explanation/dd19"
    const c = sel(158524, a, `${a}|attempt_explanation,gap,asker:detector,age:7`, { alpha: 1.346, beta: 6.654, from: "cell" })
    const s2 = sel(158598, a, `${a}|attempt_explanation,gap,asker:detector,age:7`, { alpha: 1.346, beta: 7.654, from: "cell" })
    expect(selfCheck([c, s2]).map((f) => [f.trigger, f.unmoved])).toEqual([["repeat", false]])
  })
  test("[MUST-FAIL] only the walk's own selections are judged: the same choices written under another role file nothing", () => {
    const a = "produce/activity_template/tmpl01"
    const c = sel(10, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" }, "r1", { role: "described" })
    const s2 = sel(20, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" }, "r1", { role: "described" })
    expect(selfCheck([c, s2])).toEqual([])
    expect(unmovedOf([{ ...c, role: "walk" }, { ...s2, role: "walk" }]).map((f) => f.trigger)).toEqual(["repeat"])
  })
  test("[MUST-FAIL] an open gap read from another writer's row does not keep the detector from opening its own", () => {
    const a = "produce/activity_template/tmpl01"
    const k = compositionOf(`${a}|outcome,asker:detector,age:5`)
    const c = sel(10, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" })
    const s2 = sel(20, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" })
    const held = (writer: string) => ({ shape: "gap", id: id(`gap-${writer}`), seq: 15, t: T, writer, role: "detector", input_refs: [],
      gap_id: gapIdOf(k), status: "open", meta: { composition: k } }) as Row
    const opened = (writer: string) => {
      const chk = checker("records-self")
      const found = [c, held(writer), s2].flatMap((r) => chk.see(r))
      return chk.gapsOf(found).map((g) => g.status)
    }
    expect(opened("someone-else")).toEqual(["open"])
    expect(opened("records-self")).toEqual([])
  })
  test("[MUST-FAIL] a repeat is per root: the same composition chosen on another root is not its last choice", () => {
    const a = "produce/activity_template/tmpl01"
    const c = sel(10, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" }, "r2")
    const s2 = sel(20, a, `${a}|outcome,asker:detector,age:5`, { alpha: 2.5, beta: 2, from: "cell" }, "r1")
    expect(selfCheck([c, s2]).filter((f) => f.trigger === "repeat")).toEqual([])
  })
})

describe("a failure: owed to its own composition and up the chain (constructed)", () => {
  // A request drafted by R, a call X made for it, X failing: owed to X's composition (own) and R's (chain).
  const build = (opts: { kind?: string; window?: boolean; seqOfNext?: number; betaX?: number; betaR?: number } = {}) => {
    const r = sel(10, "produce/request/q", "produce/request/q|gap,asker:detector,age:1", { alpha: 2, beta: 2, from: "cell" })
    const q = made(11, "request", r)
    const x = sel(12, "call/fs_edit", "call/fs_edit|request,asker:detector,age:1", { alpha: 3, beta: 1, from: "cell" }, "r1", { from: q.id })
    const f = fail(13, x, { status: 422, ...(opts.kind !== undefined ? { kind: opts.kind } : {}) })
    const next = opts.seqOfNext ?? 20
    // the next draw offers both compositions, each option with its context (walk a93a08d)
    const s2: Row = {
      ...sel(next, "call/fs_edit", "call/fs_edit|request,asker:detector,age:2", { alpha: 3, beta: opts.betaX ?? 1, from: "cell" }),
      cands: [{ id: "call/fs_edit", kind: "call", root: "r1", ctx: "request,asker:detector,age:2" }, { id: "produce/request/q", kind: "produce", root: "r1", ctx: "gap,asker:detector,age:2" }],
      posts: [{ alpha: 3, beta: opts.betaX ?? 1, from: "cell" }, { alpha: 2, beta: opts.betaR ?? 2, from: "cell" }],
      posts_seq: next === 20 ? 19 : next - 1,
    }
    const w: Row[] = opts.window ? [{ shape: "infra_window", id: id("w"), seq: 15, t: T, writer: "owner", role: "owner", input_refs: [], window_id: "w", from_seq: 12, to_seq: 14, statuses: [422] }] : []
    return { rows: [credits(1), r, q, x, f, ...w, s2], r, x, f, s2 }
  }
  test("[MUST-FAIL] unmoved at the next offer: files on the failing call (own) and on the request's drafter (chain)", () => {
    const { rows, f } = build()
    const found = unmovedOf(rows).filter((g) => g.trigger === "failure")
    expect(found.map((g) => [g.composition, g.owed_as, g.failure_ref]).sort()).toEqual([
      ["call/fs_edit|request,asker:detector", "own", f.id],
      ["produce/request/q|gap,asker:detector", "chain", f.id],
    ])
  })
  test("[MUST-FAIL] a debit seen at the next offer files nothing for that composition", () => {
    const found = unmovedOf(build({ betaX: 2 }).rows).filter((g) => g.trigger === "failure")
    expect(found.map((g) => g.owed_as)).toEqual(["chain"])
  })
  test("[MUST-FAIL] a skip, or a failure inside the owner's infra window of its status, is owed to no one", () => {
    expect(unmovedOf(build({ kind: "skip" }).rows).filter((g) => g.trigger === "failure")).toEqual([])
    expect(unmovedOf(build({ window: true }).rows).filter((g) => g.trigger === "failure")).toEqual([])
  })
  test("[MUST-FAIL] a failure written by a writer other than its selection's is not the move's, and is owed to no one", () => {
    const { rows, f } = build()
    const other = rows.map((r) => (r.id === f.id ? { ...r, writer: "walk-b" } : r))
    expect(unmovedOf(other).filter((g) => g.trigger === "failure")).toEqual([])
  })
  test("[MUST-FAIL] an offer whose posteriors were read before the failure does not judge it; one read at it does", () => {
    const early = build({ seqOfNext: 14 })
    early.s2.posts_seq = 12
    expect(selfCheck(early.rows).filter((g) => g.trigger === "failure")).toEqual([])
    const at = build({ seqOfNext: 14 })
    at.s2.posts_seq = 13
    expect(selfCheck(at.rows).filter((g) => g.trigger === "failure").length).toBe(2)
  })
  test("[MUST-FAIL] the index kept as rows arrive is the fold's own over the same rows (parity)", () => {
    const { rows } = build()
    const schema: Row = { shape: "shape_schema", id: id("sch"), seq: 2, t: T, writer: "owner", role: "owner", input_refs: [], target: "request", inputs: ["gap"] }
    const outcome = made(16, "outcome", build().x)
    const { kept, built } = parityOf([...rows, schema, outcome])
    expect([...kept.byId.keys()].sort()).toEqual([...built.byId.keys()].sort())
    expect([...kept.sels.keys()].sort()).toEqual([...built.sels.keys()].sort())
    const ids = (m: Map<string, Row[]>) => [...m].map(([k, v]) => [k, v.map((r) => r.id)]).sort()
    expect(ids(kept.made)).toEqual(ids(built.made))
    expect([...kept.inputs].map(([k, v]) => [k, [...v].sort()]).sort()).toEqual([...built.inputs].map(([k, v]) => [k, [...v].sort()]).sort())
    expect([...kept.failed].sort()).toEqual([...built.failed].sort())
    expect(kept.failed.size).toBe(1)
  })
  test("[MUST-FAIL] a failure a later window excuses leaves the kept index's failed moves, as it is absent from the fold's", () => {
    const { rows } = build({ window: true })
    const { kept, built } = parityOf(rows)
    expect(built.failed.size).toBe(0)
    expect([...kept.failed]).toEqual([...built.failed])
  })
})

describe("what is judged, what is an act, and what a gap row is written for (constructed)", () => {
  const a = "produce/activity_template/tmpl01"
  const cell = `${a}|outcome,asker:detector,age:5`
  test("[GUARD] a moved finding on a composition never opened writes no row", () => {
    const chk = checker("records-self")
    const found = [sel(10, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), sel(20, a, cell, { alpha: 2.5, beta: 3, from: "cell" })].flatMap((r) => chk.see(r))
    expect(found.map((f) => [f.trigger, f.unmoved])).toEqual([["repeat", false]])
    expect(chk.gapsOf(found)).toEqual([])
  })
  test("[GUARD] a template run between two choices is an act: no repeat", () => {
    const c = sel(10, a, cell, { alpha: 2.5, beta: 2, from: "cell" })
    const run = sel(15, "run/tmpl02", "run/tmpl02|request,asker:detector,age:5", { alpha: 2, beta: 1, from: "cell" })
    const s2 = sel(20, a, cell, { alpha: 2.5, beta: 2, from: "cell" })
    expect(unmovedOf([c, run, s2])).toEqual([])
    expect(unmovedOf([c, s2]).map((f) => f.trigger)).toEqual(["repeat"])
  })
  test("[GUARD] only the treated arm's selections are judged: the same choices in another arm file nothing", () => {
    const c = sel(10, a, cell, { alpha: 2.5, beta: 2, from: "cell" }, "r1", { arm: "control" })
    const s2 = sel(20, a, cell, { alpha: 2.5, beta: 2, from: "cell" }, "r1", { arm: "control" })
    expect(selfCheck([c, s2])).toEqual([])
    expect(unmovedOf([{ ...c, arm: "treated" }, { ...s2, arm: "treated" }]).map((f) => f.trigger)).toEqual(["repeat"])
  })
  test("[GUARD] an option offered on two roots is chosen on the selection's own root", () => {
    const post = { alpha: 2.5, beta: 2, from: "cell" }
    const c: Row = { ...sel(10, a, cell, post, "r1"),
      cands: [{ id: a, kind: "produce", root: "r2", ctx: "outcome,asker:detector,age:5" }, { id: a, kind: "produce", root: "r1", ctx: "outcome,asker:detector,age:5" }],
      posts: [post, post] }
    const s2 = sel(20, a, cell, post, "r1")
    const repeats = selfCheck([c, s2]).filter((f) => f.trigger === "repeat")
    expect(repeats.map((f) => [f.before.sel, f.before.root, f.after.root, f.unmoved])).toEqual([[c.id, "r1", "r1", true]])
  })
  test("[GUARD] a failure judged at an offer leaves a later one pending for the offer that reads it", () => {
    const xc = "call/fs_edit|request,asker:detector,age:1"
    const x = sel(10, "call/fs_edit", xc, { alpha: 3, beta: 1, from: "cell" })
    const f1 = fail(11, x, { status: 422 })
    // a second edit offered with posteriors read before the first failure, so it judges nothing, and failing in turn
    const x2 = sel(12, "call/fs_edit", xc, { alpha: 3, beta: 1, from: "cell" }, "r1", { posts_seq: 10 })
    const f2 = fail(13, x2, { status: 422 })
    // read at the first failure only: it judges that one, and the second is still owed
    const s = sel(14, "call/fs_edit", xc, { alpha: 3, beta: 1, from: "cell" }, "r1", { posts_seq: 11 })
    const s3 = sel(20, "call/fs_edit", xc, { alpha: 3, beta: 1, from: "cell" })
    const judged = selfCheck([x, f1, x2, f2, s, s3]).filter((g) => g.trigger === "failure").map((g) => [g.failure_ref, g.after.sel])
    expect(judged).toEqual([[f1.id, s.id], [f2.id, s3.id]])
  })
})

describe("the gap row says where it repeated (constructed)", () => {
  test("[MUST-FAIL] a repeat offered by a selection that chose another root's option names the option's root, before and after", () => {
    const a = "call/fs_edit"
    const post = { alpha: 3, beta: 1, from: "cell" }
    const c = sel(10, a, `${a}|request,asker:detector,age:1`, post, "r1")
    // the walk chose a request on r2; the edit on r1 was offered again beside it
    const s2: Row = { ...sel(20, "produce/request/q", "produce/request/q|gap,asker:detector,age:1", { alpha: 2, beta: 2, from: "cell" }, "r2"),
      cands: [{ id: "produce/request/q", kind: "produce", root: "r2", ctx: "gap,asker:detector,age:1" }, { id: a, kind: "call", root: "r1", ctx: "request,asker:detector,age:2" }],
      posts: [{ alpha: 2, beta: 2, from: "cell" }, post] }
    const chk = checker("records-self")
    const rows = chk.gapsOf([c, s2].flatMap((r) => chk.see(r)))
    expect(rows.map((g) => [g.status, (g.meta as { before: { selection: string; root: string }; after: { selection: string; root: string } }).before,
      (g.meta as { after: { selection: string; root: string } }).after].map((x) => typeof x === "object" ? [x.selection, x.root] : x)))
      .toEqual([["open", [c.id, "r1"], [s2.id, "r1"]]])
  })
  test("[GUARD] a failure owed to a composition last offered unchosen on another root names that root before, and the judging offer's after", () => {
    const q = "produce/request/q"
    const r = sel(10, q, `${q}|gap,asker:detector,age:1`, { alpha: 2, beta: 2, from: "cell" }, "r1")
    const req = made(11, "request", r)
    // a read chosen on r3 offers the request again, unchosen, on r2: its last offer before the failure
    const y: Row = { ...sel(12, "call/fs_read", "call/fs_read|request,asker:detector,age:1", { alpha: 1, beta: 1, from: "cell" }, "r3"),
      cands: [{ id: "call/fs_read", kind: "call", root: "r3", ctx: "request,asker:detector,age:1" }, { id: q, kind: "produce", root: "r2", ctx: "gap,asker:detector,age:1" }],
      posts: [{ alpha: 1, beta: 1, from: "cell" }, { alpha: 2, beta: 2, from: "cell" }] }
    const x = sel(13, "call/fs_edit", "call/fs_edit|request,asker:detector,age:1", { alpha: 3, beta: 1, from: "cell" }, "r1", { from: req.id })
    const f = fail(14, x, { status: 422 })
    const s2: Row = { ...sel(20, "call/fs_edit", "call/fs_edit|request,asker:detector,age:2", { alpha: 3, beta: 1, from: "cell" }, "r1"),
      cands: [{ id: "call/fs_edit", kind: "call", root: "r1", ctx: "request,asker:detector,age:2" }, { id: q, kind: "produce", root: "r1", ctx: "gap,asker:detector,age:2" }],
      posts: [{ alpha: 3, beta: 1, from: "cell" }, { alpha: 2, beta: 2, from: "cell" }], posts_seq: 19 }
    const chk = checker("records-self")
    const rows = chk.gapsOf([credits(1), r, req, y, x, f, s2].flatMap((row) => chk.see(row)))
    const g = rows.find((row) => (row.meta as { composition: string }).composition === `${q}|gap,asker:detector`)
    const m = g?.meta as { trigger: string; before: { selection: string; root: string }; after: { selection: string; root: string } } | undefined
    expect([m?.trigger, m?.before.selection, m?.before.root, m?.after.selection, m?.after.root]).toEqual(["failure", y.id, "r2", s2.id, "r1"])
  })
})

describe("what closes a gap: only its composition's expectation moving (constructed)", () => {
  // each row seen in order, with every gap row the detector writes seen back as the store sees it
  const run = (rows: Row[]): Array<Record<string, unknown>> => {
    const chk = checker("records-self")
    const out: Array<Record<string, unknown>> = []
    let n = 1000
    for (const r of rows) {
      for (const g of chk.gapsOf(chk.see(r))) {
        out.push(g)
        chk.see({ ...g, id: id(`gap${n}`), seq: n++, t: T, writer: "records-self", role: "detector", input_refs: [] } as Row)
      }
    }
    return out
  }
  const a = "produce/activity_template/tmpl01"
  const cell = `${a}|outcome,asker:detector,age:5`
  const read = (seq: number): Row => sel(seq, "call/fs_read", "call/fs_read|outcome,asker:detector,age:5", { alpha: 1, beta: 1, from: "cell" })
  test("[MUST-FAIL] a repeat-opened gap stays open when the walk acted on the root since and the composition is offered again unmoved", () => {
    const rows = [sel(10, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), sel(20, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), read(30),
      sel(40, a, cell, { alpha: 2.5, beta: 2, from: "cell" })]
    expect(run(rows).map((g) => [g.status, (g.meta as { trigger: string }).trigger])).toEqual([["open", "repeat"]])
  })
  test("[MUST-FAIL] a later offer whose expectation took the debit closes it, and the close names the trigger that opened it", () => {
    const rows = [sel(10, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), sel(20, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), read(30),
      sel(40, a, cell, { alpha: 2.5, beta: 2, from: "cell" }), sel(50, a, cell, { alpha: 2.5, beta: 3, from: "cell" })]
    expect(run(rows).map((g) => [g.status, (g.meta as { trigger: string; opened_by?: string }).opened_by])).toEqual([["open", undefined], ["closed", "repeat"]])
  })
  test("[MUST-FAIL] a failure-opened gap closed by a moved repeat names the failure as what opened it", () => {
    const edit = "call/fs_edit"
    const r = sel(10, "produce/request/q", "produce/request/q|gap,asker:detector,age:1", { alpha: 2, beta: 2, from: "cell" })
    const q = made(11, "request", r)
    const x = sel(12, edit, `${edit}|request,asker:detector,age:1`, { alpha: 3, beta: 1, from: "cell" }, "r1", { from: q.id })
    const f = fail(13, x, { status: 422 })
    const rows = [credits(1), r, q, x, f, sel(20, edit, `${edit}|request,asker:detector,age:2`, { alpha: 3, beta: 1, from: "cell" }),
      sel(30, edit, `${edit}|request,asker:detector,age:3`, { alpha: 3, beta: 2, from: "cell" })]
    const mine = run(rows).filter((g) => (g.meta as { composition: string }).composition === `${edit}|request,asker:detector`)
    expect(mine.map((g) => [g.status, (g.meta as { trigger: string }).trigger, (g.meta as { opened_by?: string }).opened_by]))
      .toEqual([["open", "failure", undefined], ["closed", "repeat", "failure"]])
  })
})

describe("records writes the gap, as its own detector, once per change", () => {
  const dir = mkdtempSync(join(tmpdir(), "records-self-check-"))
  Object.assign(process.env, {
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
    RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
  })
  // removed when the process ends, not after this file: the store module is shared by every file the run loads, and the
  // first to load it keeps this directory as its own
  process.on("exit", () => rmSync(dir, { recursive: true, force: true }))
  test("[MUST-FAIL] a repeat opens one gap; another repeat writes nothing more; a debit closes it", async () => {
    const store = await import("../src/store")
    const a = "produce/activity_template/tmpl01"
    const put = (beta: number) => {
      const out = store.write({ shape: "selection", arm: "treated", root: "r9", a, cell: `${a}|outcome,asker:detector,age:5`,
        cands: [{ id: a, kind: "produce", root: "r9", ctx: "outcome,asker:detector,age:5" }], posts: [{ alpha: 2.5, beta, from: "cell" }], posts_seq: store.lastSeq() }, W, "walk")
      expect(out.status).toBe(200)
    }
    const gaps = () => store.read({ shape: "gap" }).filter((g) => g.gap_id === gapIdOf(compositionOf(`${a}|outcome,asker:detector,age:5`)))
    put(2)
    expect(gaps()).toEqual([])
    put(2)
    // the writer is records' own id, whichever file of the run loaded the store (and so its config) first
    const { VESSEL_ID } = await import("../src/config")
    expect(VESSEL_ID).not.toBe("")
    expect(gaps().map((g) => [g.status, g.role, g.writer])).toEqual([["open", "detector", VESSEL_ID]])
    put(2)
    expect(gaps().length).toBe(1)
    put(3)
    expect(gaps().map((g) => g.status)).toEqual(["open", "closed"])
  })

  test("[MUST-FAIL] the store's detector holds open only what records itself wrote: another writer's open row does not silence it", async () => {
    const store = await import("../src/store")
    const { VESSEL_ID } = await import("../src/config")
    const a = "produce/activity_template/tmpl02"
    const cell = `${a}|outcome,asker:detector,age:5`
    const k = compositionOf(cell)
    store.write({ shape: "gap", gap_id: gapIdOf(k), status: "open", category: "self_check", meta: { composition: k } }, "someone-else", "detector")
    const put = () => store.write({ shape: "selection", arm: "treated", root: "r8", a, cell, cands: [{ id: a, kind: "produce", root: "r8", ctx: "outcome,asker:detector,age:5" }],
      posts: [{ alpha: 2.5, beta: 2, from: "cell" }], posts_seq: store.lastSeq() }, W, "walk")
    put()
    put()
    expect(store.read({ shape: "gap" }).filter((g) => g.gap_id === gapIdOf(k)).map((g) => [g.writer, g.status]))
      .toEqual([["someone-else", "open"], [VESSEL_ID, "open"]])
  })

  // Each start is its own process, as a restart is: the store reads its rows once, when its module loads.
  const restarted = (data: string, betas: number[]): Array<[unknown, unknown]> => {
    const script = join(data, "start.ts")
    writeFileSync(script, `
      const store = await import(${JSON.stringify(join(import.meta.dir, "../src/store"))})
      const a = "produce/activity_template/tmpl01"
      for (const beta of ${JSON.stringify(betas)}) store.write({ shape: "selection", arm: "treated", root: "r9", a, cell: a + "|outcome,asker:detector,age:5",
        cands: [{ id: a, kind: "produce", root: "r9", ctx: "outcome,asker:detector,age:5" }], posts: [{ alpha: 2.5, beta, from: "cell" }], posts_seq: store.lastSeq() }, "walk-test", "walk")
      console.log(JSON.stringify(store.read({ shape: "gap" }).map((g) => [g.gap_id, g.status])))
    `)
    const r = Bun.spawnSync([process.execPath, script], { env: { ...process.env, RECORDS_DATA_DIR: join(data, "store") } })
    if (r.exitCode !== 0) throw new Error(r.stderr.toString())
    return JSON.parse(r.stdout.toString().trim().split("\n").at(-1) ?? "[]")
  }
  test("[MUST-FAIL] after a restart, a repeat of a choice made before it files, and a gap opened before it is not opened again", () => {
    const data = mkdtempSync(join(tmpdir(), "records-self-check-restart-"))
    try {
      const id = gapIdOf(compositionOf("produce/activity_template/tmpl01|outcome,asker:detector,age:5"))
      expect(restarted(data, [2])).toEqual([])
      expect(restarted(data, [2])).toEqual([[id, "open"]])
      expect(restarted(data, [2])).toEqual([[id, "open"]])
      expect(restarted(data, [3])).toEqual([[id, "open"], [id, "closed"]])
    } finally {
      rmSync(data, { recursive: true, force: true })
    }
  })
})
