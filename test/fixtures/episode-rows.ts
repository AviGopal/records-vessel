// SPDX-License-Identifier: MIT
// Stores for the episode read's tests (episode-scan.test.ts), in the forms rows take when written: each row is made as
// store.ts write() makes it (input_refs defaulted, a deadline's `at` from its within_ms, seq, t, writer, role, then the
// sha256 id over all of it), with t on a fixed clock, so the same builder gives the same rows, ids and all, every run.
// The walk's selections carry root, cell, arm, pool_refs, input_refs, cands, posts and posts_seq as the walk writes them.
import type { Row } from "../../src/store"

export const WALKER = "walk-1"
const T0 = Date.parse("2026-11-01T00:00:00.000Z")

type As = { writer: string; role: string }
const walk: As = { writer: WALKER, role: "walk" }
const other: As = { writer: "walk-2", role: "walk" }
const desc: As = { writer: "described-1", role: "described" }
const owner: As = { writer: "owner", role: "owner" }
const person: As = { writer: "kid-person", role: "person" }
const operator: As = { writer: "kid-operator", role: "operator" }
const detector: As = { writer: "pull-sync", role: "detector" }

const store = () => {
  const rows: Row[] = []
  const add = (body: Record<string, unknown>, as: As): Row => {
    const seq = rows.length + 1
    const t = new Date(T0 + seq * 1000).toISOString()
    const deadline = typeof body.within_ms === "number" ? { at: Date.parse(t) + body.within_ms } : {}
    const unsigned = { input_refs: [], ...body, ...deadline, seq, t, writer: as.writer, role: as.role }
    const id = new Bun.CryptoHasher("sha256").update(JSON.stringify(unsigned)).digest("hex")
    const row = { ...unsigned, shape: String(body.shape), id } as Row
    rows.push(row)
    return row
  }
  // The walk's selection as it writes one: the root it works, the pool it chose from (an older selection carries the
  // whole pool there), the cell, its candidates and the posterior it read.
  const select = (root: string, pool: unknown, as: As = walk, more: Record<string, unknown> = {}): Row =>
    add({
      shape: "selection", arm: "treated", cell: `call/fs_read|asker:person`, a: "call/fs_read", root,
      pool_refs: pool, input_refs: Array.isArray(pool) ? pool : [],
      cands: [{ id: "fs_read", kind: "call", root }], posts: [{ alpha: 1, beta: 1, from: 0 }], posts_seq: rows.length, ...more,
    }, as)
  const hop = (sel: Row, call: string, phase: "started" | "ended", type: string, more: Record<string, unknown> = {}, as: As = walk): Row =>
    add({ shape: "hop", phase, call_id: call, pointer_type: type, kind: "call", selection_ref: sel.id, ...(phase === "ended" ? { output: { ok: true, call } } : {}), ...more }, as)
  return { rows, add, select, hop }
}

const owners = (add: ReturnType<typeof store>["add"]): void => {
  add({ shape: "arm", vessel_id: WALKER, arm: "treated", as_of_seq: 1e9 }, owner)
  add({ shape: "channel", name: "answer", to: "person" }, owner)
  add({ shape: "shape_schema", target: "answer", version: 1, fields: { text: "string" } }, owner)
  add({ shape: "credits", target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }, owner)
  add({ shape: "requires", call: "git_land", needs: "gitDiff" }, owner)
  add({ shape: "repository", repo: "records-vessel", units: ["records"], roles: ["walk"], retired: false }, owner)
}

