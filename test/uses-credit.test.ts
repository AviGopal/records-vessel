// SPDX-License-Identifier: MIT
// A run's credit is earned by a run that ended well (qa, agf_dagr3azgkhbr; research): a produce whose uses names a run's
// output credits that run and the selection that minted its template when the run ended ok, on any root; a failed run is
// a stop; a template named itself passes credit only when an ok run of it made a row the produce also consumed.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
const row = (shape: string, role: string, fields: Record<string, unknown>): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: "", input_refs: [], ...fields }) as Row
const T = { gamma: 0.7, depth: 12 } as any

const chain = (opts: { failed?: boolean; otherRoot?: boolean; uses: "hop" | "template" | "both"; by?: string }) => {
  seq = 0
  const schema = row("shape_schema", "owner", { target: "answer", inputs: ["world_changed"] })
  const ask = row("world_changed", "person", { what: "q" })
  const other = row("world_changed", "person", { what: "elsewhere" })
  const mintSel = row("selection", "walk", { arm: "treated", cell: "mint", a: "produce/activity_template/ch", root: ask.id })
  const tpl = row("activity_template", "described", { selection_ref: mintSel.id, calls: [] })
  const runSel = row("selection", "walk", { arm: "treated", cell: "run", a: `run/${tpl.id}`, root: opts.otherRoot ? other.id : ask.id })
  const hop = row("hop", "walk", { phase: "ended", selection_ref: runSel.id })
  const fail = opts.failed ? [row("failure", "walk", { selection_ref: runSel.id, kind: "error" })] : []
  const ansSel = row("selection", "walk", { arm: "treated", cell: "answer", a: "produce/answer/ch", root: ask.id })
  const uses = opts.uses === "hop" ? [hop.id] : opts.uses === "template" ? [tpl.id] : [hop.id, tpl.id]
  const answer = row("answer", "described", { text: "t", selection_ref: ansSel.id, input_refs: [ask.id, hop.id, tpl.id], uses })
  const rows = [schema, ask, other, mintSel, tpl, runSel, hop, ...fail, ansSel, answer]
  return { got: F.reached(F.indexOf(rows), ansSel.id, T, { by: opts.by ?? "person", r: 1 }), runSel, mintSel }
}
const has = (m: Map<string, number>, id: string) => m.has(id)

describe("uses credits a run only when it ended well", () => {
  test("[GUARD] an ok run's output credits the run and its template's mint", () => {
    const c = chain({ uses: "hop" })
    expect([c.got.get(c.runSel.id), c.got.get(c.mintSel.id)]).toEqual([0.7, 0.7 * 0.7])
  })
  test("[GUARD] a failed run's output credits neither the run nor its mint (a stop)", () => {
    const c = chain({ uses: "hop", failed: true })
    expect([has(c.got, c.runSel.id), has(c.got, c.mintSel.id)]).toEqual([false, false])
  })
  test("[GUARD] another root's ok run output credits both for a person's grade (a plan reused elsewhere is the transfer)", () => {
    const c = chain({ uses: "hop", otherRoot: true })
    expect([has(c.got, c.runSel.id), has(c.got, c.mintSel.id)]).toEqual([true, true])
  })
  test("[GUARD] for the walk's own grader's r 1, a run on another root is that root's work: neither it nor the mint behind it", () => {
    const c = chain({ uses: "hop", otherRoot: true, by: "described" })
    expect([has(c.got, c.runSel.id), has(c.got, c.mintSel.id)]).toEqual([false, false])
  })
  test("[GUARD] a template named with no ok run of it consumed credits its mint nothing; with one, it does", () => {
    const shownOnly = chain({ uses: "template" })
    expect(has(shownOnly.got, shownOnly.mintSel.id)).toBe(false)
    const failedRun = chain({ uses: "both", failed: true })
    expect(has(failedRun.got, failedRun.mintSel.id)).toBe(false)
    const withRun = chain({ uses: "both" })
    expect(has(withRun.got, withRun.mintSel.id)).toBe(true)
  })
})
