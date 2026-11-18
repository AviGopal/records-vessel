// SPDX-License-Identifier: MIT
// The posterior fold's answers over cellidx-rows.ts's stores and episode-rows.ts's mixed, gaps and walked and
// calledin-rows.ts's earned, at every prefix of each store's rows: for each prefix n, foldFrom over a list of exactly
// those rows (a list of its own, as a store holds) for the store's query (queryOf) at (as_of 1e9, at n), (as_of n/2
// rounded up, at n) and (as_of 1e9, at 2n/3 rounded down). Each post is written as [cell, alpha, beta, from] with alpha and
// beta as the hex of their 64 bits (every float exactly, -0 and NaN included); a prefix's three answers are kept as the
// sha256 of that JSON, the last prefix's in full.
// snapshot(F) takes a fold module; run as a script it imports the fold.ts it is given and writes the answer:
//   bun test/fixtures/cellidx-run.ts <fold.ts> <out.json>
// Run on the parent's tree (records 55c1eeb1) it wrote cellidx-snapshot.json.
import { writeFileSync } from "node:fs"
import type { Row } from "../../src/store"
import { earnedWorld } from "./calledin-rows"
import { levels, order, queryOf, seps } from "./cellidx-rows"
import { gaps, mixed, walked } from "./episode-rows"

type Fold = { foldFrom: (all: Row[], cells: string[], asOf: number, atSeq: number) => Array<{ cell: string; alpha: number; beta: number; from: string }> }
export type Snap = Record<string, { rows: number; query: number; from: Record<string, number>; prefixes: Record<string, string>; last: unknown[] }>

export const STORES: Record<string, () => Row[]> = { levels, seps, order, mixed, gaps, walked, earned: earnedWorld }
const bits = (x: number): string => { const v = new DataView(new ArrayBuffer(8)); v.setFloat64(0, x); return v.getBigUint64(0).toString(16).padStart(16, "0") }
export const exact = (posts: Array<{ cell: string; alpha: number; beta: number; from: string }>): unknown[] => posts.map((p) => [p.cell, bits(p.alpha), bits(p.beta), p.from])
const sha = (s: string): string => new Bun.CryptoHasher("sha256").update(s).digest("hex")

export const answersAt = (F: Fold, rows: Row[], cells: string[], n: number): unknown[] => {
  const list = rows.slice(0, n)
  return [[1e9, n], [Math.ceil(n / 2), n], [1e9, Math.floor((2 * n) / 3)]].map(([asOf, at]) => exact(F.foldFrom(list, cells, asOf!, at!)))
}

export const snapshot = (F: Fold): Snap => {
  const out: Snap = {}
  for (const [name, make] of Object.entries(STORES)) {
    const rows = make()
    const cells = queryOf(rows)
    const from: Record<string, number> = {}
    const prefixes: Record<string, string> = {}
    let last: unknown[] = []
    for (let n = 1; n <= rows.length; n++) {
      const got = answersAt(F, rows, cells, n)
      for (const a of got) for (const p of a as Array<[string, string, string, string]>) from[p[3]] = (from[p[3]] ?? 0) + 1
      prefixes[n] = sha(JSON.stringify(got))
      last = got
    }
    out[name] = { rows: rows.length, query: cells.length, from, prefixes, last }
  }
  return out
}

if (import.meta.main) {
  const F = (await import(process.argv[2]!)) as Fold
  writeFileSync(process.argv[3]!, `${JSON.stringify(snapshot(F))}\n`)
}