// Requests worked across one another: selections citing two roots, another walker's selections, hops citing another
// root, a person's mark on a diff and a word on that mark, a request a person closed, an earned and a scheduled
// template, a stall failure, lists that are not lists, a row the file holds twice, and another walker's rows under
// this walker's selection.
export const mixed = (): Row[] => {
  const { rows, add, select, hop } = store()
  owners(add)
  const a = add({ shape: "world_changed", what: "make a change" }, person)
  const d = add({ shape: "world_changed", what: "an operator's ask" }, operator)
  const s1 = select(a.id, [a.id])
  const b = add({ shape: "world_changed", what: "another change" }, person)
  // written before the walk kept only its root: the whole pool, two roots in it
  const s2 = select(a.id, [a.id, b.id, d.id, rows[1]!.id])
  const c1 = hop(s1, "c1", "started", "fs_read")
  const s3 = select(a.id, [a.id], other)
  hop(s3, "o1", "started", "fs_read", {}, other)
  add({ shape: "answer", text: "another walker's answer", selection_ref: s3.id, input_refs: [a.id] }, desc)
  const s4 = select(b.id, [b.id])
  const c1e = hop(s1, "c1", "ended", "fs_read")
  // a hop under b's selection that cites a's ask in its own refs
  hop(s4, "c2", "started", "git_diff", { input_refs: [a.id] })
  const diff = add({ shape: "gitDiff", diff: "--- a\n+++ b", selection_ref: s4.id }, walk)
  hop(s4, "c2", "ended", "git_diff")
  const mark = add({ shape: "land_verdict", r: 1, input_refs: [diff.id] }, person)
  // a person's word on the mark only: not b's (a person's row joins a root by citing the root's rows, not another person row)
  add({ shape: "note", text: "about that mark", input_refs: [mark.id] }, person)
  const ans = add({ shape: "answer", text: "I made the change", selection_ref: s1.id, input_refs: [a.id] }, desc)
  add({ shape: "due", within_ms: 3_600_000, selection_ref: s1.id, input_refs: [a.id] }, desc)
  const judge = select(a.id, [a.id, ans.id])
  add({ shape: "outcome", r: 1, selection_ref: judge.id, event_ref: a.id, input_refs: [a.id, ans.id] }, desc)
  const c = add({ shape: "world_changed", what: "a request a person closes" }, person)
  const s6 = select(c.id, [c.id])
  hop(s6, "c3", "started", "fs_read")
  hop(s2, "c4", "started", "fs_read")
  hop(s6, "c3", "ended", "fs_read")
  hop(s2, "c4", "ended", "fs_read")
  const cAns = add({ shape: "answer", text: "done", selection_ref: s6.id, input_refs: [c.id] }, desc)
  add({ shape: "outcome", r: 1, input_refs: [cAns.id] }, person)
  const tpl = add({ shape: "activity_template", name: "read-then-answer", calls: [{ shape: "fs_read" }], selection_ref: s6.id }, desc)
  const tpl2 = add({ shape: "activity_template", name: "nightly", calls: [{ shape: "fs_read" }] }, owner)
  add({ shape: "rhythm", template: tpl2.id, every_ms: 86_400_000 }, owner)
  add({ shape: "rhythm", template: tpl.id, every_ms: 3_600_000, retired: true }, owner)
  add({ shape: "hold_fact", reason_prefix: "no source frame", fact: { edit_site: "unknown" } }, owner)
  // the walk said b sat with no move: about the root itself, no selection_ref
  add({ shape: "failure", kind: "stall", root: b.id, selections: 60, since_seq: 3, input_refs: [b.id], blames: "walk" }, walk)
  add({ shape: "failure", status: 422, call_id: "c5", selection_ref: s4.id, blames: "request" }, walk)
  // a selection whose pool_refs is a string, and one with none: what counts as citing differs between readers
  const s7 = select(a.id, a.id, walk, { input_refs: [] })
  hop(s7, "c6", "started", "fs_read")
  const s8 = select(b.id, undefined, walk, { input_refs: [b.id] })
  hop(s8, "c7", "started", "fs_read")
  add({ shape: "note", text: "looks right", input_refs: [ans.id] }, person)
  // a row the file holds twice
  rows.push(c1e)
  void c1
  const s9 = select(d.id, [d.id])
  add({ shape: "answer", text: "for the operator", selection_ref: s9.id, input_refs: [d.id] }, desc)
  add({ shape: "outcome", r: 0, input_refs: [ans.id] }, operator)
  // another walker's rows under this walker's selection: neither is this walker's root's
  hop(s1, "o2", "started", "fs_read", {}, other)
  add({ shape: "gitDiff", diff: "+y", selection_ref: s1.id }, other)
  // a template a described writer made under a's selection: a template, so not a's
  add({ shape: "activity_template", name: "change-then-answer", calls: [{ shape: "fs_read" }], selection_ref: s1.id }, desc)
  // a failure of a move under b's selection that cites a's ask: b's by its move, not a's by its refs
  add({ shape: "failure", status: 422, call_id: "c8", selection_ref: s4.id, input_refs: [a.id], blames: "request" }, walk)
  // another walker said a sat with no move: not this walker's
  add({ shape: "failure", kind: "stall", root: a.id, selections: 60, since_seq: 3, input_refs: [a.id], blames: "walk" }, other)
  // a selection that cites no root, written as a follow-on to a's selection: it is held by what it cites, not by its selection_ref
  select(rows[1]!.id, [rows[1]!.id], walk, { selection_ref: s1.id })
  return rows
}

