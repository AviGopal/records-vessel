// SPDX-License-Identifier: MIT
// A move's output that another move takes as input earns; one nobody takes costs. Each request judges each move once,
// at the owner's w_check: used within the owner's promise_window → r 1; unused after it → r 0; a later use replaces
// the r 0. The rows here are the shapes the walk, described-shape and the owner write.
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
  const filler = () => sel("wait-for", "wait-for|asker:person,age:0")
  const fail = (s: Row) => add(row("failure", "walk", { selection_ref: s.id, status: 500 }))
  return { rows, add, ask, sel, run, plan, note, filler, fail }
}

describe("a move's output, judged by its use within the window", () => {
  test("[MUST-FAIL] a run whose answer nobody takes, the window passed → r 0 on its cell at w_check", () => {
    const b = build()
    b.run(); b.filler(); b.filler(); b.filler()
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
    b.sel("call/fs_read", CALL_CELL, { from: req.id }); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, CALL_CELL]])
  })

  test("[MUST-FAIL] a busy move is judged once per request: five idle runs cost one r 0, not five", () => {
    const b = build()
    for (let i = 0; i < 5; i++) b.run()
    b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1.5 })
  })

  test("[MUST-FAIL] the move is judged, not the cell: idle runs at two ages cost one r 0, on the first one's cell", () => {
    const b = build()
    b.run(); b.run({ cell: "run/tmpl|request,asker:person,age:1" }); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] each request judges the move on its own: used on one, idle on another → r 1 and r 0", () => {
    const b = build()
    const other = b.add(row("world_changed", "person", { what: "another ask" }))
    const r = b.run(); b.plan([r.out])
    const on = { root: other.id }
    b.run(on); b.sel("wait-for", "wait-for|asker:person,age:0", on); b.sel("wait-for", "wait-for|asker:person,age:0", on); b.sel("wait-for", "wait-for|asker:person,age:0", on)
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL).sort()).toEqual([[0, RUN_CELL], [1, RUN_CELL]])
  })

  test("[MUST-FAIL] a row list that grows is read again: the window that passes on the new row is seen", () => {
    const b = build()
    b.run(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
    b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] one row list read at two at_seq: each read sees only the rows up to its own", () => {
    const b = build()
    const r = b.run(); b.filler(); b.filler(); b.filler()
    const at = (atSeq: number) => (((F as Record<string, unknown>).useGrades as typeof F.useGrades | undefined)?.(b.rows, 1e9, atSeq) ?? []).map((g) => [g.r, [...g.cells][0]!])
    expect(at(1e9)).toEqual([[0, RUN_CELL]])
    expect(at(r.out.seq)).toEqual([]) // no selection after the run yet: no window has passed
    expect(at(1e9)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] selections of any arm on the request count toward the window, as a promise's window counts them", () => {
    const b = build()
    b.run()
    for (let i = 0; i < 3; i++) b.sel("wait-for", "wait-for|asker:person,age:0", { arm: "control" })
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
    b.run(); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([[0, RUN_CELL]])
  })

  test("[GUARD] a credits row with a window but no w_check judges nothing, and posts stay the parent's", () => {
    const { w_check: _, ...rest } = CREDITS
    const b = build({ ...rest })
    b.run(); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
    expect(post(b.rows, RUN_CELL)).toMatchObject({ alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a later use replaces the r 0: an idle run, then a run of the same move that is used → r 1 only", () => {
    const b = build()
    b.run(); b.filler(); b.filler(); b.filler()
    const r = b.run(); b.plan([r.out])
    expect(use(b.rows)).toContainEqual([1, RUN_CELL])
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[1, RUN_CELL]])
  })

  test("[MUST-FAIL] a used move stays used: an idle repeat of it after the use costs nothing", () => {
    const b = build()
    const r = b.run(); b.plan([r.out])
    b.run(); b.filler(); b.filler(); b.filler()
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[1, RUN_CELL]])
  })

  test("[MUST-FAIL] a take after the window does not count: the run is unused", () => {
    const b = build()
    const r = b.run(); b.filler(); b.filler(); b.filler(); b.plan([r.out])
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
    const r = b.run(); const c = b.plan([r.out]); b.fail(c.s); b.filler(); b.filler()
    expect(use(b.rows).filter(([, x]) => x === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[GUARD] a failed run is judged by its failure, never by use", () => {
    const b = build()
    const r = b.run(); b.fail(r.s); b.filler(); b.filler(); b.filler()
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
    b.filler(); b.filler(); b.filler()
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[0, RUN_CELL]])
  })

  test("[MUST-FAIL] a move selected before the run is not in its window, even when its row, written later, cites the run's", () => {
    const b = build()
    const early = b.sel("produce/plan/ch1", PLAN_CELL)
    const r = b.run()
    b.add(row("plan", "described", { selection_ref: early.id, input_refs: [r.out.id] }))
    b.filler(); b.filler(); b.filler()
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
    b.run({ arm: "control" }); b.run({ root: undefined }); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] with no promise window on the credits row, nothing is judged", () => {
    const { promise_window: _, ...rest } = CREDITS
    const b = build(rest)
    b.run(); b.filler(); b.filler(); b.filler()
    expect(use(b.rows)).toEqual([])
  })

  test("[GUARD] judged as of: nothing past as_of is a taker or a passed window", () => {
    const b = build()
    b.run(); const f1 = b.filler(); b.filler(); b.filler()
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
