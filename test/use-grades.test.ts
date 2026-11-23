// SPDX-License-Identifier: MIT
// A move's output that another move takes as input earns; one nobody takes costs, at the owner's w_check: used within
// the owner's promise_window → r 1, once per request and move; each selection whose output nobody took within it → its
// own r 0, which a later use does not undo, when a consumer of it was offered within the window (a later selection's
// frontier was its row, with calls that take it); with none offered, no grade. The rows here are the shapes the walk, described-shape and the owner write.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

const RUN_CELL = "run/tmpl|request,asker:person,age:0"
const PLAN_CELL = "produce/plan/ch1|request,asker:person,age:0"
const NOTE_CELL = "produce/note/ch1|plan,asker:person,age:0"
const CALL_CELL = "call/fs_read|request,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4, w_check: 0.5, promise_window: 3 }

// The use grades of the rows (none where the fold has no use grade), and a cell's posterior.
const use = (rows: Row[], asOf = 1e9): Array<[number, string]> =>
  (((F as Record<string, unknown>).useGrades as typeof F.useGrades | undefined)?.(rows, asOf, 1e9) ?? []).map((g) => [g.r, [...g.cells][0]!])
const post = (rows: Row[], cell: string) => F.foldFrom(rows, [cell], 1e9, 1e9)[0]

const offerOf = (out: Row) => ({ frontier: { id: out.id, shape: out.shape }, calls: ["git_commit"] })

const build = (credits: Record<string, unknown> = CREDITS) => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", credits))
  // a plan takes a run's tool answer (gitDiff), another plan or a note as inputs; a note takes a plan
  add(row("shape_schema", "owner", { target: "plan", inputs: ["gitDiff", "plan", "note"] }))
  add(row("shape_schema", "owner", { target: "note", inputs: ["plan"] }))
  const ask = add(row("world_changed", "person", { what: "show the diff" }))
  const tmpl = add(row("activity_template", "described", { id: "tmpl", calls: [{ shape: "gitDiff" }] }))
  const sel = (a: string, cell: string, fields: Record<string, unknown> = {}) =>
    add(row("selection", "walk", { arm: "treated", cell, root: ask.id, a, ...fields }))
  // a run of the template and the tool answer it wrote
  const run = (fields: Record<string, unknown> = {}) => {
    const s = sel(`run/${tmpl.id}`, RUN_CELL, fields)
    const out = add(row("gitDiff", "walk", { selection_ref: s.id }))
    return { s, out }
  }
  // a produce of a plan citing the given rows
  const plan = (refs: Row[], cell = PLAN_CELL, fields: Record<string, unknown> = {}) => {
    const s = sel("produce/plan/ch1", cell, fields)
    const out = add(row("plan", "described", { selection_ref: s.id, input_refs: refs.map((r) => r.id) }))
    return { s, out }
  }
  const note = (refs: Row[]) => {
    const s = sel("produce/note/ch1", NOTE_CELL)
    const out = add(row("note", "described", { selection_ref: s.id, input_refs: refs.map((r) => r.id) }))
    return { s, out }
  }
  // a selection of another move that produced nothing
  const filler = (fields: Record<string, unknown> = {}) => sel("wait-for", "wait-for|asker:person,age:0", fields)
  // such a selection made over a row as the root's frontier, with calls that take it: a consumer of the row was offered
  const offer = (out: Row, fields: Record<string, unknown> = {}) => filler({ ...offerOf(out), ...fields })
  const fail = (s: Row) => add(row("failure", "walk", { selection_ref: s.id, status: 500 }))
  return { rows, add, ask, sel, run, plan, note, filler, offer, fail }
}