// Gaps a detector wrote: one written again while open, closed and opened again, one held, one held under a reason the
// owner reads as a fact, one a person said has a wrong test, one no change could fix, one the walk stalled on, one
// whose gap_id was written as a number and again as a string, and an ask beside them.
export const gaps = (): Row[] => {
  const { rows, add, select, hop } = store()
  owners(add)
  const g1a = add({ shape: "gap", gap_id: "g1", status: "open", summary: "test fails" }, detector)
  const t1 = select(g1a.id, [g1a.id])
  hop(t1, "h1", "started", "fs_read")
  const g1b = add({ shape: "gap", gap_id: "g1", status: "open", summary: "test still fails" }, detector)
  const t2 = select(g1b.id, [g1b.id])
  hop(t1, "h1", "ended", "fs_read")
  const ask = add({ shape: "world_changed", what: "beside the gaps" }, person)
  select(ask.id, [ask.id, g1a.id])
  add({ shape: "gap", gap_id: "g1", status: "closed", summary: "passes" }, detector)
  hop(t2, "h2", "started", "fs_read")
  add({ shape: "gap", gap_id: "g2", status: "open", operator_hold: true, operator_hold_reason: "a person asked to wait" }, detector)
  add({ shape: "hold_fact", reason_prefix: "no source frame", fact: { edit_site: "find it with tools" } }, owner)
  const g3 = add({ shape: "gap", gap_id: "g3", status: "open", meta: { operator_hold: true, operator_hold_reason: "no source frame names the site" } }, detector)
  select(g3.id, [g3.id])
  add({ shape: "gap", gap_id: "g4", status: "open", check_runnable: false }, detector)
  add({ shape: "gap", gap_id: "g5", status: "open", walkable: false }, detector)
  const g6a = add({ shape: "gap", gap_id: "g6", status: "open" }, detector)
  const u1 = select(g6a.id, [g6a.id, g1b.id])
  hop(u1, "h3", "started", "git_diff")
  add({ shape: "gitDiff", diff: "+x", selection_ref: u1.id }, walk)
  add({ shape: "failure", kind: "stall", root: g6a.id, selections: 60, since_seq: 1, input_refs: [g6a.id], blames: "walk" }, walk)
  const g1d = add({ shape: "gap", gap_id: "g1", status: "open", summary: "fails again" }, detector)
  const t3 = select(g1d.id, [g1d.id, g1a.id])
  hop(t3, "h4", "started", "fs_edit")
  add({ shape: "gap", gap_id: "g6", status: "open", summary: "written again" }, detector)
  add({ shape: "note", text: "this gap again", input_refs: [g1d.id] }, person)
  add({ shape: "answer", text: "fixed it", selection_ref: t3.id, input_refs: [g1d.id] }, desc)
  const g7 = add({ shape: "gap", gap_id: 7, status: "open" }, detector)
  select(g7.id, [g7.id])
  add({ shape: "gap", gap_id: "7", status: "open", summary: "as a string" }, detector)
  hop(t3, "h4", "ended", "fs_edit")
  add({ shape: "gap", gap_id: "g6", status: "closed" }, detector)
  add({ shape: "gap", gap_id: "g2", status: "open", summary: "hold lifted" }, detector)
  // a gap row the walk wrote under g2's gap_id, then the detector's again: only the detector's rows are g2's episode
  add({ shape: "gap", gap_id: "g2", status: "closed", summary: "the walk's own word" }, walk)
  add({ shape: "gap", gap_id: "g2", status: "open", summary: "still fails" }, detector)
  // g8 written twice, then its first row again (a row the file holds twice): the copy is g8's latest row, so the root,
  // and the row written after it in the file but with a higher seq is not in its episode
  const g8a = add({ shape: "gap", gap_id: "g8", status: "open" }, detector)
  add({ shape: "gap", gap_id: "g8", status: "open", summary: "written again" }, detector)
  rows.push(g8a)
  return rows
}

