// SPDX-License-Identifier: MIT
// A lapse a person overtook, or one written while the request waited on a person (the USER, 11-16: "Yes, your later
// grade reopens it"; "No lapse while waiting"): it counts for nothing, so it closes nothing and debits no one.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// The store's clock is its rows' t, rising with seq. A lapse (lapse() below) moves it past the request's deadline: the
// rule's own lapse (fold.ts, derived, no row) then decides at the first row written after that (the USER: "Yes, a fixed
// rule records it"; a model's grade of a deadline counts for nothing).
let clock = 0
const DEADLINE = 1_000_000 + 500_000
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(1_000_000 + clock + seq * 1000).toISOString(), input_refs: [], ...fields }) as Row

const world = () => {
  seq = 0
  clock = 0
  const ask = row("world_changed", "person", { what: "q" })
  const dueSel = row("selection", "walk", { arm: "treated", cell: "due", a: "produce/due/ch", root: ask.id })
  const due = row("due", "described", { within_ms: 1, at: DEADLINE, selection_ref: dueSel.id, input_refs: [ask.id] })
  const diffSel = row("selection", "walk", { arm: "treated", cell: "diff", a: "call/git_diff", root: ask.id })
  const diff = row("gitDiff", "walk", { tree: "t", selection_ref: diffSel.id, input_refs: [ask.id] })
  // the deadline passes: the first row written after it is where the rule's lapse decides
  const lapse = () => {
    clock = DEADLINE
    return [row("hop", "walk", { phase: "ended", call_id: "tick" })]
  }
  const waiting = () => {
    const s = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: ask.id })
    return [s, row("failure", "walk", { call_id: "c1", selection_ref: s.id, status: 409, waits_for: "person", input_refs: [s.id] })]
  }
  return { ask, base: [ask, dueSel, due, diffSel, diff], diff, lapse, waiting }
}
// how the rule's lapse on the request's deadline stands
const LAPSED = "the rule's lapse"
const standingOf = (rows: Row[], _id: string) => {
  const g = F.grades(rows, seq, seq).find((x) => x.by === F.LAPSE)
  return g?.ok ? "counted" : g?.refused
}

describe("a lapse a person overtook", () => {
  test("[MUST-FAIL] alone, a lapse counts (the request closed as failed)", () => {
    const w = world(); const l = w.lapse()
    expect(standingOf([...w.base, ...l], LAPSED)).toBe("counted")
  })
  test("[MUST-FAIL] a person's later grade on the request's diff reopens it, r 1 or r 0 (the USER's ruling); the lapse debits no one", () => {
    for (const r of [1, 0]) {
      const w = world(); const l = w.lapse()
      const mark = row("land_verdict", "person", { r, tree: "t", input_refs: [w.diff.id] })
      expect(standingOf([...w.base, ...l, mark], LAPSED)).toBe("person_later")
    }
  })
  test("[MUST-FAIL] a note with no grade, a model grade, a mark on another request, or on an owner row does not reopen", () => {
    const w = world(); const l = w.lapse()
    const note = row("world_changed", "person", { what: "fine", input_refs: [w.ask.id] })
    expect(standingOf([...w.base, ...l, note], LAPSED)).toBe("counted")
    const model = row("land_verdict", "described", { r: 1, tree: "t", input_refs: [w.diff.id] })
    expect(standingOf([...w.base, ...l, model], LAPSED)).toBe("counted")
    const other = row("world_changed", "person", { what: "other" })
    const otherDiff = row("gitDiff", "walk", { tree: "u", input_refs: [other.id] })
    const elsewhere = row("land_verdict", "person", { r: 1, tree: "u", input_refs: [otherDiff.id] })
    expect(standingOf([...w.base, ...l, other, otherDiff, elsewhere], LAPSED)).toBe("counted")
    const owner = row("repository", "owner", { repo: "x" })
    const onOwner = row("land_verdict", "person", { r: 1, tree: "t", input_refs: [owner.id] })
    expect(standingOf([...w.base, owner, ...l, onOwner], LAPSED)).toBe("counted")
  })
  test("[MUST-FAIL] a person's mark before the lapse does not overtake it: the latest decides", () => {
    const w = world()
    const early = row("land_verdict", "person", { r: 1, tree: "t", input_refs: [w.diff.id] })
    const l = w.lapse()
    expect(standingOf([...w.base, early, ...l], LAPSED)).toBe("counted")
  })
})

