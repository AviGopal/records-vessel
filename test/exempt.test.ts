// SPDX-License-Identifier: MIT
// A promise is exempt from the grader until its ask's first deadline (the USER, 11-16: "Exempt until deadline"): a
// grade the walk's grader wrote of a promising answer before then counts for nothing ("exempt"); a person's is not.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const T0 = Date.parse("2026-11-15T12:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + seq * 1000).toISOString(), input_refs: [], ...fields }) as Row

// The shape database's replay found on 489 (e.g. 48542 judging 48466): the owner's entry, the ask, its first due a day
// ahead, an answer carrying next_act, and an r 0 from the walk's grader judging that answer before the due.
const world = (opts: { entry?: boolean; next?: unknown; dueAt?: number | null; gradeAt?: number; by?: string } = {}) => {
  seq = 0
  const schema = row("shape_schema", "owner", { target: "outcome", context: ["answer", "due"], ...(opts.entry === false ? {} : { evidence: [{ shape: "answer", deferred_by: "next_act" }, { shape: "due", after: "at" }] }) })
  const ask = row("world_changed", "person", { what: "q" })
  const dueSel = row("selection", "walk", { arm: "treated", cell: "due", root: ask.id })
  const due = opts.dueAt === null ? undefined : row("due", "described", { within_ms: 86_400_000, at: opts.dueAt ?? T0 + 86_400_000, selection_ref: dueSel.id, input_refs: [ask.id] })
  const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: ask.id })
  const answer = row("answer", "described", { text: "t", selection_ref: aSel.id, input_refs: [ask.id], ...("next" in opts ? (opts.next === undefined ? {} : { next_act: opts.next }) : { next_act: { tool: "git_land" } }) })
  const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: ask.id })
  const grade = row("outcome", opts.by ?? "described", { r: 0, selection_ref: gSel.id, input_refs: [ask.id, answer.id], evidence_refs: [answer.id],
    ...(opts.gradeAt === undefined ? {} : { t: new Date(opts.gradeAt).toISOString() }) })
  const rows = [schema, ask, dueSel, ...(due ? [due] : []), aSel, answer, gSel, grade]
  const g = F.grades(rows, seq, seq).find((x) => x.id === grade.id)
  return g?.ok ? "counted" : g?.refused
}

describe("a promise is exempt from the grader until its first deadline", () => {
  test("[MUST-FAIL] the grader's r 0 on a promising answer before its ask's first deadline counts for nothing", () => {
    expect(world()).toBe("exempt")
  })
  test("[MUST-FAIL] once the first deadline has come, the same grade counts", () => {
    expect(world({ dueAt: T0 + 1000, gradeAt: T0 + 60_000 })).toBe("counted")
  })
  test("[MUST-FAIL] the FIRST deadline decides: a later due still ahead does not exempt it again", () => {
    seq = 0
    const schema = row("shape_schema", "owner", { target: "outcome", context: ["answer", "due"], evidence: [{ shape: "answer", deferred_by: "next_act" }] })
    const ask = row("world_changed", "person", { what: "q" })
    const first = row("due", "described", { within_ms: 1000, at: T0 + 1000, input_refs: [ask.id] })
    const later = row("due", "described", { within_ms: 86_400_000, at: T0 + 86_400_000, input_refs: [ask.id] })
    const aSel = row("selection", "walk", { arm: "treated", cell: "answer", root: ask.id })
    const answer = row("answer", "described", { text: "t", next_act: { tool: "git_land" }, selection_ref: aSel.id, input_refs: [ask.id] })
    const gSel = row("selection", "walk", { arm: "treated", cell: "judge", root: ask.id })
    const grade = row("outcome", "described", { r: 0, selection_ref: gSel.id, input_refs: [ask.id, answer.id], evidence_refs: [answer.id] })
    const g = F.grades([schema, ask, first, later, aSel, answer, gSel, grade], seq, seq).find((x) => x.id === grade.id)
    expect(g?.ok ? "counted" : g?.refused).toBe("counted")
  })
  test("[MUST-FAIL] with no deadline yet, it is exempt (no deadline has come)", () => {
    expect(world({ dueAt: null })).toBe("exempt")
  })
  test("[MUST-FAIL] a claim (no next_act, or null) is graded at once; without the owner's entry nothing is exempt", () => {
    expect([world({ next: undefined }), world({ next: null }), world({ entry: false })]).toEqual(["counted", "counted", "counted"])
  })
  test("[MUST-FAIL] a person's grade of a promise is never exempt", () => {
    expect(world({ by: "person" })).toBe("counted")
  })
})