// Nothing open: the walk idles on its newest arm.
export const idle = (): Row[] => {
  const { rows, add, select, hop } = store()
  owners(add)
  add({ shape: "arm", vessel_id: "walk-other", arm: "treated" }, owner)
  const a = add({ shape: "world_changed", what: "closed soon" }, person)
  const s = select(a.id, [a.id])
  hop(s, "i1", "started", "fs_read")
  hop(s, "i1", "ended", "fs_read")
  const ans = add({ shape: "answer", text: "here", selection_ref: s.id, input_refs: [a.id] }, desc)
  add({ shape: "outcome", r: 1, input_refs: [ans.id] }, person)
  add({ shape: "arm", vessel_id: WALKER, arm: "treated", as_of_seq: 2e9 }, owner)
  return rows
}

// One request worked, `history` requests worked and closed by a person, and `extra` asks open beside it that no one has
// worked: the store is the same but for the extra asks, so what a read costs per row should not move with them.
export const wide = (history: number, extra: number): Row[] => {
  const { rows, add, select, hop } = store()
  owners(add)
  for (let i = 0; i < history; i++) {
    const a = add({ shape: "world_changed", what: `old ${i}` }, person)
    const s = select(a.id, [a.id])
    hop(s, `w${i}`, "started", "fs_read")
    hop(s, `w${i}`, "ended", "fs_read")
    const ans = add({ shape: "answer", text: `answer ${i}`, selection_ref: s.id, input_refs: [a.id] }, desc)
    add({ shape: "outcome", r: 1, input_refs: [ans.id] }, person)
  }
  const a = add({ shape: "world_changed", what: "the one worked" }, person)
  const s = select(a.id, [a.id])
  hop(s, "now", "started", "fs_read")
  for (let i = 0; i < extra; i++) add({ shape: "world_changed", what: `unworked ${i}` }, person)
  hop(s, "now", "ended", "fs_read")
  add({ shape: "answer", text: "working", selection_ref: s.id, input_refs: [a.id] }, desc)
  return rows
}

// The walk's selection with every key its selectionRow writes (walk-vessel src/loop.ts): the draw's candidates and their
// posteriors (from a string), the posterior's seq, the seed, the move and its cell, the root alone in pool_refs, and the
// tick's timing. `drop` leaves keys out, as an older walk wrote selections (no timing).
const options = (root: string, n: number) => Array.from({ length: n }, (_, k) =>
  k % 3 === 0 ? { id: `produce/answer/${"c".repeat(64)}`, kind: "produce", root } : k % 3 === 1 ? { id: `call/fs_read${k}`, kind: "call", root } : { id: `run/${String(k).repeat(64).slice(0, 64)}`, kind: "run", root })
