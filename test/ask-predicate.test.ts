// SPDX-License-Identifier: MIT
// What an ask is, wherever a deadline is read (asks.ts isAsk): the derived lapse, the promise exemption and the open
// roots read one predicate. A person's grade (an outcome, or any verdict) cited by a deadline is not an ask, so a
// deadline citing it is never its lapse. The request's own first deadline still lapses when it passes ungraded; once it
// has, a later deadline citing the request and the grade derives nothing (every deadline lapses only an ask still open).
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// far in the wall clock's future, so only the store's own clock (its newest row) can say a deadline has passed
const T0 = Date.parse("2099-01-01T10:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields }) as Row
const tick = (at: number) => row("hop", "walk", { phase: "ended" }, at)
const lapseOf = (rows: Row[], due: Row) => F.grades(rows, seq, seq).find((g) => g.by === F.LAPSE && g.judged === due.id)
const failedBy = (rows: Row[]) => F.standing(rows, seq, seq).filter((g) => g.r === 0 && g.deadline).map((g) => g.judged)

// The form the due context made: the ask's own first due, an answer, the person's Wrong of it, and a later due that cites
// both the ask and that Wrong (outcome latest_by role keep), with a short window that passes.
const world = (opts: { role?: string; shape?: string; firstAt?: number; wrong?: (answer: Row) => Row } = {}) => {
  seq = 0
  const ask = row(opts.shape ?? "world_changed", opts.role ?? "person", { what: "q" })
  const s1 = row("selection", "walk", { arm: "treated", cell: "due-cell", root: ask.id })
  const d1 = row("due", "described", { within_ms: 3_600_000, at: T0 + (opts.firstAt ?? 3_600_000), selection_ref: s1.id, input_refs: [ask.id] })
  const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: ask.id })
  const answer = row("answer", "described", { text: "done", selection_ref: aSel.id, input_refs: [ask.id] }, 5_000)
  const wrong = (opts.wrong ?? ((a) => row("outcome", "person", { r: 0, input_refs: [a.id] }, 10_000)))(answer)
  const s2 = row("selection", "walk", { arm: "treated", cell: "due-cell", root: ask.id })
  const d2 = row("due", "described", { within_ms: 60_000, at: T0 + 70_000, selection_ref: s2.id, input_refs: [ask.id, wrong.id] }, 10_000)
  return { ask, d1, d2, wrong, rows: [ask, s1, d1, aSel, answer, wrong, s2, d2] }
}

