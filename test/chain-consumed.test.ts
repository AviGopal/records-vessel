// SPDX-License-Identifier: MIT
// A call offered with no request (the walk offers the step a gated call's chain names, bound from the root's newest
// made row) consumed the row it was bound from, which its selection names as its frontier, so a grade on what the call
// made walks back past it (reached()) to the row's maker. The use grade already read such a take from the offer (a call
// whose kind the offer named, within the window), so the row it took was never judged unused; that is held unchanged
// here. A call a request asked for consumed the request, as before, whatever frontier it carries.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

const RUN_CELL = "run/tmpl|request,asker:person,age:0"
const DIFF_CELL = "call/git_diff|gitCommitResult,asker:person,age:0"
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4, w_check: 0.5, promise_window: 3 }

const use = (rows: Row[]): Array<[number, string]> => F.useGrades(rows, 1e9, 1e9).map((g) => [g.r, [...g.cells][0]!])

// a run that made a commit, a selection offered over it (git_diff takes it), then a call of git_diff given the fields
const build = (diff: (commit: Row) => Record<string, unknown>) => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", CREDITS))
  const ask = add(row("world_changed", "person", { what: "land the change" }))
  const tmpl = add(row("activity_template", "described", { id: "tmpl", calls: [{ shape: "gitCommitResult" }] }))
  const sel = (a: string, cell: string, fields: Record<string, unknown> = {}) =>
    add(row("selection", "walk", { arm: "treated", cell, root: ask.id, a, ...fields }))
  const runSel = sel(`run/${tmpl.id}`, RUN_CELL)
  const commit = add(row("gitCommitResult", "walk", { selection_ref: runSel.id, cwd: "/walk-trees/x" }))
  sel("wait-for", "wait-for|asker:person,age:0", { frontier: { id: commit.id, shape: commit.shape }, calls: ["git_diff"] })
  const diffSel = sel("call/git_diff", DIFF_CELL, diff(commit))
  add(row("gitDiff", "walk", { selection_ref: diffSel.id, cwd: "/walk-trees/x" }))
  for (let i = 0; i < 3; i++) sel("wait-for", "wait-for|asker:person,age:0")
  return { rows, ask, runSel, commit, diffSel }
}
const chained = (commit: Row) => ({ frontier: { id: commit.id, shape: commit.shape } })

describe("a call offered with no request consumed the row it was bound from", () => {
  test("[MUST-FAIL] reached(): a grade on the chained call walks back past it to the commit's maker", () => {
    const b = build(chained)
    const got = F.reached(F.indexOf(b.rows), b.diffSel.id, CREDITS, { by: "person", r: 1 })
    expect([got.get(b.diffSel.id), got.get(b.runSel.id)]).toEqual([1, 0.5])
  })

  test("[GUARD] the use grade: the commit the chained call took is used (r 1), as it was, read from the offer", () => {
    const b = build(chained)
    expect(use(b.rows).filter(([, c]) => c === RUN_CELL)).toEqual([[1, RUN_CELL]])
  })

  test("[GUARD] a call a request asked for consumed the request only, even carrying a frontier", () => {
    const b = build((commit) => ({ ...chained(commit), from: "request-asked" }))
    const got = F.reached(F.indexOf(b.rows), b.diffSel.id, CREDITS, { by: "person", r: 1 })
    expect(got.has(b.runSel.id)).toBe(false)
  })

  test("[GUARD] a call with neither a request nor a frontier consumed nothing, as before", () => {
    const b = build(() => ({}))
    const got = F.reached(F.indexOf(b.rows), b.diffSel.id, CREDITS, { by: "person", r: 1 })
    expect([...got.keys()]).toEqual([b.diffSel.id])
  })
})