const realSelection = (add: ReturnType<typeof store>["add"], root: string, n: number, as: As = walk, drop: string[] = [], more: Record<string, unknown> = {}): Row => {
  const cands = options(root, n)
  const body: Record<string, unknown> = {
    shape: "selection", arm: "treated", cands,
    posts: cands.map((_c, k) => ({ alpha: 1 + k * 0.1 + 0.0000000000000006, beta: 2.43, from: k % 2 === 0 ? "cell" : "move" })),
    posts_seq: 1000 + n, seed: 3141592653, a: cands[0]!.id, from: "move",
    cell: `${cands[0]!.id}|world_changed,asker:person,age:0`, context: ["world_changed", "asker:person", "age:0"], cell_scheme: "reads",
    root, pool_refs: [root], seen_key: "k".repeat(64),
    timing: { episodes_ms: 1780, episodes_reads: 1, choices_ms: 40, posterior_ms: 12, posterior_reads: 1, draw_ms: 0, cands: n, cells: n },
    ...more,
  }
  for (const k of drop) delete body[k]
  return add(body, as)
}

// Requests worked by the walk as it writes its selections today: real-form selections on an ask, an operator's ask and
// a held gap, one written before timing was kept, another walker's, one a schema refusal cites, an answer, a grade, a
// deadline still ahead, and the walk's own hops and failures beside them.
export const walked = (): Row[] => {
  const { rows, add, hop } = store()
  owners(add)
  add({ shape: "hold_fact", reason_prefix: "no source frame", fact: { edit_site: "find it with tools" } }, owner)
  const a = add({ shape: "world_changed", what: "make a change" }, person)
  const d = add({ shape: "world_changed", what: "an operator's ask" }, operator)
  const s1 = realSelection(add, a.id, 7)
  hop(s1, "w1", "started", "fs_read")
  const old = realSelection(add, a.id, 4, walk, ["timing"])
  const theirs = realSelection(add, a.id, 5, other)
  hop(s1, "w1", "ended", "fs_read")
  const ans = add({ shape: "answer", text: "I made the change", selection_ref: s1.id, input_refs: [a.id] }, desc)
  add({ shape: "due", within_ms: 1e12, selection_ref: s1.id, input_refs: [a.id] }, desc)
  const refused = realSelection(add, a.id, 3)
  add({ shape: "failure", status: 422, refused: "schema", selection_ref: refused.id, input_refs: [refused.id] }, walk)
  const judge = realSelection(add, a.id, 6, walk, [], { a: "produce/outcome/x" })
  add({ shape: "outcome", r: 1, selection_ref: judge.id, event_ref: a.id, input_refs: [a.id, ans.id] }, desc)
  const sd = realSelection(add, d.id, 2)
  add({ shape: "failure", kind: "skip", unserved: ["fs_read"], template_ref: "t1", selection_ref: sd.id, input_refs: [sd.id, "t1"] }, walk)
  const g = add({ shape: "gap", gap_id: "g1", status: "open", meta: { operator_hold: true, operator_hold_reason: "no source frame names the site" } }, detector)
  const sg = realSelection(add, g.id, 4)
  hop(sg, "w2", "started", "git_diff")
  add({ shape: "failure", kind: "stall", root: d.id, rows: 50, since_seq: 3, input_refs: [d.id] }, walk)
  realSelection(add, g.id, 2, other)
  // templates a rhythm schedules, so every root is given them (shared): one the walker wrote itself, under its own name as
  // writer, and one a producer wrote
  const own = add({ shape: "activity_template", name: "read-then-answer", calls: [{ shape: "fs_read" }], selection_ref: s1.id }, { writer: WALKER, role: "described" })
  const theirsT = add({ shape: "activity_template", name: "nightly", calls: [{ shape: "fs_read" }], selection_ref: s1.id }, desc)
  add({ shape: "rhythm", template: own.id, every_ms: 3_600_000 }, owner)
  add({ shape: "rhythm", template: theirsT.id, every_ms: 86_400_000 }, owner)
  void old
  void theirs
  return rows
}

export const FIXTURES: Record<string, () => Row[]> = { mixed, gaps, idle, walked }