describe("a move's output, judged by its use within the window", () => {
  test("[MUST-FAIL] a run whose answer nobody takes, the window passed → r 0 on its cell at w_check", () => {
    const b = build()
    const r = b.run(); b.offer(r.out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1.5 })
  })

  test("[MUST-FAIL] a run whose answer another move's produce takes within the window → r 1", () => {
    const b = build()
    const r = b.run(); b.filler(); b.plan([r.out])
    expect(use(b.rows)).toContainEqual([1, RUN_CELL])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1.5, beta: 1 })
  })

  test("[MUST-FAIL] a call whose request nobody takes is judged like a run: r 0 after the window", () => {
    const b = build()
    const req = b.add(row("request", "described", { pointer: { type: "fs_read" } }))
    const c = b.sel("call/fs_read", CALL_CELL, { from: req.id })
    const ans = b.add(row("fileContent", "walk", { selection_ref: c.id }))
    b.offer(ans); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, CALL_CELL]])
  })

  test("[MUST-FAIL] each idle run is its own failure: five idle runs cost five r 0, not one", () => {
    const b = build()
    for (let i = 0; i < 5; i++) b.offer(b.run().out)
    b.filler(); b.filler()
    expect(use(b.rows)).toEqual([0, 1, 2, 3, 4].map(() => [0, RUN_CELL]))
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1 + 5 * 0.5 })
  })

  test("[MUST-FAIL] idle runs in two cells cost an r 0 each, each on its own cell", () => {
    const b = build()
    b.offer(b.run().out); b.offer(b.run({ cell: "run/tmpl|request,asker:person,age:1" }).out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL], [0, "run/tmpl|request,asker:person,age:1"]])
    // its own r 0, and the other cell's r 0 inherited at the move's asker level
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1 + 0.5 + 0.5 })
  })

  test("[MUST-FAIL] each request judges the move on its own: used on one, idle on another → r 1 and r 0", () => {
    const b = build()
    const other = b.add(row("world_changed", "person", { what: "another ask" }))
    const r = b.run(); b.plan([r.out])
    const on = { root: other.id }
    b.offer(b.run(on).out, on); b.sel("wait-for", "wait-for|asker:person,age:0", on); b.sel("wait-for", "wait-for|asker:person,age:0", on)
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL).sort()).toEqual([[0, RUN_CELL], [1, RUN_CELL]])
  })

  test("[MUST-FAIL] a row list that grows is read again: the window that passes on the new row is seen", () => {
    const b = build()
    b.offer(b.run().out); b.filler()
    expect(use(b.rows)).toEqual([])
    b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] one row list read at two at_seq: each read sees only the rows up to its own", () => {
    const b = build()
    const r = b.run(); b.offer(r.out); b.filler(); b.filler()
    const at = (atSeq: number) => (((F as Record<string, unknown>).useGrades as typeof F.useGrades | undefined)?.(b.rows, 1e9, atSeq) ?? []).map((g) => [g.r, [...g.cells][0]!])
    expect(at(1e9)).toEqual([[0, RUN_CELL]])
    expect(at(r.out.seq)).toEqual([]) // no selection after the run yet: no window has passed
    expect(at(1e9)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] selections of any arm on the request count toward the window, as a promise's window counts them", () => {
    const b = build()
    const r = b.run()
    for (let i = 0; i < 3; i++) b.sel("wait-for", "wait-for|asker:person,age:0", { arm: "control", ...(i === 0 ? offerOf(r.out) : {}) })
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] a move used twice on one request earns once, on the cell of the first selection used", () => {
    const b = build()
    const AGE1 = "run/tmpl|request,asker:person,age:1"
    const r0 = b.run(); b.plan([r0.out])
    const r1 = b.run({ cell: AGE1 }); b.plan([r1.out])
    expect(use(b.rows).filter(([, c]) => c.startsWith("run/"))).toEqual([[1, RUN_CELL]])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1.5, beta: 1 })
  })

  test("[MUST-FAIL] a produce that made a deadline beside its other rows is judged by the lapse, not by use", () => {
    const b = build()
    const s = b.sel("produce/plan/ch1", PLAN_CELL)
    b.add(row("plan", "described", { selection_ref: s.id, input_refs: [] }))
    b.add(row("due", "described", { selection_ref: s.id, within_ms: 60_000, at: 1e15, input_refs: [b.ask.id] }))
    b.offer(b.run().out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[GUARD] a credits row with a window but no w_check judges nothing, and posts stay the parent's", () => {
    const { w_check: _, ...rest } = CREDITS
    const b = build({ ...rest })
    b.offer(b.run().out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a later use does not undo an idle run's r 0: an idle run, then a run of the same move that is used → r 0 and r 1", () => {
    const b = build()
    b.offer(b.run().out); b.filler(); b.filler()
    const r = b.run(); b.plan([r.out])
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[0, RUN_CELL], [1, RUN_CELL]])
  })

  test("[MUST-FAIL] an idle repeat of a used move costs its own r 0", () => {
    const b = build()
    const r = b.run(); b.plan([r.out])
    b.offer(b.run().out); b.filler(); b.filler()
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[1, RUN_CELL], [0, RUN_CELL]])
  })

  test("[MUST-FAIL] a take after the window does not count: the run is unused", () => {
    const b = build()
    const r = b.run(); b.offer(r.out); b.filler(); b.filler(); b.plan([r.out])
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] two moves feeding each other earn once each, however many rounds", () => {
    const rounds = (k: number) => {
      const b = build()
      let p = b.plan([])
      for (let i = 0; i < k; i++) p = b.plan([b.note([p.out]).out])
      return b.rows
    }
    const two = rounds(2), twenty = rounds(20)
    expect(use(two).sort()).toEqual([[1, NOTE_CELL], [1, PLAN_CELL]])
    expect(use(twenty).sort()).toEqual([[1, NOTE_CELL], [1, PLAN_CELL]])
    for (const c of [PLAN_CELL, NOTE_CELL]) expect(post(twenty, c)).toEqual(post(two, c))
    expect(post(two, PLAN_CELL)).toMatchObject({ alpha: 1.5, beta: 1 })
  })

  test("[GUARD] a move's own later step never counts as use: a plan taken by the next plan earns nothing", () => {
    const b = build()
    const p = b.plan([]); b.plan([p.out])
    expect(use(b.rows)).toEqual([])
  })

  test("[MUST-FAIL] a take by a failed selection is no use: the run is unused once the window passes", () => {
    const b = build()
    const r = b.run(); const c = b.plan([r.out], PLAN_CELL, offerOf(r.out)); b.fail(c.s); b.filler(); b.filler()
    expect(use(b.rows).filter(([, x]) => x === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[GUARD] a failed run is judged by its failure, never by use", () => {
    const b = build()
    const r = b.run(); b.fail(r.s); b.offer(r.out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] a take on another request is no use of this request's run", () => {
    const b = build()
    const other = b.add(row("world_changed", "person", { what: "another ask" }))
    const r = b.run(); b.plan([r.out], PLAN_CELL, { root: other.id })
    expect(use(b.rows)).toEqual([])
  })

  test("[MUST-FAIL] a take on another request is no use even at a position inside this request's window", () => {
    const b = build()
    const other = b.add(row("world_changed", "person", { what: "another ask" }))
    const r = b.run() // position 0 on this request
    b.sel("wait-for", "wait-for|asker:person,age:0", { root: other.id })
    b.plan([r.out], PLAN_CELL, { root: other.id }) // position 1 on the other request
    b.offer(r.out); b.filler(); b.filler()
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] a move selected before the run is not in its window, even when its row, written later, cites the run's", () => {
    const b = build()
    const early = b.sel("produce/plan/ch1", PLAN_CELL)
    const r = b.run()
    b.add(row("plan", "described", { selection_ref: early.id, input_refs: [r.out.id] }))
    b.offer(r.out); b.filler(); b.filler()
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[GUARD] graders, deadlines and moves that made nothing are not judged by use", () => {
    const b = build()
    const g = b.sel("produce/land_verdict/ch1", "produce/land_verdict/ch1|gitDiff,asker:person,age:0")
    b.add(row("land_verdict", "described", { selection_ref: g.id, r: 1 }))
    const o = b.sel("produce/outcome/ch1", "produce/outcome/ch1|answer,asker:person,age:0")
    b.add(row("outcome", "described", { selection_ref: o.id, r: 1 }))
    // a deadline row is one by its own fields, whatever it cites
    const d = b.sel("produce/due/ch1", "produce/due/ch1|request,asker:person,age:0")
    b.add(row("due", "described", { selection_ref: d.id, within_ms: 60_000, at: 1 }))
    b.filler(); b.filler(); b.filler(); b.filler() // the first filler's window passes too: it made nothing
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] untreated selections and selections with no request are not judged", () => {
    const b = build()
    b.offer(b.run({ arm: "control" }).out); b.run({ root: undefined }); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] with no promise window on the credits row, nothing is judged", () => {
    const { promise_window: _, ...rest } = CREDITS
    const b = build(rest)
    b.offer(b.run().out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] judged as of: nothing past as_of is a taker or a passed window", () => {
    const b = build()
    const f1 = b.offer(b.run().out); b.filler(); b.filler()
    expect(use(b.rows, f1.seq)).toEqual([]) // the window had not passed yet
    const c = build()
    const r = c.run(); const at = c.filler(); c.plan([r.out])
    expect(use(c.rows, at.seq)).toEqual([]) // the take came after as_of, and no window has passed
  })

  test("[GUARD] a settled promise judges its answer: no use grade on that selection", () => {
    const b = build()
    b.add(row("requires", "owner", { for: "fs_edit", needs: "change_wanted", where: { wanted: true } }))
    b.add(row("change_wanted", "described", { wanted: true, repo: "human-surface-vessel", input_refs: [b.ask.id] }))
    const s0 = b.sel("produce/answer/ch1", "produce/answer/ch1|world_changed,asker:person,age:0")
    b.add(row("answer", "described", { selection_ref: s0.id, input_refs: [b.ask.id], next_act: { tool: "fs_edit", target: "src/limits.ts" } }))
    b.filler()
    const req = b.add(row("request", "described", { pointer: { type: "fs_edit", path: "/walk-trees/human-surface-vessel-x/src/limits.ts" }, input_refs: [b.ask.id] }))
    const call = b.sel("call/fs_edit", "call/fs_edit|request,asker:person,age:0", { from: req.id })
    b.add(row("hop", "walk", { selection_ref: call.id, call_id: "c1", phase: "started", kind: "call", pointer_type: "fs_edit" }))
    b.filler()
    expect(F.promiseGrades(b.rows, 1e9, 1e9).map((g) => [g.r, g.judged])).toEqual([[1, s0.id]])
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] a promise refused while the request waited on a person judges its answer too: no use debit in the wait", () => {
    const b = build()
    b.add(row("requires", "owner", { for: "fs_edit", needs: "change_wanted", where: { wanted: true } }))
    b.add(row("change_wanted", "described", { wanted: true, repo: "human-surface-vessel", input_refs: [b.ask.id] }))
    const s0 = b.sel("produce/answer/ch1", "produce/answer/ch1|world_changed,asker:person,age:0")
    b.add(row("answer", "described", { selection_ref: s0.id, input_refs: [b.ask.id], next_act: { tool: "fs_edit", target: "src/limits.ts" } }))
    const land = b.sel("call/git_land", "call/git_land|x")
    b.add(row("failure", "walk", { selection_ref: land.id, call_id: "cw", status: 409, waits_for: "person", input_refs: [land.id] }))
    b.filler(); b.filler(); b.filler()
    expect(F.promiseGrades(b.rows, 1e9, 1e9)).toMatchObject([{ ok: false, r: 0, refused: "person_wait", judged: s0.id }])
    expect(use(b.rows)).toEqual([])
  })
})

