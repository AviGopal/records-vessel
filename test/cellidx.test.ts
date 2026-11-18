// SPDX-License-Identifier: MIT
// The posterior fold (foldFrom) splits each cell string once per read and finds each queried cell's grades by index,
// built per read: not by filtering every grade, splitting both cells on every comparison, once per queried cell and level.
//
// The answers are the ones records gave before this change: test/fixtures/cellidx-snapshot.json was written once by
// test/fixtures/cellidx-run.ts run with records 55c1eeb1's src/fold.ts (the parent), over the stores in cellidx-rows.ts
// (levels, seps, order), episode-rows.ts's mixed, gaps and walked, and calledin-rows.ts's earned, at every prefix of each
// store's rows and three (as_of, at) points per prefix, every alpha and beta as its 64 bits. The same runner, run on this
// tree, must give the same.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"
import { answersAt, snapshot, STORES, type Snap } from "./fixtures/cellidx-run"
import { ORDER_CELL, ORDER_SIBLING, order, queryOf, SEPS } from "./fixtures/cellidx-rows"

const SNAPSHOT = (await Bun.file(`${import.meta.dir}/fixtures/cellidx-snapshot.json`).json()) as Snap

// Every String.prototype.split call while f runs.
const splits = (f: () => void): number => {
  const split = String.prototype.split
  let n = 0
  String.prototype.split = function (this: string, ...args: unknown[]) { n++; return (split as (...a: unknown[]) => string[]).apply(this, args) } as typeof split
  try { f() } finally { String.prototype.split = split }
  return n
}

