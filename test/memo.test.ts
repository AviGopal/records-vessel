// SPDX-License-Identifier: MIT
// Grades are computed once per (asOf, atSeq) over one row list, and every reader (the posterior, the tally, closing,
// standing) shares that answer. The checks that keep a kept answer honest:
//   V1: a selection's recorded posterior, refolded from the rows at its own posts_seq and its arm's as_of_seq, agrees;
//   V2: the kept answers equal a full rebuild from the same rows (a new list, so nothing kept is reused).
import { describe, expect, test } from "bun:test"
import { foldFrom, grades, gapClosures, moveFailures, tally, verifySelections } from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row

// A store as the walk grows it: the owner's credits row and the walk's arm, asks, selections recorded with the posterior
// records answered at that moment, answers, the walk's own grades, person verdicts, a failure blaming the request.
const build = (): { rows: Row[]; asOf: number; record: (cell: string, cands?: string[]) => Row } => {
  seq = 0
  const rows: Row[] = []
  const add = (r: Row): Row => { rows.push(r); return r }
  add(row("credits", "owner", { target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.7, depth: 12 }))
  // as_of_seq bounds which grades count; past every row here, so all of them do.
  const AS_OF = 1e9
  const arm = add(row("arm", "owner", { vessel_id: "walk", arm: "treated", as_of_seq: AS_OF }))
  // A selection as the walk writes it: the posterior records answers now, for each cand's cell, in cands order.
  const record = (cell: string, cands: string[] = ["other|x"]): Row => {
    const cells = [cell, ...cands]
    const posts = foldFrom(rows, cells, AS_OF, seq).map(({ alpha, beta, from }) => ({ alpha, beta, from }))
    const s = row("selection", "walk", { writer: "walk", arm: "treated", cell, a: cell.split("|")[0], posts, posts_seq: seq,
      cands: cells.map((c) => ({ id: c.split("|")[0], kind: "produce", root: "root-1" })), root: "root-1" })
    s.writer = "walk"
    return add(s)
  }
  for (let i = 0; i < 6; i++) {
    const ask = add(row("world_changed", "person", { what: `q${i}` }))
    const sel = record(`produce/answer|world_changed,asker:person,age:${i % 3}`)
    const answer = add(row("answer", "described", { selection_ref: sel.id, input_refs: [ask.id] }))
    const judge = record("produce/outcome|asker:person")
    add(row("outcome", "described", { r: i % 2, selection_ref: judge.id, input_refs: [ask.id, answer.id] }))
    if (i % 2 === 0) add(row("outcome", "person", { r: 1, input_refs: [answer.id] }))
    if (i === 3) {
      const call = record("call/fs_edit|asker:person")
      add(row("failure", "walk", { writer: "walk", selection_ref: call.id, status: 422, blames: "request" }))
    }
  }
  void arm
  return { rows, asOf: AS_OF, record }
}

describe("the scenario carries evidence", () => {
  test("posteriors move: grades are found and person verdicts and a request-blamed failure fold in", () => {
    const { rows, asOf } = build()
    expect(grades(rows, asOf, seq).length).toBeGreaterThan(5)
    const [a, f] = foldFrom(rows, ["produce/answer|world_changed,asker:person,age:0", "produce/outcome|asker:person"], asOf, seq)
    expect(a.alpha + a.beta).toBeGreaterThan(2)
    const sels = rows.filter((r) => r.shape === "selection")
    expect(sels.some((s) => (s.posts as Array<{ alpha: number; beta: number }>).some((p) => p.alpha + p.beta > 2))).toBe(true)
    void f
  })
})

describe("grades computed once, shared", () => {
  test("[MUST-FAIL] the same list at the same point answers with the same grades, not a recomputation", () => {
    const { rows, asOf } = build()
    expect(grades(rows, asOf, seq)).toBe(grades(rows, asOf, seq))
    expect(moveFailures(rows, asOf, seq)).toBe(moveFailures(rows, asOf, seq))
    expect(gapClosures(rows, asOf, seq)).toBe(gapClosures(rows, asOf, seq))
  })

  test("[MUST-FAIL] a row appended is seen: a kept answer for a shorter list is never served", () => {
    const { rows, asOf } = build()
    // The same (asOf, atSeq) before and after the append: only the list's length tells them apart.
    const AT = 1e9
    const before = grades(rows, asOf, AT).length
    const ask = rows.find((r) => r.shape === "world_changed")!
    const answer = rows.find((r) => r.shape === "answer")!
    rows.push(row("outcome", "person", { r: 0, input_refs: [answer.id, ask.id] }))
    expect(grades(rows, asOf, AT).length).toBe(before + 1)
  })

  test("another list (a copy) is its own: nothing kept for one is served for the other", () => {
    const { rows, asOf } = build()
    const g = grades(rows, asOf, seq)
    const copy = [...rows]
    expect(grades(copy, asOf, seq)).not.toBe(g)
    expect(grades(copy, asOf, seq)).toEqual(g)
  })
})

describe("V2: kept answers equal a rebuild from the rows", () => {
  test("[MUST-FAIL] posteriors and the tally from the kept grades equal those rebuilt from a fresh list, at every point as rows are added", () => {
    const { rows, asOf, record } = build()
    const cells = ["produce/answer|world_changed,asker:person,age:0", "produce/outcome|asker:person", "call/fs_edit|asker:person", "never|seen"]
    for (let k = 0; k < 4; k++) {
      // the kept path: warm the shared answers first, as a running records does
      tally(rows, asOf, seq)
      const kept = foldFrom(rows, cells, asOf, seq)
      const rebuilt = foldFrom([...rows], cells, asOf, seq)
      expect(kept).toEqual(rebuilt)
      expect(tally(rows, asOf, seq)).toEqual(tally([...rows], asOf, seq))
      // earlier points, read from the same list
      for (const at of [Math.floor(seq / 3), Math.floor(seq / 2)]) expect(foldFrom(rows, cells, asOf, at)).toEqual(foldFrom([...rows], cells, asOf, at))
      const ask = rows.push(row("world_changed", "person", { what: `more${k}` }))
      void ask
      record(cells[0])
    }
  })
})

describe("V1: a selection's recorded posterior refolds from the rows", () => {
  test("[MUST-FAIL] every selection the walk recorded agrees with a refold at its posts_seq, after the store has grown", () => {
    const { rows } = build()
    const sels = rows.filter((r) => r.shape === "selection")
    const v = verifySelections(rows, sels)
    expect(v.checked).toBe(sels.length)
    expect(v.skipped).toBe(0)
    expect(v.mismatches).toEqual([])
  })

  test("[MUST-FAIL] a recorded posterior that is not the fold's is reported, with both values", () => {
    const { rows } = build()
    const sels = rows.filter((r) => r.shape === "selection")
    const bent = { ...sels[2], posts: (sels[2].posts as Array<{ alpha: number; beta: number }>).map((p, i) => i === 0 ? { ...p, alpha: p.alpha + 1 } : p) } as Row
    const v = verifySelections(rows, [bent])
    expect(v.mismatches.map((m) => [m.selection, m.recorded.alpha - m.refolded.alpha])).toEqual([[bent.id, 1]])
  })

  test("a selection that does not say enough to refold is counted as skipped, not as agreeing", () => {
    const { rows } = build()
    const bare = row("selection", "walk", { writer: "walk", arm: "treated" })
    expect(verifySelections(rows, [bare])).toEqual({ checked: 0, skipped: 1, mismatches: [] })
  })
})
