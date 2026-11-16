// SPDX-License-Identifier: MIT
// A lapse a person overtook, or one written while the request waited on a person (the USER, 11-16: "Yes, your later
// grade reopens it"; "No lapse while waiting"): it counts for nothing, so it closes nothing and debits no one.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(1_000_000 + seq * 1000).toISOString(), input_refs: [], ...fields }) as Row

const world = () => {
  seq = 0
  const ask = row("world_changed", "person", { what: "q" })
  const dueSel = row("selection", "walk", { arm: "treated", cell: "due", a: "produce/due/ch", root: ask.id })
  const due = row("due", "described", { within_ms: 1, at: 1_000_000, selection_ref: dueSel.id, input_refs: [ask.id] })
  const diffSel = row("selection", "walk", { arm: "treated", cell: "diff", a: "call/git_diff", root: ask.id })
  const diff = row("gitDiff", "walk", { tree: "t", selection_ref: diffSel.id, input_refs: [ask.id] })
  const lapse = () => {
    const s = row("selection", "walk", { arm: "treated", cell: "judge", a: "produce/outcome/ch", root: ask.id })
    return [s, row("outcome", "described", { r: 0, selection_ref: s.id, input_refs: [ask.id, due.id], evidence_refs: [due.id] })]
  }
  const waiting = () => {
    const s = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: ask.id })
    return [s, row("failure", "walk", { call_id: "c1", selection_ref: s.id, status: 409, waits_for: "person", input_refs: [s.id] })]
  }
  return { ask, base: [ask, dueSel, due, diffSel, diff], diff, lapse, waiting }
}
const standingOf = (rows: Row[], id: string) => {
  const g = F.grades(rows, seq, seq).find((x) => x.id === id)
  return g?.ok ? "counted" : g?.refused
}

describe("a lapse a person overtook", () => {
  test("[MUST-FAIL] alone, a lapse counts (the request closed as failed)", () => {
    const w = world(); const l = w.lapse()
    expect(standingOf([...w.base, ...l], l[1].id)).toBe("counted")
  })
  test("[MUST-FAIL] a person's later grade on the request's diff reopens it, r 1 or r 0 (the USER's ruling); the lapse debits no one", () => {
    for (const r of [1, 0]) {
      const w = world(); const l = w.lapse()
      const mark = row("land_verdict", "person", { r, tree: "t", input_refs: [w.diff.id] })
      expect(standingOf([...w.base, ...l, mark], l[1].id)).toBe("person_later")
    }
  })
  test("[MUST-FAIL] a note with no grade, a model grade, a mark on another request, or on an owner row does not reopen", () => {
    const w = world(); const l = w.lapse()
    const note = row("world_changed", "person", { what: "fine", input_refs: [w.ask.id] })
    expect(standingOf([...w.base, ...l, note], l[1].id)).toBe("counted")
    const model = row("land_verdict", "described", { r: 1, tree: "t", input_refs: [w.diff.id] })
    expect(standingOf([...w.base, ...l, model], l[1].id)).toBe("counted")
    const other = row("world_changed", "person", { what: "other" })
    const otherDiff = row("gitDiff", "walk", { tree: "u", input_refs: [other.id] })
    const elsewhere = row("land_verdict", "person", { r: 1, tree: "u", input_refs: [otherDiff.id] })
    expect(standingOf([...w.base, ...l, other, otherDiff, elsewhere], l[1].id)).toBe("counted")
    const owner = row("repository", "owner", { repo: "x" })
    const onOwner = row("land_verdict", "person", { r: 1, tree: "t", input_refs: [owner.id] })
    expect(standingOf([...w.base, owner, ...l, onOwner], l[1].id)).toBe("counted")
  })
  test("[MUST-FAIL] a person's mark before the lapse does not overtake it: the latest decides", () => {
    const w = world()
    const early = row("land_verdict", "person", { r: 1, tree: "t", input_refs: [w.diff.id] })
    const l = w.lapse()
    expect(standingOf([...w.base, early, ...l], l[1].id)).toBe("counted")
  })
})

describe("a lapse while the request waited on a person", () => {
  test("[MUST-FAIL] is a fact: it counts for nothing (no close, no debit); a person row in between ends the wait", () => {
    const w = world(); const wait = w.waiting(); const l = w.lapse()
    expect(standingOf([...w.base, ...wait, ...l], l[1].id)).toBe("person_wait")
    const w2 = world(); const wait2 = w2.waiting()
    const word = row("world_changed", "person", { what: "go on", input_refs: [w2.ask.id] })
    const l2 = w2.lapse()
    expect(standingOf([...w2.base, ...wait2, word, ...l2], l2[1].id)).toBe("counted")
  })
  test("[MUST-FAIL] another request's wait does not make this lapse a fact", () => {
    const w = world()
    const otherSel = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: "someone-else" })
    const otherWait = row("failure", "walk", { call_id: "c9", selection_ref: otherSel.id, status: 409, waits_for: "person", input_refs: [otherSel.id] })
    const l = w.lapse()
    expect(standingOf([...w.base, otherSel, otherWait, ...l], l[1].id)).toBe("counted")
  })
})
