// SPDX-License-Identifier: MIT
// The closure grades decided lazily (fold.ts gapClosuresOf: a chain gathered only for a closure that landed) are the
// grades the full scan gives (gapClosuresScan), at every prefix of the rows and for several asOf, with closures that land
// and that do not, a failure and an ended call written after the cut, and a change of the owner's rule.
import { describe, expect, test } from "bun:test"
import { gapChainsGathered, gapClosuresScan, gapClosures } from "../src/fold"
import type { Row } from "../src/store"
import { slowRows } from "./fixtures/slow-store"

const plain = (gs: unknown[]) => JSON.stringify(gs, (_k, v) => (v instanceof Set ? [...v] : v instanceof Map ? [...v] : v))

// A store where closures land: a selection holding an open gap row calls the rule's tool, its hop ends, the gap closes.
const landing = (): Row[] => {
  const out: Row[] = []
  let seq = 0
  const add = (r: Record<string, unknown>): Row => { const row = { input_refs: [], t: "", ...r, seq: ++seq, id: `x-${seq}` } as Row; out.push(row); return row }
  add({ shape: "credits", role: "owner", writer: "owner", target: "gap", by_call: "git_land" })
  for (let g = 0; g < 4; g++) {
    const open = add({ shape: "gap", role: "detector", writer: "detector", gap_id: `g${g}`, status: "open" })
    const helpers = [0, 1, 2].map((i) => add({ shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: `call/x|c${g}${i}`, pool_refs: [open.id, `other-${i}`] }))
    add({ shape: "selection", role: "walk", writer: "walk", arm: "treated", cell: `call/y|unheld${g}`, pool_refs: ["nothing"] })
    if (g !== 1) {
      const lander = helpers[2]!
      add({ shape: "hop", role: "walk", writer: "walk", phase: "started", call_id: `call-${g}`, pointer_type: "git_land", selection_ref: lander.id })
      if (g !== 2) add({ shape: "hop", role: "walk", writer: "walk", phase: "ended", call_id: `call-${g}` })
    }
    if (g === 3) add({ shape: "failure", role: "walk", writer: "walk", kind: "refused", selection_ref: helpers[0]!.id })
    add({ shape: "gap", role: "detector", writer: "detector", gap_id: `g${g}`, status: "closed" })
    // written after the closure: an ended call of an unlanded one, and a failure of a credited selection
    if (g === 2) add({ shape: "hop", role: "walk", writer: "walk", phase: "ended", call_id: `call-${g}` })
    if (g === 0) add({ shape: "failure", role: "walk", writer: "walk", kind: "refused", selection_ref: helpers[1]!.id })
  }
  add({ shape: "credits", role: "owner", writer: "owner", target: "gap", by_call: "git_commit" })
  return out
}

describe("closure grades, decided lazily", () => {
  test("[MUST-FAIL] equal to the full scan at every prefix and several asOf, landing and not, rows after the cut", () => {
    const all = landing()
    let landed = 0
    for (let n = 1; n <= all.length; n++) {
      const rows = all.slice(0, n)
      const head = rows[rows.length - 1]!.seq
      for (const asOf of [0, Math.floor(head / 2), head, Number.MAX_SAFE_INTEGER]) {
        for (const atSeq of [head, Math.max(1, head - 3)]) {
          const want = gapClosuresScan(rows, asOf, atSeq)
          expect([n, asOf, atSeq, plain(gapClosures(rows, asOf, atSeq))]).toEqual([n, asOf, atSeq, plain(want)])
          landed += want.filter((g) => g.ok).length
        }
      }
    }
    expect(landed).toBeGreaterThan(0) // the fixture does land closures, so the chain path is exercised
  })

  test("[MUST-FAIL] equal on a wide store where nothing lands, and no chain is gathered there", () => {
    const rows = slowRows(1000, 100, 60) as unknown as Row[]
    const head = rows.length
    const want = gapClosuresScan(rows, Number.MAX_SAFE_INTEGER, head)
    const before = gapChainsGathered()
    const got = gapClosures(rows, Number.MAX_SAFE_INTEGER, head)
    expect(plain(got)).toBe(plain(want))
    expect(want.length).toBe(60)
    expect(gapChainsGathered() - before).toBe(0) // the work counted, not timed: no closure here landed
  }, 120_000)
})