describe("a lapse while the request waited on a person", () => {
  test("[MUST-FAIL] is a fact: it counts for nothing (no close, no debit); a person row in between ends the wait", () => {
    const w = world(); const wait = w.waiting(); const l = w.lapse()
    expect(standingOf([...w.base, ...wait, ...l], LAPSED)).toBe("person_wait")
    const w2 = world(); const wait2 = w2.waiting()
    const word = row("world_changed", "person", { what: "go on", input_refs: [w2.ask.id] })
    const l2 = w2.lapse()
    expect(standingOf([...w2.base, ...wait2, word, ...l2], LAPSED)).toBe("counted")
  })
  test("[MUST-FAIL] only a wait on a person makes it a fact: a timeout or refusal on the root, or a wait written after the lapse, leaves the lapse counted", () => {
    const w = world()
    const s = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: w.ask.id })
    const timeout = row("failure", "walk", { call_id: "c1", selection_ref: s.id, status: 504, blame: "callee", input_refs: [s.id] })
    const l = w.lapse()
    expect(standingOf([...w.base, s, timeout, ...l], LAPSED)).toBe("counted")
    const w2 = world(); const l2 = w2.lapse(); const later = w2.waiting()
    expect(standingOf([...w2.base, ...l2, ...later], LAPSED)).toBe("counted")
  })
  test("[MUST-FAIL] another request's wait does not make this lapse a fact", () => {
    const w = world()
    const otherSel = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: "someone-else" })
    const otherWait = row("failure", "walk", { call_id: "c9", selection_ref: otherSel.id, status: 409, waits_for: "person", input_refs: [otherSel.id] })
    const l = w.lapse()
    expect(standingOf([...w.base, otherSel, otherWait, ...l], LAPSED)).toBe("counted")
  })
})

describe("which answers promise (the owner's newest outcome schema)", () => {
  const ENTRY = [{ shape: "answer", deferred_by: "next_act" }]
  const schema = (fields: Record<string, unknown>, role = "owner") => row("shape_schema", role, { target: "outcome", context: ["answer"], ...fields })
  const promise = () => row("answer", "described", { text: "not yet", next_act: { tool: "git_land" } })
  test("[MUST-FAIL] the owner's newest non-variant schema decides; a guard: its entry makes a promise", () => {
    seq = 0
    const s = schema({ evidence: ENTRY }); const a = promise()
    expect(F.promises([s, a] as any, a as any)).toBe(true)
  })
  test("[MUST-FAIL] a schema row anyone but the owner wrote marks nothing", () => {
    seq = 0
    const s = schema({ evidence: ENTRY }, "described"); const a = promise()
    expect(F.promises([s, a] as any, a as any)).toBe(false)
  })
  test("[MUST-FAIL] a variant's schema marks nothing", () => {
    seq = 0
    const s = schema({ evidence: ENTRY, variant: "v2" }); const a = promise()
    expect(F.promises([s, a] as any, a as any)).toBe(false)
  })
  test("[MUST-FAIL] a newer owner schema without the entry turns promises off; a newer one with it turns them on", () => {
    seq = 0
    const old = schema({ evidence: ENTRY }); const now = schema({}); const a = promise()
    expect(F.promises([old, now, a] as any, a as any)).toBe(false)
    seq = 0
    const old2 = schema({}); const now2 = schema({ evidence: ENTRY }); const a2 = promise()
    expect(F.promises([old2, now2, a2] as any, a2 as any)).toBe(true)
  })
  test("[MUST-FAIL] an answer whose field is null or absent does not promise", () => {
    seq = 0
    const s = schema({ evidence: ENTRY })
    const nul = row("answer", "described", { text: "t", next_act: null }); const none = row("answer", "described", { text: "t" })
    expect([F.promises([s, nul] as any, nul as any), F.promises([s, none] as any, none as any)]).toEqual([false, false])
  })
})
