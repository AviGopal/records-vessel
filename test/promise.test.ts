// SPDX-License-Identifier: MIT
// A promise (an answer's next_act on a root that wants a change) is settled by what the walk did next: kept → r 1, broken
// → r 0, at the owner's w_check, travelling back like any origination (enablement-credit design §12.1). The rows here
// are the shapes the walk, described-shape and the owner write.
import { describe, expect, test } from "bun:test"
import { foldFrom, promiseGrades, verifySelections } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

const ANSWER_CELL = "produce/answer/ch1|world_changed,did:none,asker:person,age:0"
const CALL_CELL = "call/fs_edit|request,did:none,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4, w_check: 0.5, promise_window: 3 }

// A root that wants a change, an answer that promises an edit of src/limits.ts, then the walk's next selections.
const build = (o: { credits?: Record<string, unknown>; wanted?: boolean; nextAct?: unknown; text?: string } = {}) => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", o.credits ?? CREDITS))
  // the owner's word that fs_edit is an act: it requires a wanted change (the seed writes these rows)
  add(row("requires", "owner", { for: "fs_edit", needs: "change_wanted", where: { wanted: true } }))
  const ask = add(row("world_changed", "person", { what: "make the message box 10 lines" }))
  add(row("change_wanted", "described", { wanted: o.wanted ?? true, repo: "human-surface-vessel", input_refs: [ask.id] }))
  const s0 = add(row("selection", "walk", { arm: "treated", cell: ANSWER_CELL, root: ask.id, a: "produce/answer/ch1" }))
  const answer = add(row("answer", "described", { selection_ref: s0.id, input_refs: [ask.id], text: o.text ?? "I will edit src/limits.ts next.",
    ...(o.nextAct === undefined ? { next_act: { tool: "fs_edit", target: "src/limits.ts" } } : o.nextAct === null ? {} : { next_act: o.nextAct }) }))
  // a selection of this root that is not the promised act
  const other = () => add(row("selection", "walk", { arm: "treated", cell: "produce/request|world_changed,asker:person,age:0", root: ask.id, a: "produce/request" }))
  // the walk calling a request's pointer: the request row, the call's selection, its started hop
  const call = (pointer: Record<string, unknown>, fields: Record<string, unknown> = {}) => {
    const req = add(row("request", "described", { pointer, input_refs: [ask.id] }))
    const sel = add(row("selection", "walk", { arm: "treated", cell: CALL_CELL, root: ask.id, a: "call/fs_edit", from: req.id }))
    add(row("hop", "walk", { selection_ref: sel.id, call_id: `c${seq}`, phase: "started", kind: "call", pointer_type: String(pointer.type), ...fields }))
    return sel
  }
  const post = (cell = ANSWER_CELL) => foldFrom(rows, [cell], 1e9, 1e9)[0]
  return { rows, add, ask, s0, answer, other, call, post }
}