describe("what a posterior read's cells cost", () => {
  // A store of failures blaming the request on six cells (two moves; an asker, another asker, none), each failure one r 0
  // grade, and a query of those cells and four no grade names (so each level is looked at), repeated to `options`.
  let seq = 0
  const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
    ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
  const CELLS = ["call/a|asker:person,s:1", "call/a|asker:operator,s:1", "call/a|s:1", "call/b|asker:person,s:1", "call/b|asker:operator,s:2", "call/b|s:2"]
  const UNSEEN = ["call/a|asker:person,s:9", "call/a|s:9", "call/b|asker:nobody", "call/c|asker:person"]
  const world = (failures: number, options: number) => {
    seq = 0
    const rows: Row[] = [row("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4 })]
    for (let i = 0; i < failures; i++) {
      const cell = CELLS[i % CELLS.length]!
      const s = row("selection", "walk", { arm: "treated", cell, a: cell.split("|")[0] })
      rows.push(s, row("failure", "walk", { selection_ref: s.id, status: 422, blames: "request" }))
    }
    const base = [...CELLS, ...UNSEEN]
    return { rows, cells: Array.from({ length: options }, (_, i) => base[i % base.length]!) }
  }
  // splits in one read, after a first read of the same rows (so the grade folds' kept answers are not what is counted)
  const perRead = (failures: number, options: number): number => {
    const w = world(failures, options)
    F.foldFrom(w.rows, w.cells, 1e9, 1e9)
    return splits(() => F.foldFrom(w.rows, w.cells, 1e9, 1e9))
  }

  test("[MUST-FAIL] the cell strings a read splits do not grow with the options times the grades", () => {
    const small = perRead(30, 20)
    const large = perRead(120, 80)
    // four times the grades and four times the options over the same cell strings: the same strings to split
    expect({ grows: large / small > 1.25, perRead: [small, large] }).toEqual({ grows: false, perRead: [small, large] })
  })
})

describe("the posts are the parent's, bit for bit", () => {
  const got = snapshot(F)
  test("the same stores, the same queries", () => {
    expect(Object.keys(got)).toEqual(Object.keys(SNAPSHOT))
    for (const [name, want] of Object.entries(SNAPSHOT)) expect([name, got[name]!.rows, got[name]!.query]).toEqual([name, want.rows, want.query])
  })
  for (const name of Object.keys(STORES)) {
    test(`${name}: at every prefix, the three answers' sha; the last prefix's answers whole`, () => {
      const want = SNAPSHOT[name]!
      for (const n of Object.keys(want.prefixes)) expect([name, n, got[name]!.prefixes[n]]).toEqual([name, n, want.prefixes[n]!])
      expect(got[name]!.last).toEqual(want.last)
      expect(got[name]!.from).toEqual(want.from)
    })
  }

  // What the parent answered, read from the snapshot: so an equal answer is equal over the cases that matter.
  test("the snapshot covers each level: posts from a cell's own grades, the asker's, the move's and none", () => {
    for (const name of ["levels", "seps"]) for (const level of ["cell", "asker", "move", "none"]) expect([name, level, (SNAPSHOT[name]!.from[level] ?? 0) > 0]).toEqual([name, level, true])
  })

  test("two reads of different rows, interleaved, each answer as the parent did (nothing is kept from one read for the next)", () => {
    const stores = ["order", "levels", "seps", "order", "levels"]
    for (const name of stores) {
      const rows = STORES[name]!()
      expect([name, answersAt(F, rows, queryOf(rows), rows.length)]).toEqual([name, SNAPSHOT[name]!.last])
    }
  })
})

describe("a sum is added in the order the grades are in", () => {
  test("three weights on one cell sum to another float in reverse; the cell and its asker-level sibling read the forward sum", () => {
    const xs = [0, 1, 2].map((k) => Math.pow(0.7, k) * 0.1)
    const forward = xs.reduce((s, x) => s + x, 0)
    const reverse = [...xs].reverse().reduce((s, x) => s + x, 0)
    expect(1 + forward).not.toBe(1 + reverse)
    const rows = order()
    const [own, sibling] = F.foldFrom(rows, [ORDER_CELL, ORDER_SIBLING], 1e9, rows.length)
    expect(own).toEqual({ cell: ORDER_CELL, alpha: 1 + forward, beta: 1, from: "cell" })
    expect(sibling).toEqual({ cell: ORDER_SIBLING, alpha: 1 + forward, beta: 1, from: "asker" })
  })
})

describe("a cell string is split as before, whatever separators it holds", () => {
  // the parent's split, verbatim (records 55c1eeb1 src/fold.ts)
  const move = (c: string): string => c.split("|")[0]
  const asker = (c: string): string | undefined => c.split("|").slice(1).join("|").split(",").find((t) => t.startsWith("asker:"))

  test("each unusual cell's move and asker are the per-comparison split's", () => {
    const odd = [...SEPS, "||", "|||asker:x", "asker:", "a|asker:x,asker:y|z", "a|b|c,asker:q", " |asker:p", "a|asker:p ", "a|ASKER:p"]
    for (const c of odd) expect([c, F.cellParts(c)]).toEqual([c, { move: move(c), asker: asker(c) }])
  })

  test("what those splits are, for the forms the levels turn on", () => {
    expect(F.cellParts("|asker:person")).toEqual({ move: "", asker: "asker:person" })
    expect(F.cellParts("call/x|asker:")).toEqual({ move: "call/x", asker: "asker:" })
    expect(F.cellParts("call/x|asker:a,asker:b")).toEqual({ move: "call/x", asker: "asker:a" })
    expect(F.cellParts("call/x|asker:a|b")).toEqual({ move: "call/x", asker: "asker:a|b" })
    expect(F.cellParts("call/x|world,asker:a|b,c")).toEqual({ move: "call/x", asker: "asker:a|b" })
    expect(F.cellParts("call/x")).toEqual({ move: "call/x", asker: undefined })
    expect(F.cellParts("")).toEqual({ move: "", asker: undefined })
    expect(F.cellParts("call/x,asker:person|shapes:1")).toEqual({ move: "call/x,asker:person", asker: undefined })
    expect(F.cellParts("asker:person")).toEqual({ move: "asker:person", asker: undefined })
  })

  test("a store whose grades are on those cells folds as the parent's did (the seps snapshot), and every cell was graded", () => {
    const want = SNAPSHOT.seps!
    const rows = STORES.seps!()
    expect(answersAt(F, rows, queryOf(rows), rows.length)).toEqual(want.last)
    const posts = F.foldFrom(rows, SEPS, 1e9, rows.length)
    expect(posts.filter((p) => p.from !== "cell").map((p) => p.cell)).toEqual([])
  })

  test("a query cell that is not a string fails the read where it did: only when some grade has a cell", () => {
    const rows = STORES.seps!()
    expect(() => F.foldFrom(rows, [5 as unknown as string], 1e9, rows.length)).toThrow(TypeError)
    expect(F.foldFrom(rows.slice(0, 2), [5 as unknown as string], 1e9, 2)).toEqual([{ cell: 5 as unknown as string, alpha: 1, beta: 1, from: "none" }])
  })
})
