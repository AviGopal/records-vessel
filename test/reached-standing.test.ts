// SPDX-License-Identifier: MIT
// The deadline rule skips an ask a written grade already closed, and only a grade that stands closes (standing(): of a
// writer's grades of one row, the latest). A person's Right they later marked down closes nothing, so the ask's next
// deadline lapses it ("Later deadlines close it"); a Right that stands, or one given again, still exempts it. The rule
// and closed() read one set: an ask is exempt from its deadlines exactly when closed() says it is done.
import { describe, expect, test } from "bun:test"
import * as F from "../src/fold"
import type { Row } from "../src/store"

let seq = 0
// far in the wall clock's future, so only the store's own clock (its newest row) can say a deadline has passed
const T0 = Date.parse("2099-01-01T10:00:00Z")
const row = (shape: string, role: string, fields: Record<string, unknown>, at = 0): Row =>
  ({ shape, role, writer: role, id: `${shape}-${++seq}`, seq, t: new Date(T0 + at).toISOString(), input_refs: [], ...fields }) as Row

const tick = (at: number) => row("hop", "walk", { phase: "ended" }, at)
const sel = (root: Row, cell: string, at: number) => row("selection", "walk", { arm: "treated", cell, root: root.id }, at)
const due = (s: Row, ask: Row, written: number, within = 60_000) =>
  row("due", "described", { within_ms: within, at: T0 + written + within, selection_ref: s.id, input_refs: [ask.id] }, written)
const grade = (answer: Row, r: unknown, at: number, writer = "person") =>
  ({ ...row("outcome", "person", { r, input_refs: [answer.id] }, at), writer }) as Row
const lapseOf = (rows: Row[], d: Row) => F.grades(rows, seq, seq).find((g) => g.by === F.LAPSE && g.judged === d.id)
// what closes an ask, as store.ts closed() reads it: a standing person r 1 on an answer citing it (done), or a standing
// r 0 on a deadline citing it (failed)
const closedBy = (rows: Row[], ask: Row) => F.standing(rows, seq, seq)
  .filter((g) => (g.r === 1 && g.by === "person") || (g.r === 0 && g.deadline))
  .filter((g) => [rows.find((r) => r.id === g.judged)?.input_refs].flat().includes(ask.id))
  .map((g) => `${g.r}:${g.judged}`)

// an ask, the walk's answer to it, the person's grades of that answer (each at its own time), then a deadline written
// after them all and passed
const world = (marks: Array<[unknown, string?]>) => {
  seq = 0
  const ask = row("world_changed", "person", { what: "q" })
  const s = sel(ask, "answer-cell", 0)
  const answer = row("answer", "described", { selection_ref: s.id, input_refs: [ask.id] }, 1_000)
  const gs = marks.map(([r, writer], i) => grade(answer, r, 2_000 + i * 1_000, writer))
  const ds = sel(ask, "due-cell", 10_000)
  const d = due(ds, ask, 10_000)
  const rows = [ask, s, answer, ...gs, ds, d, tick(100_000)]
  return { ask, answer, d, rows }
}

describe("the deadline rule exempts only an ask a standing grade closed", () => {
  test("[MUST-FAIL] a person's Right then their Wrong on the same answer: the next deadline lapses and closes the ask failed", () => {
    const w = world([[1], [0]])
    expect(lapseOf(w.rows, w.d)).toMatchObject({ ok: true, r: 0, deadline: true })
    expect(closedBy(w.rows, w.ask)).toEqual([`0:${w.d.id}`])
    expect(F.fold(w.rows, ["due-cell"], seq, seq)[0]).toMatchObject({ cell: "due-cell", beta: 2 })
  })

  test("[GUARD] a person's Right that stands: the deadline derives nothing and the ask stays done", () => {
    const w = world([[1]])
    expect(lapseOf(w.rows, w.d)).toBeUndefined()
    expect(closedBy(w.rows, w.ask)).toEqual([`1:${w.answer.id}`])
  })

  test("[GUARD] Right, Wrong, then Right again: the last stands and exempts the ask again", () => {
    const w = world([[1], [0], [1]])
    expect(lapseOf(w.rows, w.d)).toBeUndefined()
    expect(closedBy(w.rows, w.ask)).toEqual([`1:${w.answer.id}`])
  })

  test("[GUARD] a later grade that does not count (r out of range) replaces nothing: the Right still stands", () => {
    const w = world([[1], [2]])
    expect(lapseOf(w.rows, w.d)).toBeUndefined()
    expect(closedBy(w.rows, w.ask)).toEqual([`1:${w.answer.id}`])
  })

  test("[GUARD] two people: one's Right is not replaced by the other's Wrong, so the ask stays done and exempt", () => {
    const w = world([[1, "person-a"], [0, "person-b"]])
    expect(lapseOf(w.rows, w.d)).toBeUndefined()
    expect(closedBy(w.rows, w.ask)).toEqual([`1:${w.answer.id}`])
  })

  test("[GUARD] the walk's grader's counted Right on the answer is not a person's: the deadline still lapses", () => {
    seq = 0
    const ask = row("world_changed", "person", { what: "q" })
    const s = sel(ask, "answer-cell", 0)
    const answer = row("answer", "described", { selection_ref: s.id, input_refs: [ask.id] }, 1_000)
    const gs = sel(ask, "grade-cell", 2_000)
    const model = row("outcome", "described", { r: 1, selection_ref: gs.id, input_refs: [ask.id, answer.id] }, 3_000)
    const ds = sel(ask, "due-cell", 10_000)
    const d = due(ds, ask, 10_000)
    const rows = [ask, s, answer, gs, model, ds, d, tick(100_000)]
    expect(F.grades(rows, seq, seq).find((g) => g.id === model.id)).toMatchObject({ ok: true, r: 1 })
    expect(lapseOf(rows, d)).toMatchObject({ ok: true, r: 0, deadline: true })
  })

  test("[MUST-FAIL] the rule and closed() agree: an ask is exempt from its deadline exactly when it stands done", () => {
    const cases: Array<Array<[unknown, string?]>> = [[[1]], [[1], [0]], [[1], [0], [1]], [[0]], [[0], [1]], [[1], [2]], [[1, "person-a"], [0, "person-b"]]]
    for (const marks of cases) {
      const w = world(marks)
      const done = closedBy(w.rows, w.ask).includes(`1:${w.answer.id}`)
      expect([JSON.stringify(marks), lapseOf(w.rows, w.d) === undefined]).toEqual([JSON.stringify(marks), done])
    }
  })
})
