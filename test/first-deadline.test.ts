// SPDX-License-Identifier: MIT
// An ask's first deadline (fold.ts gradesOf firstDeadline, read by the promise exemption) is found in one pass over the
// rows per fold, not a filter and a sort over all of them per exempt check. Measured before, on a 77k-row store: 58.7% of
// gradesOf (762 ms of ~1,300 ms, 103 calls, 7.9M rows visited).
//
// The grades are the parent's: test/fixtures/first-deadline-snapshot.json was written once by
// test/fixtures/first-deadline-run.ts run on the parent's tree (the commit names it), over the rows in
// first-deadline-rows.ts: for each leg, the grades at every prefix (asOf = atSeq = each seq, over the whole list, so a
// later row is in the list but not seen), serialised in order. This tree's grades must serialise the same. A change that
// moves a grade on purpose writes the snapshot on its own tree, and its commit names every grade it moved.
import { describe, expect, test } from "bun:test"
import { fresh } from "../src/fold"
import type { Row } from "../src/store"
import { exemptWorld, LEGS, seqs, ser, world } from "./fixtures/first-deadline-rows"

type Snapshot = { legs: Record<string, { rows: number; prefixes: Record<string, string> }>; coverage: { ordered: string[]; flipped: string[]; unordered: string[]; pair: { early: string[]; late: string[] }; g: { before: string; after: string } } }
const SNAPSHOT = (await Bun.file(`${import.meta.dir}/fixtures/first-deadline-snapshot.json`).json()) as Snapshot

describe("an ask's first deadline is the parent's", () => {
  test("the snapshot holds every leg", () => {
    expect(Object.keys(SNAPSHOT.legs)).toEqual(Object.keys(LEGS))
  })
  for (const [name, make] of Object.entries(LEGS)) {
    test(`${name}: the grades equal the parent's at every prefix, in order`, () => {
      const rows = make()
      const want = SNAPSHOT.legs[name]!
      expect([rows.length, seqs(rows).map(String)]).toEqual([want.rows, Object.keys(want.prefixes)])
      for (const n of seqs(rows)) {
        expect([n, ser(fresh.grades(rows, n, n))]).toEqual([n, want.prefixes[n]!])
      }
    })
  }

  // What the legs turn on, read from the parent's answers: so equal grades are equal over the cases that matter.
  test("the fixtures exempt some grades and count others, and the same-seq order changes a grade", () => {
    const { ordered, flipped, unordered, g } = SNAPSHOT.coverage
    expect(ordered.filter((x) => x === "exempt").length).toBeGreaterThanOrEqual(3)
    expect(ordered.filter((x) => x === "counted").length).toBeGreaterThanOrEqual(3)
    expect(flipped).not.toEqual(ordered)
    expect(unordered).toEqual(ordered)
    // G: graded before its first deadline row was written, in the same millisecond, with no time allowed: exempt while
    // that row is not seen (though it is in the list), counted once it is
    const { gFirst, gDue } = world()
    expect(gDue.t).toBe(gFirst.t)
    expect(g).toEqual({ before: "exempt", after: "counted" })
    // P and Q: one deadline row citing both asks decides each one's exemption, the second ref as much as the first
    expect(SNAPSHOT.coverage.pair).toEqual({ early: ["exempt", "exempt"], late: ["counted", "counted"] })
  })
})

describe("what the first deadline costs", () => {
  // Every row's `role` is read through a getter that counts, as the scan unit counted reads of the store's list: the
  // fold reads `role` about once per row per pass, so a pass per exempt check shows as K more reads per row.
  const readsOf = (fold: typeof fresh.grades, rows: Row[]): { reads: number; exempt: number } => {
    let reads = 0
    for (const r of rows) {
      let v = r.role
      Object.defineProperty(r, "role", { get: () => { reads++; return v }, set: (x) => { v = x }, enumerable: true, configurable: true })
    }
    const n = rows.length
    reads = 0
    const gs = fold(rows, n, n)
    return { reads, exempt: gs.filter((g) => g.refused === "exempt").length }
  }
  test("[MUST-FAIL] the rows read to find first deadlines in one fold do not grow with the number of exempt checks", () => {
    const N = 600
    const ten = readsOf(fresh.grades, exemptWorld(10, N))
    const forty = readsOf(fresh.grades, exemptWorld(40, N))
    expect([ten.exempt, forty.exempt]).toEqual([10, 40])
    const per = (x: { reads: number }) => x.reads / N
    // the same N rows: forty exempt checks read each row about as often as ten do, not thirty times more
    expect({ ratio: per(forty) / per(ten) <= 1.25, perRow: [per(ten), per(forty)] }).toEqual({ ratio: true, perRow: [per(ten), per(forty)] })
  })
})
