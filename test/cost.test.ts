// SPDX-License-Identifier: MIT
// A read that refolded grades over the whole store says so, with what it cost (agf_jyvv57fbu5ot: hsv's reads timed out
// with nothing logged on either side); a read that reused the kept fold writes nothing.
import { describe, expect, test } from "bun:test"
import { costed } from "../src/cost"
import { drainRefolds, grades } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const outcome = (): Row => ({ shape: "outcome", role: "described", writer: "described", id: `o-${++seq}`, seq, t: "", input_refs: [], r: 1 }) as Row

describe("a read's cost", () => {
  test("[MUST-FAIL] a fold the read had to redo is logged, naming the fold, its rows and the query; a kept one is not", () => {
    const rows: Row[] = [outcome(), outcome()]
    const lines: string[] = []
    const read = () => costed("record_read", { shape: "outcome" }, () => grades(rows, seq, seq), (l) => lines.push(l))
    read()
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/^\[records\] record_read took \d+ ms; refolded gradesOf \d+ ms over 2 rows; query outcome$/)
    read() // nothing written since: the kept fold answers
    expect(lines.length).toBe(1)
    rows.push(outcome()) // the store moved: the next read refolds
    read()
    expect(lines[1]).toContain("over 3 rows")
  })

  test("a read that folds nothing writes no line", () => {
    const lines: string[] = []
    expect(costed("record_read", { shape: "request" }, () => 7, (l) => lines.push(l))).toBe(7)
    expect(lines).toEqual([])
  })

  test("[MUST-FAIL] the memo records each miss once and the drain empties it", () => {
    drainRefolds()
    const rows: Row[] = [outcome()]
    grades(rows, seq, seq)
    grades(rows, seq, seq)
    expect(drainRefolds().map((f) => [f.fold, f.rows])).toEqual([["gradesOf", 1]])
    expect(drainRefolds()).toEqual([])
  })

describe("what the line says of the query", () => {
  test("[MUST-FAIL] a where value of person text never reaches the line: its shape, field names and value lengths only", () => {
    const rows: Row[] = [outcome()]
    const lines: string[] = []
    const q = { type: "record_read", shape: "answer", refs_to: "root-abc", where: { role: "person", note: "my private words" } }
    costed("record_read", q, () => grades(rows, seq, seq), (l) => lines.push(l))
    expect(lines[0]).not.toContain("my private words")
    expect(lines[0]).not.toContain("root-abc")
    expect(lines[0]).toEndWith("query answer refs_to:10 where{role:8,note:18}")
  })
})
})
