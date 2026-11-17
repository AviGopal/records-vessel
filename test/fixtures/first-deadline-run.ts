// SPDX-License-Identifier: MIT
// Writes first-deadline-snapshot.json: for each leg of first-deadline-rows.ts, fresh.grades serialised (ser: in order,
// Sets and Maps in insertion order and sorted) at every prefix (asOf = atSeq = each seq, over the whole list), and the
// facts the coverage test reads. Run it on the parent's tree, never on a tree that changes the fold:
//   bun test/fixtures/first-deadline-run.ts test/fixtures/first-deadline-snapshot.json
import { writeFileSync } from "node:fs"
import { fresh } from "../../src/fold"
import type { Row } from "../../src/store"
import { LEGS, seqs, ser, world } from "./first-deadline-rows"

const legs: Record<string, { rows: number; prefixes: Record<string, string> }> = {}
for (const [name, make] of Object.entries(LEGS)) {
  const rows = make()
  const prefixes: Record<string, string> = {}
  for (const n of seqs(rows)) prefixes[n] = ser(fresh.grades(rows, n, n))
  legs[name] = { rows: rows.length, prefixes }
}
// how each grade fared at the last prefix, per form of the fixture; P's and Q's grades before and after their shared
// deadline; and G's grade before and after its deadline row
const why = (rows: ReturnType<typeof world>["rows"]) => fresh.grades(rows, Infinity, Infinity).map((g) => g.ok ? "counted" : String(g.refused))
const { rows, gFirst, gDue, pair } = world()
const fared = (ids: Row[]) => { const gs = fresh.grades(rows, Infinity, Infinity); return ids.map((r) => { const x = gs.find((y) => y.id === r.id); return x?.ok ? "counted" : String(x?.refused) }) }
const g = (n: number) => fresh.grades(rows, n, n).find((x) => x.id === gFirst.id)
const coverage = {
  ordered: why(rows), flipped: why(world({ flip: true }).rows), unordered: why(world({ unordered: true }).rows),
  pair: { early: fared(pair.early), late: fared(pair.late) },
  g: { before: g(gFirst.seq)?.refused ?? "counted", after: g(gDue.seq)?.ok ? "counted" : String(g(gDue.seq)?.refused) },
}
writeFileSync(process.argv[2]!, `${JSON.stringify({ legs, coverage }, null, 1)}\n`)