describe("a person's grade cited by a deadline is not an ask", () => {
  test("[MUST-FAIL] a due citing [ask, person's Wrong] that passes after the ask's own due lapsed it: no lapse from the Wrong", () => {
    const w = world({ firstAt: 60_000 })
    const rows = [...w.rows, tick(120_000)]
    expect(lapseOf(rows, w.d2)).toBeUndefined()
    expect(failedBy(rows)).toEqual([w.d1.id])
  })
  test("[GUARD] the ask's own first due still lapses when it passes ungraded (deadlines always count)", () => {
    const w = world({ firstAt: 60_000 })
    const rows = [...w.rows, tick(120_000)]
    expect(lapseOf(rows, w.d1)).toMatchObject({ ok: true, r: 0, deadline: true })
    expect(failedBy(rows)).toContain(w.d1.id)
  })
  test("[MUST-FAIL] the ask's first due lapses, and no second lapse comes from the Wrong's first citing due", () => {
    const w = world({ firstAt: 60_000 })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toBeUndefined()
  })
  test("[MUST-FAIL] any verdict a person wrote is a grade, not an ask: a land_verdict r 0 cited by the due", () => {
    const w = world({ firstAt: 60_000, wrong: (a) => row("land_verdict", "person", { r: 0, input_refs: [a.id] }, 10_000) })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toBeUndefined()
  })
  test("[GUARD] a person's row with r but citing nothing is no verdict: it is an ask, and its first due lapses", () => {
    const w = world({ firstAt: 60_000, wrong: () => row("note", "person", { r: 0 }, 10_000) })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toMatchObject({ ok: true, r: 0 })
  })
  test("[GUARD] a person's row with r 0 and no input_refs at all cites nothing: it is an ask, and its first due lapses", () => {
    const w = world({ firstAt: 60_000, wrong: () => { const x = row("note", "person", { r: 0 }, 10_000) as Record<string, unknown>; delete x.input_refs; return x as Row } })
    expect("input_refs" in w.wrong).toBe(false)
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toMatchObject({ ok: true, r: 0 })
  })
  test("[GUARD] a person's row with r neither 0 nor 1 judges nothing: it is an ask", () => {
    const w = world({ firstAt: 60_000, wrong: (a) => row("note", "person", { r: 0.5, input_refs: [a.id] }, 10_000) })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toMatchObject({ ok: true, r: 0 })
  })
  test("[MUST-FAIL] a person's r 1 cited by the due is a grade too", () => {
    const w = world({ firstAt: 60_000, wrong: (a) => row("land_verdict", "person", { r: 1, input_refs: [a.id] }, 10_000) })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toBeUndefined()
  })
  test("[MUST-FAIL] a person's outcome is a grade whatever its r: one with r 0.5 cited by the due is no ask", () => {
    const w = world({ firstAt: 60_000, wrong: (a) => row("outcome", "person", { r: 0.5, input_refs: [a.id] }, 10_000) })
    expect(lapseOf([...w.rows, tick(120_000)], w.d2)).toBeUndefined()
  })
  test("[GUARD] a due citing a row the store does not hold still lapses for the ask it cites", () => {
    const w = world({ firstAt: 60_000 })
    const d1 = { ...w.d1, input_refs: [w.ask.id, "no-such-row"] } as Row
    const rows = [...w.rows.map((r) => (r.id === d1.id ? d1 : r)), tick(120_000)]
    expect(lapseOf(rows, d1)).toMatchObject({ ok: true, r: 0 })
  })
  for (const role of ["owner", "operator"]) {
    test(`[GUARD] an ${role}'s ask still counts: its first due lapses`, () => {
      const w = world({ role, firstAt: 60_000 })
      expect(lapseOf([...w.rows, tick(120_000)], w.d1)).toMatchObject({ ok: true, r: 0 })
    })
  }
  test("[GUARD] a row the walk or described wrote is no ask: its due never lapses", () => {
    const w = world({ role: "described", firstAt: 60_000 })
    expect(lapseOf([...w.rows, tick(120_000)], w.d1)).toBeUndefined()
  })
  test("[MUST-FAIL] undeclared, an owner's configuration row or template is no ask: its due never lapses", () => {
    for (const shape of ["shape_schema", "activity_template"]) {
      const w = world({ role: "owner", shape, firstAt: 60_000 })
      expect([shape, lapseOf([...w.rows, tick(120_000)], w.d1)]).toEqual([shape, undefined])
    }
  })
})

describe("once asks are declared, only a declared shape is an ask", () => {
  const mark = () => row("shape_schema", "owner", { target: "request", inputs: [{ shape: "world_changed", ask: true }] })
  test("[MUST-FAIL] a person's row of an undeclared shape is no ask: its due does not lapse", () => {
    const w = world({ shape: "note", firstAt: 60_000 })
    expect(lapseOf([mark(), ...w.rows, tick(120_000)], w.d1)).toBeUndefined()
  })
  test("[GUARD] only the owner's schema declares: the same mark written by described declares nothing", () => {
    const w = world({ shape: "note", firstAt: 60_000 })
    const byDescribed = { ...mark(), role: "described", writer: "described" } as Row
    expect(lapseOf([byDescribed, ...w.rows, tick(120_000)], w.d1)).toMatchObject({ ok: true, r: 0 })
  })
  test("[GUARD] only a shape_schema declares: an owner row of another shape carrying the same mark declares nothing", () => {
    const w = world({ shape: "note", firstAt: 60_000 })
    const channel = row("channel", "owner", { calls: [], inputs: [{ shape: "world_changed", ask: true }] })
    expect(lapseOf([channel, ...w.rows, tick(120_000)], w.d1)).toMatchObject({ ok: true, r: 0 })
  })
  test("[GUARD] a person's world_changed is: its first due lapses", () => {
    const w = world({ firstAt: 60_000 })
    expect(lapseOf([mark(), ...w.rows, tick(120_000)], w.d1)).toMatchObject({ ok: true, r: 0 })
  })
  test("[GUARD] declared, a walk's world_changed is still no ask", () => {
    const w = world({ role: "walk", firstAt: 60_000 })
    expect(lapseOf([mark(), ...w.rows, tick(120_000)], w.d1)).toBeUndefined()
  })
  test("[GUARD] the mark is read from the rows at the fold's seq: a mark written after it declares nothing yet", () => {
    const w = world({ shape: "note", firstAt: 60_000 })
    const rows = [...w.rows, tick(120_000)]
    const at = seq
    const later = mark()
    expect(F.grades([...rows, later], at, at).find((g) => g.by === F.LAPSE && g.judged === w.d1.id)).toMatchObject({ ok: true, r: 0 })
  })
})

