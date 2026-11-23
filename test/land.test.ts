// SPDX-License-Identifier: MIT
// A person's verdict on a landing teaches the steps behind the change (the USER: "Yes, credit the chain"): it grades the
// selection that made the diff and travels back along consumption at w_person·γ^k. A model's verdict originates nothing.
import { describe, expect, test } from "bun:test"
import { fold, foldFrom, landGrades } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const CREDITS = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }
const CELLS = ["call/fs_edit|request", "produce/request|world_changed", "call/git_diff|request"]

// edit call → its result (recorded by the walk); a request that used that result; the git_diff call made for it; the diff
const chain = () => {
  seq = 0
  const rows: Row[] = [row("credits", "owner", CREDITS), row("shape_schema", "owner", { target: "request", inputs: ["world_changed"] })]
  const add = (r: Row): Row => { rows.push(r); return r }
  const ask = add(row("world_changed", "person", { what: "boxLines 10" }))
  const editReq = add(row("request", "described", { selection_ref: "none", input_refs: [ask.id], pointer: { type: "fs_edit" } }))
  const editSel = add(row("selection", "walk", { arm: "treated", cell: CELLS[0], a: "call/fs_edit", from: editReq.id, root: ask.id }))
  const edited = add(row("fileEditResult", "walk", { selection_ref: editSel.id, call_id: "ce", ok: true, input_refs: [ask.id] }))
  const reqSel = add(row("selection", "walk", { arm: "treated", cell: CELLS[1], a: "produce/request/ch1", root: ask.id }))
  const diffReq = add(row("request", "described", { selection_ref: reqSel.id, input_refs: [ask.id, edited.id], uses: [edited.id], pointer: { type: "git_diff" } }))
  const diffSel = add(row("selection", "walk", { arm: "treated", cell: CELLS[2], a: "call/git_diff", from: diffReq.id, root: ask.id }))
  const diff = add(row("gitDiff", "walk", { selection_ref: diffSel.id, call_id: "cd", tree: "T1", input_refs: [ask.id] }))
  const cut = () => { diff.truncated = true }
  const failEdit = () => add(row("failure", "walk", { selection_ref: editSel.id, call_id: "ce", status: 422 }))
  const asControl = () => { diffSel.arm = "control" }
  const verdict = (role: string, r: number, extra: Record<string, unknown> = {}) => add(row("land_verdict", role, { r, tree: "T1", input_refs: [ask.id, diff.id], ...extra }))
  const posts = () => fold(rows, CELLS, 1e9, 1e9)
  return { rows, verdict, posts, failEdit, asControl, cut }
}