describe("an unused output is debited only when a consumer of it was offered (USER ruling 11-22)", () => {
  test("[MUST-FAIL] not offered: the window passes, nothing took the run's answer, and no later selection was offered a consumer of it → no grade", () => {
    const b = build()
    b.run(); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1 })
  })
  test("[GUARD] offered and not taken: a later selection had the answer as its frontier with calls that take it → r 0", () => {
    const b = build()
    const r = b.run(); b.filler(); b.offer(r.out); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })
  test("[GUARD] offered and taken → r 1, once per request and move", () => {
    const b = build()
    const r0 = b.run(); b.offer(r0.out); b.plan([r0.out])
    const r1 = b.run(); b.offer(r1.out); b.plan([r1.out])
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[1, RUN_CELL]])
  })
  test("[MUST-FAIL] the frontier was the answer but no call takes it (widened) → no grade", () => {
    const b = build()
    const r = b.run(); b.filler({ frontier: { id: r.out.id, shape: r.out.shape }, frontier_widened: true }); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })
  test("[MUST-FAIL] another root's selection offered a consumer of this run's answer: no offer on this root → no grade", () => {
    const b = build()
    const other = b.add(row("world_changed", "person", { what: "another ask" }))
    const r = b.run()
    b.offer(r.out, { root: other.id })
    b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })
  test("[MUST-FAIL] another output of the same shape was offered: only the run whose own answer was offered is debited", () => {
    const b = build()
    const first = b.run()
    const second = b.run({ cell: "run/tmpl|request,asker:person,age:1" })
    b.offer(second.out); b.filler(); b.filler()
    expect(first.out.shape).toBe(second.out.shape)
    expect(use(b.rows)).toEqual([[0, "run/tmpl|request,asker:person,age:1"]])
  })
  test("[MUST-FAIL] an output of another shape was offered: the run whose answer was not offered is not debited", () => {
    const b = build()
    b.run()
    const p = b.plan([]) // a plan nothing takes, offered next
    b.offer(p.out); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, PLAN_CELL]])
  })
  test("[MUST-FAIL] an offer after the window does not count: the window passed with none → no grade", () => {
    const b = build()
    const r = b.run(); b.filler(); b.filler(); b.filler(); b.offer(r.out)
    expect(use(b.rows)).toEqual([])
  })
})
