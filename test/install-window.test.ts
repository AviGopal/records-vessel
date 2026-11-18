// SPDX-License-Identifier: MIT
// A call cut inside an owner's infra window (an install's restart, an outage) did not fail its move: the move was
// stopped. Every rule that asks which moves failed reads that the same way (fold.ts moveFailed): the selection is not
// failed, so credit is not stopped there; a failure of a status the window does not name, outside its span, under a
// retracted window, or under one not the owner's, still fails its move.
import { describe, expect, test } from "bun:test"
import { gapClosures, gapClosuresScan, indexOf, landGrades } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const add = (out: Row[], r: Record<string, unknown>): Row => { const row = { input_refs: [], t: "", ...r, seq: ++seq, id: `x-${seq}` } as Row; out.push(row); return row }
const sel = (out: Row[], cell: string, pool: string[] = []) => add(out, { shape: "selection", role: "walk", writer: "walk", arm: "treated", cell, a: "call/x", pool_refs: pool })
// the walk's stop at an install restart, as calls.ts stop() writes it: status 0, no kind
const cut = (out: Row[], s: Row, status = 0) => add(out, { shape: "failure", role: "walk", writer: "walk", call_id: `c${seq}`, selection_ref: s.id, status, body: "the walk was stopped before the call ended" })
const window = (out: Row[], from: number, to: number, x: Record<string, unknown> = {}) =>
  add(out, { shape: "infra_window", role: "owner", writer: "owner", window_id: "install-walk-1", from_seq: from, to_seq: to, statuses: [0], reason: "install of walk-vessel", ...x })

describe("a move cut inside an owner's infra window is not a failed move", () => {
  const one = (mark?: (rows: Row[], f: Row) => void, status = 0) => {
    seq = 0
    const rows: Row[] = []
    const s = sel(rows, "call/x|a")
    const f = cut(rows, s, status)
    mark?.(rows, f)
    return indexOf(rows).failed.has(s.id)
  }
  test("[MUST-FAIL] inside the window, of a status it names: the selection is not failed", () => {
    expect(one((rows, f) => window(rows, f.seq - 1, f.seq + 1))).toBe(false)
  })
  test("a skip row under the selection is no failed move, window or not (a guard)", () => {
    seq = 0
    const rows: Row[] = []
    const s = sel(rows, "call/x|a")
    add(rows, { shape: "failure", role: "walk", writer: "walk", kind: "skip", selection_ref: s.id, unserved: ["held"], input_refs: [s.id] })
    expect(indexOf(rows).failed.has(s.id)).toBe(false)
  })
  test("no window: the selection is failed, as before (a guard)", () => {
    expect(one()).toBe(true)
  })
  test("a status the window does not name, outside its span, a retracted window, or one not the owner's: still failed (guards)", () => {
    expect(one((rows, f) => window(rows, f.seq - 1, f.seq + 1), 422)).toBe(true)
    expect(one((rows, f) => window(rows, f.seq + 1, f.seq + 2))).toBe(true)
    expect(one((rows, f) => { window(rows, f.seq - 1, f.seq + 1); window(rows, f.seq - 1, f.seq + 1, { retracted: true }) })).toBe(true)
    expect(one((rows, f) => window(rows, f.seq - 1, f.seq + 1, { role: "described", writer: "described" }))).toBe(true)
  })
  test("a window covers only rows written before it: one written before the cut does not reach it (a guard)", () => {
    seq = 0
    const rows: Row[] = []
    const s = sel(rows, "call/x|a")
    window(rows, 0, 100) // its span ends at its own seq, before the cut
    cut(rows, s)
    expect(indexOf(rows).failed.has(s.id)).toBe(true)
  })
})