describe("a person's verdict on a landing", () => {
  test("[MUST-FAIL] a person's r 1 credits the diff's call and the request and edit behind it, at w_person·γ^k", () => {
    const c = chain()
    c.verdict("person", 1)
    expect(c.posts().map((p) => [p.alpha, p.beta])).toEqual([[1 + 0.25, 1], [1 + 0.5, 1], [1 + 1, 1]])
  })

  test("[MUST-FAIL] a person's r 0 debits them, and never raises an alpha", () => {
    const c = chain()
    c.verdict("person", 0)
    const p = c.posts()
    expect(p.map((x) => [x.alpha, x.beta])).toEqual([[1, 1.25], [1, 1.5], [1, 2]])
    expect(p.every((x) => x.alpha === 1)).toBe(true)
  })

  test("[MUST-FAIL] a model's land_verdict originates nothing here", () => {
    const c = chain()
    c.verdict("described", 1, { selection_ref: "x" })
    c.verdict("described", 0, { selection_ref: "y" })
    expect(landGrades(c.rows, 1e9, 1e9)).toEqual([])
    expect(c.posts().map((p) => [p.alpha, p.beta])).toEqual([[1, 1], [1, 1], [1, 1]])
  })

  test("[MUST-FAIL] one standing grade per person per tree: a later verdict of theirs replaces the earlier", () => {
    const c = chain()
    c.verdict("person", 0, { writer: "p1" })
    c.verdict("person", 1, { writer: "p1" })
    expect(c.posts()[2]).toMatchObject({ alpha: 2, beta: 1 })
  })

  test("[MUST-FAIL] a step in the chain that failed is not credited by the landing it fed", () => {
    const c = chain()
    c.failEdit()
    c.verdict("person", 1)
    // the edit's own failure debits it as before (its beta); the landing adds no alpha to it
    expect(c.posts().map((p) => p.alpha)).toEqual([1, 1 + 0.5, 1 + 1])
  })

  test("[MUST-FAIL] a diff made by a control-arm selection grades nothing", () => {
    const c = chain()
    c.asControl()
    c.verdict("person", 1)
    expect(landGrades(c.rows, 1e9, 1e9)).toEqual([])
  })

  test("[MUST-FAIL] a person's r 1 on a cut diff credits nothing; an r 0 on it still debits (as the landing reads them)", () => {
    const c = chain()
    c.cut()
    c.verdict("person", 1)
    expect(landGrades(c.rows, 1e9, 1e9)).toEqual([])
    const d = chain()
    d.cut()
    d.verdict("person", 0)
    expect(d.posts()[2]).toMatchObject({ alpha: 1, beta: 2 })
  })

  test("[MUST-FAIL] a verdict naming another tree than the diff it cites grades nothing", () => {
    const c = chain()
    c.verdict("person", 1, { tree: "T-other" })
    expect(landGrades(c.rows, 1e9, 1e9)).toEqual([])
  })

  test("[MUST-FAIL] stop at makers: a grader whose outcome the maker read is neither credited nor walked past", () => {
    const c = chain()
    // a grader selection, made before the request that read its outcome
    const graderSel = { shape: "selection", role: "walk", writer: "walk", id: "sel-grader", seq: 0.5, t: "", input_refs: [], arm: "treated", cell: "produce/outcome|answer", a: "produce/outcome/ch1" } as Row
    const graded = { shape: "outcome", role: "described", writer: "described", id: "outcome-graded", seq: 0.6, t: "", r: 0, selection_ref: graderSel.id, input_refs: [] } as Row
    c.rows.push(graderSel, graded)
    const diffReq = c.rows.find((x) => x.shape === "request" && (x.pointer as { type?: string }).type === "git_diff")!
    diffReq.input_refs = [...[diffReq.input_refs].flat(), graded.id]
    diffReq.uses = [...[diffReq.uses].flat(), graded.id]
    c.verdict("person", 1)
    const cells = [...CELLS, "produce/outcome|answer"]
    const posts = foldFrom(c.rows, cells, 1e9, 1e9)
    // the makers move as before; the grader's cell gains nothing of its own: having no grade, it draws from its kind's
    // record (the request's credit, a produce like it), not from a credit
    expect(posts.map((p) => [p.alpha, p.beta, p.from])).toEqual([[1 + 0.25, 1, "cell"], [1 + 0.5, 1, "cell"], [1 + 1, 1, "cell"], [1 + 0.5, 1, "kind"]])
  })

  test("[MUST-FAIL] latest decides per tree, whoever: A r 0 then B r 1 is one credit and no debit; r 1 then r 0 is one debit", () => {
    const c = chain()
    c.verdict("person", 0, { writer: "person-a" })
    c.verdict("person", 1, { writer: "person-b" })
    expect(landGrades(c.rows, 1e9, 1e9).map((g) => g.r)).toEqual([1])
    expect(c.posts()[2]).toMatchObject({ alpha: 2, beta: 1 })
    const d = chain()
    d.verdict("person", 1, { writer: "person-a" })
    d.verdict("person", 0, { writer: "person-b" })
    expect(landGrades(d.rows, 1e9, 1e9).map((g) => g.r)).toEqual([0])
    expect(d.posts()[2]).toMatchObject({ alpha: 1, beta: 2 })
  })

  test("a pool with no land_verdict is folded exactly as before (no land grades)", () => {
    const c = chain()
    expect(landGrades(c.rows, 1e9, 1e9)).toEqual([])
    expect(c.posts().map((p) => [p.alpha, p.beta])).toEqual([[1, 1], [1, 1], [1, 1]])
  })
})