describe("a promise's exemption reads asks by the same predicate", () => {
  // the owner's entry, the ask, its first due a day ahead; an answer, the person's Wrong of it, and a later due citing the
  // ask and the Wrong that has already passed; then a promising answer the walk's grader judges r 0 before the first due
  const promise = (wrongShape = "outcome") => {
    seq = 0
    const schema = row("shape_schema", "owner", { target: "outcome", context: ["answer", "due"], evidence: [{ shape: "answer", deferred_by: "next_act" }, { shape: "due", after: "at" }] })
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = row("selection", "walk", { arm: "treated", cell: "due", root: ask.id })
    const d1 = row("due", "described", { within_ms: 86_400_000, at: T0 + 86_400_000, selection_ref: s1.id, input_refs: [ask.id] })
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: ask.id })
    const first = row("answer", "described", { text: "t", selection_ref: aSel.id, input_refs: [ask.id] }, 1_000)
    const wrong = row(wrongShape, "person", { r: 0, input_refs: [first.id] }, 2_000)
    const s2 = row("selection", "walk", { arm: "treated", cell: "due", root: ask.id })
    const d2 = row("due", "described", { within_ms: 1_000, at: T0 + 3_000, selection_ref: s2.id, input_refs: [ask.id, wrong.id] }, 2_000)
    const bSel = row("selection", "walk", { arm: "treated", cell: "answer", root: ask.id })
    const next = row("answer", "described", { text: "t", next_act: { tool: "git_land" }, selection_ref: bSel.id, input_refs: [ask.id, wrong.id] }, 4_000)
    const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: ask.id })
    const grade = row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [ask.id, next.id], evidence_refs: [next.id] }, 60_000)
    const g = F.grades([schema, ask, s1, d1, aSel, first, wrong, s2, d2, bSel, next, gSel, grade], seq, seq).find((x) => x.id === grade.id)
    return g?.ok ? "counted" : g?.refused
  }
  test("[MUST-FAIL] a person's Wrong cited by the promising answer gives it no deadline: exempt until the ask's own first due", () => {
    expect(promise()).toBe("exempt")
  })
  test("[MUST-FAIL] the same for any verdict a person wrote", () => {
    expect(promise("land_verdict")).toBe("exempt")
  })
  test("[MUST-FAIL] once asks are declared, a promise citing only a person's row of another shape is graded: that row is no ask", () => {
    seq = 0
    const schema = row("shape_schema", "owner", { target: "outcome", context: ["answer", "due"], evidence: [{ shape: "answer", deferred_by: "next_act" }, { shape: "due", after: "at" }] })
    const mark = row("shape_schema", "owner", { target: "request", inputs: [{ shape: "world_changed", ask: true }] })
    const note = row("note", "person", { what: "q" })
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: note.id })
    const next = row("answer", "described", { text: "t", next_act: { tool: "git_land" }, selection_ref: aSel.id, input_refs: [note.id] }, 1_000)
    const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: note.id })
    const grade = row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [note.id, next.id], evidence_refs: [next.id] }, 2_000)
    const rows = [schema, mark, note, aSel, next, gSel, grade]
    const of = (rs: Row[]) => { const g = F.grades(rs, seq, seq).find((x) => x.id === grade.id); return g?.ok ? "counted" : g?.refused }
    // undeclared, the person's note is an ask with no deadline yet: the promise is exempt; declared, it is not one
    expect([of(rows.filter((r) => r !== mark)), of(rows)]).toEqual(["exempt", "counted"])
  })
})
