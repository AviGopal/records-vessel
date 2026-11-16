// SPDX-License-Identifier: MIT
// A deadline that passed ungraded is a lapse by rule (the USER, 11-16: "Yes, a fixed rule records it"): each ask's first
// deadline, once the store's clock (its newest row) is past its at, with no counted grade of it and the ask not reached
// by a person's Right, counts as r 0 on it. No row is written. A later person grade overtakes it; none while waiting.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// far in the wall clock's future, so only the store's own clock (its newest row) can say a deadline has passed
const T0 = Date.parse("2099-01-01T10:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields }) as Row

const world = () => {
  seq = 0
  const ask = row("world_changed", "person", { what: "q" })
  const dueSel = row("selection", "walk", { arm: "treated", cell: "due-cell", root: ask.id })
  const due = row("due", "described", { within_ms: 60_000, at: T0 + 60_000, selection_ref: dueSel.id, input_refs: [ask.id] })
  return { ask, dueSel, due, base: [ask, dueSel, due] }
}
const tick = (at: number) => row("hop", "walk", { phase: "ended" }, at) // any row: it moves the store's clock
const lapseOf = (rows: Row[], due: Row) => F.grades(rows, seq, seq).find((g) => g.by === F.LAPSE && g.judged === due.id)

describe("a deadline that passed ungraded lapses by rule", () => {
  test("[MUST-FAIL] past its at by the store's clock, it counts: r 0 on the deadline, crediting its chain", () => {
    const w = world()
    const rows = [...w.base, tick(120_000)]
    expect(lapseOf(rows, w.due)).toMatchObject({ ok: true, r: 0, deadline: true, judged: w.due.id })
    expect(F.fold(rows, ["due-cell"], seq, seq)[0]).toMatchObject({ cell: "due-cell", beta: 2 })
  })
  test("[MUST-FAIL] before its at, nothing; the clock is the store's newest row, never the wall", () => {
    const w = world()
    expect(lapseOf([...w.base, tick(30_000)], w.due)).toBeUndefined()
  })
  test("[MUST-FAIL] only the ask's FIRST deadline lapses; a later one does not add a second", () => {
    const w = world()
    const later = row("due", "described", { within_ms: 1, at: T0 + 1, selection_ref: w.dueSel.id, input_refs: [w.ask.id] })
    const rows = [...w.base, later, tick(120_000)]
    expect([lapseOf(rows, w.due)?.ok, lapseOf(rows, later)]).toEqual([true, undefined])
  })
  test("[MUST-FAIL] a counted written lapse is the one grade: no derived second", () => {
    const w = world()
    const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: w.ask.id })
    const written = row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [w.ask.id, w.due.id], evidence_refs: [w.due.id] }, 90_000)
    const rows = [...w.base, gSel, written, tick(120_000)]
    expect(lapseOf(rows, w.due)).toBeUndefined()
  })
  test("[MUST-FAIL] an ask a counted written lapse already closed (on a later deadline) gets no second, derived one", () => {
    const w = world()
    const later = row("due", "described", { within_ms: 1000, at: T0 + 90_000, selection_ref: w.dueSel.id, input_refs: [w.ask.id] }, 5_000)
    const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: w.ask.id })
    const written = row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [w.ask.id, later.id], evidence_refs: [later.id] }, 100_000)
    const rows = [...w.base, later, gSel, written, tick(120_000)]
    expect(F.grades(rows, seq, seq).find((g) => g.id === written.id)).toMatchObject({ ok: true, deadline: true }) // closed by it
    expect(lapseOf(rows, w.due)).toBeUndefined()
  })
  test("[MUST-FAIL] a person's Right on a result closes the ask: no lapse", () => {
    const w = world()
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: w.ask.id })
    const answer = row("answer", "described", { text: "done", selection_ref: aSel.id, input_refs: [w.ask.id] }, 10_000)
    const right = row("outcome", "person", { r: 1, input_refs: [answer.id] }, 20_000)
    expect(lapseOf([...w.base, aSel, answer, right, tick(120_000)], w.due)).toBeUndefined()
  })
  test("[MUST-FAIL] a person's Right on a PROMISE does not stop it (the USER: Accurate, not done; Exempt until deadline)", () => {
    const w = world()
    const schema = row("shape_schema", "owner", { target: "outcome", context: ["answer"], evidence: [{ shape: "answer", deferred_by: "next_act" }] })
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: w.ask.id })
    const promise = row("answer", "described", { text: "not yet", next_act: { tool: "git_land" }, selection_ref: aSel.id, input_refs: [w.ask.id] }, 10_000)
    const right = row("outcome", "person", { r: 1, input_refs: [promise.id] }, 20_000)
    expect(lapseOf([...w.base, schema, aSel, promise, right, tick(120_000)], w.due)).toMatchObject({ ok: true })
  })
  test("[MUST-FAIL] a deadline whose own selection was not the walk's treated arm debits no one (untreated)", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const sel = row("selection", "walk", { arm: "control", cell: "due-cell", root: ask.id })
    const due = row("due", "described", { within_ms: 60_000, at: T0 + 60_000, selection_ref: sel.id, input_refs: [ask.id] })
    const rows = [ask, sel, due, tick(120_000)]
    expect(lapseOf(rows, due)).toMatchObject({ ok: false, refused: "untreated" })
    expect(F.fold(rows, ["due-cell"], seq, seq)[0]).toMatchObject({ cell: "due-cell", alpha: 1, beta: 1 })
  })
  test("[MUST-FAIL] waiting on a person when the deadline passed, and the person's own grade is the first row after it: no lapse", () => {
    const w = world()
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: w.ask.id })
    const answer = row("answer", "described", { text: "t", selection_ref: aSel.id, input_refs: [w.ask.id] }, 10_000)
    const s = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: w.ask.id })
    const wait = row("failure", "walk", { call_id: "c1", selection_ref: s.id, status: 409, waits_for: "person", input_refs: [s.id] }, 20_000)
    const mark = row("outcome", "person", { r: 0, input_refs: [answer.id] }, 120_000) // the first row past the deadline
    const g = lapseOf([...w.base, aSel, answer, s, wait, mark], w.due)
    expect(g?.ok).toBe(false)
  })
  test("[MUST-FAIL] none while a call on the ask waits on a person; a later person grade overtakes it", () => {
    const w = world()
    const s = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: w.ask.id })
    const wait = row("failure", "walk", { call_id: "c1", selection_ref: s.id, status: 409, waits_for: "person", input_refs: [s.id] }, 10_000)
    const waiting = [...w.base, s, wait, tick(120_000)]
    expect(lapseOf(waiting, w.due)).toMatchObject({ ok: false, refused: "person_wait" })
    const w2 = world()
    const at = tick(120_000)
    const mark = row("outcome", "person", { r: 0, input_refs: [w2.ask.id] }, 130_000)
    expect(lapseOf([...w2.base, at, mark], w2.due)).toMatchObject({ ok: false, refused: "person_later" })
  })
})