describe("a gap closure credits a selection whose call was cut inside a window", () => {
  // a selection holding the open gap row lands the change (git_land ended); a second one holding it had its call cut
  const store = (marked: boolean) => {
    seq = 0
    const rows: Row[] = []
    add(rows, { shape: "credits", role: "owner", writer: "owner", target: "gap", by_call: "git_land" })
    const open = add(rows, { shape: "gap", role: "detector", writer: "detector", gap_id: "g1", status: "open" })
    const cutSel = sel(rows, "call/x|cut", [open.id])
    const f = cut(rows, cutSel)
    const lander = sel(rows, "call/x|land", [open.id])
    add(rows, { shape: "hop", role: "walk", writer: "walk", phase: "started", call_id: "land-1", pointer_type: "git_land", selection_ref: lander.id })
    add(rows, { shape: "hop", role: "walk", writer: "walk", phase: "ended", call_id: "land-1" })
    if (marked) window(rows, f.seq - 1, f.seq + 1)
    add(rows, { shape: "gap", role: "detector", writer: "detector", gap_id: "g1", status: "closed" })
    return rows
  }
  const cells = (gs: Array<{ cells: Set<string>; refused?: string }>) => gs.filter((g) => g.refused === undefined).flatMap((g) => [...g.cells]).sort()
  test("[MUST-FAIL] marked: the cut selection's cell is credited with the lander's; the full scan agrees", () => {
    const rows = store(true)
    expect(cells(gapClosures(rows, 1e9, 1e9))).toEqual(["call/x|cut", "call/x|land"])
    expect(cells(gapClosuresScan(rows, 1e9, 1e9))).toEqual(["call/x|cut", "call/x|land"])
  })
  test("unmarked: the cut selection is a failed move, a stop, and is not credited (a guard)", () => {
    const rows = store(false)
    expect(cells(gapClosures(rows, 1e9, 1e9))).toEqual(["call/x|land"])
    expect(cells(gapClosuresScan(rows, 1e9, 1e9))).toEqual(["call/x|land"])
  })
  test("a failure of another role under a selection is no failed move: no stop, the closure credits it (a guard)", () => {
    seq = 0
    const rows: Row[] = []
    add(rows, { shape: "credits", role: "owner", writer: "owner", target: "gap", by_call: "git_land" })
    const open = add(rows, { shape: "gap", role: "detector", writer: "detector", gap_id: "g1", status: "open" })
    const other = sel(rows, "call/x|other", [open.id])
    add(rows, { shape: "failure", role: "described", writer: "described", call_id: "c-other", selection_ref: other.id, status: 409, body: "conflict" })
    const lander = sel(rows, "call/x|land", [open.id])
    add(rows, { shape: "hop", role: "walk", writer: "walk", phase: "started", call_id: "land-1", pointer_type: "git_land", selection_ref: lander.id })
    add(rows, { shape: "hop", role: "walk", writer: "walk", phase: "ended", call_id: "land-1" })
    add(rows, { shape: "gap", role: "detector", writer: "detector", gap_id: "g1", status: "closed" })
    expect(cells(gapClosures(rows, 1e9, 1e9))).toEqual(["call/x|land", "call/x|other"])
    expect(cells(gapClosuresScan(rows, 1e9, 1e9))).toEqual(["call/x|land", "call/x|other"])
  })
})

describe("a person's landing credits an edit whose call was cut inside a window", () => {
  // land.test.ts's chain: an edit call and its result, a request that used it, the git_diff call made for it, the diff,
  // a person's verdict on the diff's tree; the edit's call cut by the walk's stop
  const CELLS = ["call/fs_edit|request", "produce/request|world_changed", "call/git_diff|request"]
  const r = (rows: Row[], shape: string, role: string, fields: Record<string, unknown>): Row =>
    add(rows, { shape, role, writer: role, ...fields })
  const chain = (marked: boolean) => {
    seq = 0
    const rows: Row[] = []
    r(rows, "credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 })
    const ask = r(rows, "world_changed", "person", { what: "x" })
    const editReq = r(rows, "request", "described", { selection_ref: "none", input_refs: [ask.id], pointer: { type: "fs_edit" } })
    const editSel = r(rows, "selection", "walk", { arm: "treated", cell: CELLS[0], a: "call/fs_edit", from: editReq.id, root: ask.id })
    const edited = r(rows, "fileEditResult", "walk", { selection_ref: editSel.id, call_id: "ce", ok: true, input_refs: [ask.id] })
    const f = cut(rows, editSel)
    if (marked) window(rows, f.seq - 1, f.seq + 1)
    const reqSel = r(rows, "selection", "walk", { arm: "treated", cell: CELLS[1], a: "produce/request/ch1", root: ask.id })
    const diffReq = r(rows, "request", "described", { selection_ref: reqSel.id, input_refs: [ask.id, edited.id], uses: [edited.id], pointer: { type: "git_diff" } })
    const diffSel = r(rows, "selection", "walk", { arm: "treated", cell: CELLS[2], a: "call/git_diff", from: diffReq.id, root: ask.id })
    const diff = r(rows, "gitDiff", "walk", { selection_ref: diffSel.id, call_id: "cd", tree: "T1", input_refs: [ask.id] })
    r(rows, "land_verdict", "person", { r: 1, tree: "T1", input_refs: [ask.id, diff.id] })
    return [...landGrades(rows, 1e9, 1e9)[0].cells].sort()
  }
  test("[MUST-FAIL] marked: the cut edit's cell is credited with the request and the diff's call", () => {
    expect(chain(true)).toEqual([...CELLS].sort())
  })
  test("unmarked: the cut edit is a failed move and is not credited (a guard)", () => {
    expect(chain(false)).toEqual([CELLS[1], CELLS[2]].sort())
  })
})
