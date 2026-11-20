// SPDX-License-Identifier: MIT
// Every deadline, not only the first, lapses by rule (the USER, 11-20: "Later deadlines close it"). A person's later mark
// overtakes a lapse and reopens the ask; the ask's next deadline then lapses it unless the person marks again after
// that. The first lapse that stands closes the ask and later deadlines derive nothing: one debit per miss. A deadline
// citing several asks closes them all, so a mark on any open one of them refuses it, as it refuses a written lapse.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// far in the wall clock's future, so only the store's own clock (its newest row) can say a deadline has passed
const T0 = Date.parse("2099-01-01T10:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields }) as Row

const tick = (at: number) => row("hop", "walk", { phase: "ended" }, at) // any row: it moves the store's clock
const sel = (root: Row, cell: string, at: number) => row("selection", "walk", { arm: "treated", cell, root: root.id }, at)
const due = (s: Row, asks: Row[], written: number, within = 60_000) =>
  row("due", "described", { within_ms: within, at: T0 + written + within, selection_ref: s.id, input_refs: asks.map((a) => a.id) }, written)
const mark = (asks: Row[], at: number, r = 0) => row("outcome", "person", { r, input_refs: asks.map((a) => a.id) }, at)
const lapseOf = (rows: Row[], d: Row) => F.grades(rows, seq, seq).find((g) => g.by === F.LAPSE && g.judged === d.id)
// what closes an ask as failed: a standing r 0 on a deadline that cites it (store.ts closed())
const closedBy = (rows: Row[], ask: Row) => F.standing(rows, seq, seq)
  .filter((g) => g.r === 0 && g.deadline && [rows.find((r) => r.id === g.judged)?.input_refs].flat().includes(ask.id)).map((g) => g.judged)

describe("every deadline lapses by rule", () => {
  test("[MUST-FAIL] the first deadline's lapse overtaken by a person's r 0, the next deadline lapses: the ask closes failed", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = sel(ask, "due-1", 0)
    const d1 = due(s1, [ask], 0) // at 60 s
    const after1 = tick(70_000)
    const m = mark([ask], 80_000)
    const s2 = sel(ask, "due-2", 90_000)
    const d2 = due(s2, [ask], 90_000) // at 150 s
    const rows = [ask, s1, d1, after1, m, s2, d2, tick(160_000)]
    expect(lapseOf(rows, d1)).toMatchObject({ ok: false, refused: "person_later" })
    expect(lapseOf(rows, d2)).toMatchObject({ ok: true, r: 0, deadline: true })
    expect(closedBy(rows, ask)).toEqual([d2.id])
    expect(F.fold(rows, ["due-2"], seq, seq)[0]).toMatchObject({ cell: "due-2", beta: 2 })
  })
  test("[MUST-FAIL] a person's mark after the next lapse too refuses it, and the deadline after that is judged anew", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = sel(ask, "due-1", 0)
    const d1 = due(s1, [ask], 0)
    const rows: Row[] = [ask, s1, d1, tick(70_000), mark([ask], 80_000)]
    const s2 = sel(ask, "due-2", 90_000)
    const d2 = due(s2, [ask], 90_000)
    rows.push(s2, d2, tick(160_000), mark([ask], 170_000))
    const s3 = sel(ask, "due-3", 180_000)
    const d3 = due(s3, [ask], 180_000)
    rows.push(s3, d3, tick(250_000))
    expect([lapseOf(rows, d1)?.refused, lapseOf(rows, d2)?.refused, lapseOf(rows, d3)?.ok]).toEqual(["person_later", "person_later", true])
    expect(closedBy(rows, ask)).toEqual([d3.id])
  })
  test("[MUST-FAIL] a first deadline not the walk's treated arm closes nothing; the next treated one lapses", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = row("selection", "walk", { arm: "control", cell: "due-1", root: ask.id })
    const d1 = due(s1, [ask], 0)
    const s2 = sel(ask, "due-2", 10_000)
    const d2 = due(s2, [ask], 10_000)
    const rows = [ask, s1, d1, s2, d2, tick(120_000)]
    expect([lapseOf(rows, d1)?.refused, lapseOf(rows, d2)?.ok]).toEqual(["untreated", true])
  })
  test("[GUARD] three deadlines passed with no mark: the first lapses and closes the ask, the others derive nothing (one debit)", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s = sel(ask, "due-cell", 0)
    const ds = [due(s, [ask], 0), due(s, [ask], 1_000), due(s, [ask], 2_000)]
    const rows = [ask, s, ...ds, tick(120_000)]
    expect(ds.map((d) => lapseOf(rows, d)?.ok)).toEqual([true, undefined, undefined])
    expect(F.fold(rows, ["due-cell"], seq, seq)[0]).toMatchObject({ cell: "due-cell", beta: 2 })
  })
  test("[GUARD] deadlines are judged in seq order, whatever order the rows are listed in", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s = sel(ask, "due-cell", 0)
    const ds = [due(s, [ask], 0), due(s, [ask], 1_000), due(s, [ask], 2_000)]
    const rows = [tick(120_000), ...[...ds].reverse(), s, ask]
    expect(ds.map((d) => lapseOf(rows, d)?.ok)).toEqual([true, undefined, undefined])
  })
  test("[MUST-FAIL] a deadline citing two asks, one marked after it lapsed: refused, and neither closes by it", () => {
    seq = 0
    const a = row("world_changed", "person", { what: "a" })
    const b = row("world_changed", "person", { what: "b" })
    const s = sel(a, "due-cell", 0)
    const d = due(s, [b, a], 0) // b first: the mark on a, the second ask cited, still refuses it
    const rows = [a, b, s, d, tick(70_000), mark([a], 80_000), tick(90_000)]
    expect(lapseOf(rows, d)).toMatchObject({ ok: false, refused: "person_later" })
    expect([closedBy(rows, a), closedBy(rows, b)]).toEqual([[], []])
  })
  test("[MUST-FAIL] a deadline citing two asks passed while a call on either waits on a person: refused", () => {
    seq = 0
    const a = row("world_changed", "person", { what: "a" })
    const b = row("world_changed", "person", { what: "b" })
    const s = sel(a, "due-cell", 0)
    const land = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: a.id }, 1_000)
    const wait = row("failure", "walk", { call_id: "c1", selection_ref: land.id, status: 409, waits_for: "person", input_refs: [land.id] }, 2_000)
    const d = due(s, [b, a], 3_000)
    const rows = [a, b, s, land, wait, d, tick(120_000)]
    expect(lapseOf(rows, d)).toMatchObject({ ok: false, refused: "person_wait" })
    expect([closedBy(rows, a), closedBy(rows, b)]).toEqual([[], []])
  })
  test("[MUST-FAIL] after a shared deadline is refused, each cited ask's own later deadline still lapses it", () => {
    seq = 0
    const a = row("world_changed", "person", { what: "a" })
    const b = row("world_changed", "person", { what: "b" })
    const s = sel(a, "due-cell", 0)
    const shared = due(s, [a, b], 0)
    const rows: Row[] = [a, b, s, shared, tick(70_000), mark([a], 80_000)]
    const sa = sel(a, "due-a", 90_000)
    const da = due(sa, [a], 90_000)
    const sb = sel(b, "due-b", 95_000)
    const db = due(sb, [b], 95_000)
    rows.push(sa, da, sb, db, tick(200_000))
    expect([lapseOf(rows, shared)?.refused, lapseOf(rows, da)?.ok, lapseOf(rows, db)?.ok]).toEqual(["person_later", true, true])
    expect([closedBy(rows, a), closedBy(rows, b)]).toEqual([[da.id], [db.id]])
  })
  test("[MUST-FAIL] a later deadline passed while a call on the ask waits on a person: refused, nothing closes", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = sel(ask, "due-1", 0)
    const d1 = due(s1, [ask], 0)
    const rows: Row[] = [ask, s1, d1, tick(70_000), mark([ask], 80_000)]
    const land = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: ask.id }, 85_000)
    const wait = row("failure", "walk", { call_id: "c1", selection_ref: land.id, status: 409, waits_for: "person", input_refs: [land.id] }, 86_000)
    const s2 = sel(ask, "due-2", 90_000)
    const d2 = due(s2, [ask], 90_000)
    rows.push(land, wait, s2, d2, tick(160_000))
    expect(lapseOf(rows, d2)).toMatchObject({ ok: false, refused: "person_wait" })
    expect(closedBy(rows, ask)).toEqual([])
  })
  // an ask already closed by a person's Right is still cited by the shared deadline: closing it again changes nothing, so
  // its mark or its wait on a person refuses nothing, and the open ask beside it lapses
  const reachedPair = () => {
    seq = 0
    const a = row("world_changed", "person", { what: "a" })
    const b = row("world_changed", "person", { what: "b" })
    const aSel = sel(a, "answer", 0)
    const answer = row("answer", "described", { text: "done", selection_ref: aSel.id, input_refs: [a.id] }, 1_000)
    const right = row("outcome", "person", { r: 1, input_refs: [answer.id] }, 2_000)
    return { a, b, rows: [a, b, aSel, answer, right] as Row[] }
  }
  test("[GUARD] a shared deadline whose closed ask a person marks after it passed: the open ask lapses", () => {
    const { a, b, rows } = reachedPair()
    const s = sel(b, "due-cell", 3_000)
    const shared = due(s, [b, a], 3_000)
    rows.push(s, shared, tick(70_000), mark([a], 80_000))
    const sa = sel(a, "due-a", 90_000)
    const da = due(sa, [a], 90_000)
    rows.push(sa, da, tick(200_000))
    expect(lapseOf(rows, da)).toBeUndefined() // a stays closed by its Right
    expect(lapseOf(rows, shared)).toMatchObject({ ok: true, r: 0 })
    expect(closedBy(rows, b)).toEqual([shared.id])
  })
  test("[GUARD] a shared lapse standing over a closed ask changes nothing of it: its Right stands, and the lapse credits only the open ask's chain", () => {
    const { a, b, rows } = reachedPair()
    const s = sel(b, "due-cell", 3_000)
    const shared = due(s, [b, a], 3_000)
    rows.push(s, shared, tick(70_000))
    const right = rows[4]!
    const standing = F.standing(rows, seq, seq)
    expect(standing.find((g) => g.id === right.id)).toMatchObject({ ok: true, r: 1, by: "person" })
    expect([...(lapseOf(rows, shared)?.cells ?? [])]).toEqual(["due-cell"])
    expect(F.fold(rows, ["answer"], seq, seq)[0]).toMatchObject({ cell: "answer", beta: 1 })
  })
  test("[GUARD] every deadline citing an open ask beside a closed one with a call waiting on a person: the first passed lapses it", () => {
    const { a, b, rows } = reachedPair()
    const land = row("selection", "walk", { arm: "treated", cell: "land", a: "call/git_land", root: a.id }, 3_000)
    const wait = row("failure", "walk", { call_id: "c1", selection_ref: land.id, status: 409, waits_for: "person", input_refs: [land.id] }, 4_000)
    const s = sel(b, "due-cell", 5_000)
    const ds = [due(s, [b, a], 5_000), due(s, [b, a], 6_000), due(s, [b, a], 7_000), due(s, [b, a], 8_000)]
    rows.push(land, wait, s, ...ds, tick(120_000))
    expect(ds.map((d) => lapseOf(rows, d)?.ok)).toEqual([true, undefined, undefined, undefined])
    expect(closedBy(rows, b)).toEqual([ds[0]!.id])
  })
  test("[GUARD] a deadline citing two asks stands: it closes both, and a later deadline on the second derives nothing", () => {
    seq = 0
    const a = row("world_changed", "person", { what: "a" })
    const b = row("world_changed", "person", { what: "b" })
    const s = sel(a, "due-cell", 0)
    const shared = due(s, [a, b], 0)
    const sb = sel(b, "due-b", 1_000)
    const db = due(sb, [b], 1_000)
    const rows = [a, b, s, shared, sb, db, tick(120_000)]
    expect([lapseOf(rows, shared)?.ok, lapseOf(rows, db)]).toEqual([true, undefined])
  })
  test("[GUARD] a passed deadline a person graded r 0 is theirs: no lapse is derived, and a later deadline derives nothing", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = sel(ask, "due-1", 0)
    const d1 = due(s1, [ask], 0)
    const late = row("outcome", "person", { r: 0, input_refs: [d1.id] }, 70_000)
    const s2 = sel(ask, "due-2", 80_000)
    const d2 = due(s2, [ask], 80_000)
    const rows = [ask, s1, d1, tick(65_000), late, s2, d2, tick(200_000)]
    expect(F.grades(rows, seq, seq).filter((g) => g.judged === d1.id).map((g) => g.by)).toEqual(["person"])
    expect(lapseOf(rows, d2)).toBeUndefined()
  })
  test("[GUARD] a person's Right on a result closes the ask: no later deadline lapses", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const aSel = sel(ask, "answer", 0)
    const answer = row("answer", "described", { text: "done", selection_ref: aSel.id, input_refs: [ask.id] }, 1_000)
    const s1 = sel(ask, "due-1", 2_000)
    const d1 = due(s1, [ask], 2_000)
    const right = row("outcome", "person", { r: 1, input_refs: [answer.id] }, 70_000)
    const s2 = sel(ask, "due-2", 80_000)
    const d2 = due(s2, [ask], 80_000)
    const rows = [ask, aSel, answer, s1, d1, right, s2, d2, tick(200_000)]
    expect([lapseOf(rows, d1), lapseOf(rows, d2)]).toEqual([undefined, undefined])
  })
  test("[GUARD] a later deadline whose at has not passed derives nothing", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s1 = sel(ask, "due-1", 0)
    const d1 = due(s1, [ask], 0)
    const s2 = sel(ask, "due-2", 90_000)
    const d2 = due(s2, [ask], 90_000) // at 150 s
    const rows = [ask, s1, d1, tick(70_000), mark([ask], 80_000), s2, d2, tick(140_000)]
    expect(lapseOf(rows, d2)).toBeUndefined()
    expect(closedBy(rows, ask)).toEqual([])
  })
})
