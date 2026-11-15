// SPDX-License-Identifier: MIT
// The fold's levels nest (the USER, 11-15: "Inherit, then refine"): a cell's prior is the record of the finest coarser
// level that has one (the same move for the same asker, then the move anywhere), counted without the grades that reach
// the cell itself, and its own grades add on top, so it never forgets. The owner may cap how much is inherited
// (prior_count on the credits row); with no cap the whole record is inherited.
import { describe, expect, test } from "bun:test"
import { foldFrom, verifySelections } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

const BASE = { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 }
const OLD = "run/t1|world_changed,asker:person,age:0" // where the move earned its record
const NEW = "run/t1|world_changed,did:gitWorktree,asker:person,age:0" // the same move in a new context

const build = (credits: Record<string, unknown>) => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", credits))
  // a move's failure blaming the request: one r 0 on that selection's own cell (moveFailures)
  const fail = (cell: string) => {
    const s = add(row("selection", "walk", { arm: "treated", cell, a: cell.split("|")[0] }))
    add(row("failure", "walk", { selection_ref: s.id, status: 422, blames: "request" }))
  }
  const post = (cell: string) => foldFrom(rows, [cell], 1e9, 1e9)[0]
  return { rows, add, fail, post }
}

describe("a cell inherits its move's record (nested levels)", () => {
  test("[MUST-FAIL] seventeen failures at the asker's level, then one in a new cell: β ≥ 18 (the USER's never-forgets case; no cap)", () => {
    const b = build(BASE)
    for (let i = 0; i < 17; i++) b.fail(OLD)
    expect(b.post(NEW)).toMatchObject({ alpha: 1, beta: 18, from: "asker" })
    b.fail(NEW)
    const after = b.post(NEW)
    expect(after.beta).toBeGreaterThanOrEqual(18)
    expect(after).toMatchObject({ alpha: 1, beta: 19, from: "cell" })
  })

  test("[MUST-FAIL] with a cap above the record, one new debit adds to what the cell inherited; it never drops below it", () => {
    const b = build({ ...BASE, prior_count: 20 })
    for (let i = 0; i < 17; i++) b.fail(OLD)
    const before = b.post(NEW)
    expect(before).toMatchObject({ alpha: 1, beta: 18, from: "asker" })
    b.fail(NEW)
    const after = b.post(NEW)
    expect(after.beta).toBe(before.beta + 1)
    expect(after.from).toBe("cell")
  })

  test("an owner's cap is the owner's word: seventeen failures inherited under prior_count 5 count as five (the cap forgets, by choice)", () => {
    const b = build({ ...BASE, prior_count: 5 })
    for (let i = 0; i < 17; i++) b.fail(OLD)
    expect(b.post(NEW)).toMatchObject({ alpha: 1, beta: 6 })
  })

  test("[MUST-FAIL] a cell with its own record still moves on its own grades, and they are not counted twice", () => {
    const b = build({ ...BASE, prior_count: 20 })
    for (let i = 0; i < 4; i++) b.fail(OLD)
    // the old cell's own record: its 4 debits once, with no coarser record beyond them (they are its own)
    expect(b.post(OLD)).toMatchObject({ alpha: 1, beta: 5, from: "cell" })
    b.fail(OLD)
    expect(b.post(OLD).beta).toBe(6)
  })

  test("[MUST-FAIL] the live request cell's shape: two own failures and 29 inherited read α1 β32 uncapped, α1 β7 at the seeded cap 4", () => {
    for (const [cap, beta] of [[undefined, 32], [4, 7]] as const) {
      const b = build(cap === undefined ? BASE : { ...BASE, prior_count: cap })
      for (let i = 0; i < 29; i++) b.fail(OLD)
      b.fail(NEW); b.fail(NEW)
      expect(b.post(NEW)).toMatchObject({ alpha: 1, beta, from: "cell" })
    }
  })

  test("an owner prior on the exact cell is kept as its prior instead of the inherited record", () => {
    const b = build({ ...BASE, prior_count: 20 })
    for (let i = 0; i < 17; i++) b.fail(OLD)
    b.add(row("prior", "owner", { cell: NEW, alpha0: 3, beta0: 1 }))
    expect(b.post(NEW)).toMatchObject({ alpha: 3, beta: 1 })
  })

  test("[MUST-FAIL] V1: a selection drawn from a nested cell refolds to the posterior it recorded", () => {
    const b = build({ ...BASE, prior_count: 20 })
    for (let i = 0; i < 6; i++) b.fail(OLD)
    b.fail(NEW)
    b.add(row("arm", "owner", { vessel_id: "walk", arm: "treated", as_of_seq: 1e9 }))
    const posts = foldFrom(b.rows, [NEW], 1e9, seq).map(({ alpha, beta }) => ({ alpha, beta }))
    const s = b.add(row("selection", "walk", { writer: "walk", arm: "treated", cell: NEW, a: "run/t1", posts, posts_seq: seq, cands: [{ id: "run/t1" }] }))
    s.writer = "walk"
    expect(posts[0].beta).toBe(1 + 6 + 1)
    const v = verifySelections(b.rows, [s])
    expect([v.checked, v.mismatches]).toEqual([1, []])
  })
})