describe("a promise, settled by the walk's next selections", () => {
  test("[MUST-FAIL] kept: the promised call starts within the window → r 1 on the answer's cell at w_check", () => {
    const b = build()
    b.other()
    b.call({ type: "fs_edit", path: "/walk-trees/human-surface-vessel-x/src/limits.ts", old_string: "8", new_string: "10" })
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => [g.r, g.judged])).toEqual([[1, b.s0.id]])
    expect(b.post()).toMatchObject({ alpha: 1 + 0.5, beta: 1 }) // w_check 0.5, below w_close 1
  })

  test("[MUST-FAIL] broken: N of the root's selections pass with no such call → r 0", () => {
    const b = build()
    b.other(); b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0])
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 + 0.5 })
  })

  test("before N selections have passed with no match, nothing is settled", () => {
    const b = build()
    b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9)).toEqual([])
  })

  test("[MUST-FAIL] a wanted: false root (a greeting) predicts nothing, even with next_act", () => {
    const b = build({ wanted: false })
    b.other(); b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9)).toEqual([])
  })

  test("[MUST-FAIL] a promise only in prose, or a forged started hop not written by the walk, settles nothing", () => {
    const prose = build({ nextAct: null, text: "Next I will call fs_edit on src/limits.ts." })
    prose.other(); prose.other(); prose.other()
    expect(promiseGrades(prose.rows, 1e9, 1e9)).toEqual([])
    const forged = build()
    const req = forged.add(row("request", "described", { pointer: { type: "fs_edit", path: "src/limits.ts" } }))
    const sel = forged.add(row("selection", "walk", { arm: "treated", cell: CALL_CELL, root: forged.ask.id, from: req.id }))
    forged.add(row("hop", "described", { selection_ref: sel.id, phase: "started", pointer_type: "fs_edit" })) // not the walk's
    forged.other(); forged.other()
    expect(promiseGrades(forged.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0]) // the window passed: broken
  })

  test("[MUST-FAIL] the matching call starts and fails → kept (r 1), and the call's own failure is still its move's debit", () => {
    const b = build()
    const sel = b.call({ type: "fs_edit", path: "src/limits.ts", old_string: "8", new_string: "10" })
    b.add(row("failure", "walk", { selection_ref: sel.id, status: 422, blames: "request", body: "old_string not found" }))
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => g.r)).toEqual([1])
    expect(b.post()).toMatchObject({ alpha: 1.5, beta: 1 })
    expect(b.post(CALL_CELL).beta).toBeGreaterThan(1) // the failed call is debited as a move
  })

  test("a call of the promised tool on another target, or another tool on the target, does not keep it", () => {
    const b = build()
    b.call({ type: "fs_edit", path: "src/other.ts" })
    b.call({ type: "fs_read", path: "src/limits.ts" })
    b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0])
  })

  // the USER (11-16): "No lapse while waiting", carried to promises: a window that fell while the request waited on a
  // person measured the person's time, not the makers'.
  const waitOn = (b: ReturnType<typeof build>) => {
    const s = b.add(row("selection", "walk", { arm: "treated", cell: "call/git_land|x", root: b.ask.id, a: "call/git_land" }))
    b.add(row("failure", "walk", { selection_ref: s.id, call_id: "cw", status: 409, waits_for: "person", input_refs: [s.id] }))
  }
  test("[MUST-FAIL] a promise broken while the request waited on a person counts for nothing: no debit", () => {
    const b = build()
    waitOn(b); b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9)).toMatchObject([{ ok: false, r: 0, refused: "person_wait" }])
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 })
  })
  test("[MUST-FAIL] the same promise broken outside a wait is still debited; a person row after the wait ends it", () => {
    const b = build()
    b.other(); b.other(); b.other()
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1.5 })
    const c = build()
    waitOn(c)
    c.add(row("world_changed", "person", { what: "go on", input_refs: [c.ask.id] }))
    c.other(); c.other() // the wait's own selection is the window's first of three
    expect(c.post()).toMatchObject({ alpha: 1, beta: 1.5 })
  })

  test("[MUST-FAIL] a kept promise of a tool the owner doesn't gate as an act earns nothing; a broken one is still broken", () => {
    const kept = build({ nextAct: { tool: "fs_read", target: "src/limits.ts" } })
    kept.call({ type: "fs_read", path: "src/limits.ts" })
    expect(promiseGrades(kept.rows, 1e9, 1e9)).toEqual([])
    const broken = build({ nextAct: { tool: "fs_read", target: "src/limits.ts" } })
    broken.other(); broken.other(); broken.other()
    expect(promiseGrades(broken.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0])
  })

  test("[MUST-FAIL] a promise kept by a run of a template that does the act (no request row) is kept, not misread as broken", () => {
    const b = build()
    const tmpl = b.add(row("activity_template", "described", { calls: [{ shape: "fs_read", pointer: { path: "src/limits.ts" } },
      { shape: "fs_edit", pointer: { path: "/walk-trees/hsv-x/src/limits.ts", old_string: "8", new_string: "10" } }] }))
    const sel = b.add(row("selection", "walk", { arm: "treated", cell: "run/t|world_changed,asker:person,age:0", root: b.ask.id, a: `run/${tmpl.id}` }))
    // the run's inner calls each start under the run's selection: the read, then the edit
    b.add(row("hop", "walk", { selection_ref: sel.id, call_id: "cr1", phase: "started", kind: "run", pointer_type: "fs_read" }))
    b.add(row("hop", "walk", { selection_ref: sel.id, call_id: "cr2", phase: "started", kind: "run", pointer_type: "fs_edit" }))
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => g.r)).toEqual([1])
  })

  test("[MUST-FAIL] a run of a template that declares the act but stops before that call starts does not keep it", () => {
    const b = build()
    const tmpl = b.add(row("activity_template", "described", { calls: [{ shape: "git_diff", pointer: { cwd: "{{ sig.in[0].cwd }}" } },
      { shape: "fs_edit", pointer: { path: "src/limits.ts", old_string: "8", new_string: "10" } }] }))
    const sel = b.add(row("selection", "walk", { arm: "treated", cell: "run/t|world_changed,asker:person,age:0", root: b.ask.id, a: `run/${tmpl.id}` }))
    b.add(row("hop", "walk", { selection_ref: sel.id, call_id: "cu", phase: "started", kind: "run", pointer_type: "git_diff" }))
    b.add(row("failure", "walk", { selection_ref: sel.id, status: 422, blames: "request", body: "no such directory" }))
    b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0]) // the window passed with no edit started: broken
  })

  test("[MUST-FAIL] with no promise weight and window on the owner's credits row, nothing is settled (no default)", () => {
    const { w_check: _w, promise_window: _p, ...rest } = CREDITS
    const b = build({ credits: rest })
    b.other(); b.other(); b.other()
    expect(promiseGrades(b.rows, 1e9, 1e9)).toEqual([])
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 })
  })

  test("[MUST-FAIL] a described outcome on the same answer still originates nothing", () => {
    const b = build()
    b.add(row("outcome", "described", { r: 1, selection_ref: b.s0.id, input_refs: [b.ask.id, b.answer.id] }))
    b.other(); b.other()
    expect(b.post()).toMatchObject({ alpha: 1, beta: 1 }) // the window isn't passed, and the model's r 1 counts for nothing
  })

  test("[MUST-FAIL] V1: a selection recorded after a promise settled refolds to the posterior it recorded", () => {
    const b = build()
    b.other(); b.other(); b.other() // broken
    b.add(row("arm", "owner", { vessel_id: "walk", arm: "treated", as_of_seq: 1e9 }))
    const posts = foldFrom(b.rows, [ANSWER_CELL], 1e9, seq).map(({ alpha, beta }) => ({ alpha, beta }))
    const s = b.add(row("selection", "walk", { writer: "walk", arm: "treated", cell: ANSWER_CELL, a: "produce/answer/ch1", root: b.ask.id,
      posts, posts_seq: seq, cands: [{ id: "produce/answer/ch1", root: b.ask.id }] }))
    s.writer = "walk"
    const v = verifySelections(b.rows, [s])
    expect([v.checked, v.mismatches]).toEqual([1, []])
    expect(posts[0].beta).toBe(1.5) // and the promise is in it
  })
})
