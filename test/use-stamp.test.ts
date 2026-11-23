// SPDX-License-Identifier: MIT
// Whether what a selection made was used is records' to say: a plain read of a selection carries use {r, key}, the
// fold's own use grade of that selection (fold.ts useGrades: each unused one keyed by the selection itself, a used one
// once per request and move), and nothing when the fold has not judged it, whatever its writer put there. A detector that
// classes unused output reads this stamp, never a copy of the rule. Over records' own store module, in this process, on
// a store of its own.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

Object.assign(process.env, {
  RECORDS_VESSEL_ID: "records-usestamp-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://127.0.0.1:1", RECORDS_ENDPOINT: "http://127.0.0.1:1",
  RECORDS_DATA_DIR: join(mkdtempSync(join(tmpdir(), "records-usestamp-")), "data"), IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "unused",
})
const store = await import("../src/store")
const { DATA_DIR } = await import("../src/config")
mkdirSync(DATA_DIR, { recursive: true })
process.on("exit", () => rmSync(DATA_DIR, { recursive: true, force: true }))
type R = Record<string, any>

const put = (body: R, writer: string, role: string): R => {
  const out = store.write(body, writer, role)
  expect(out.status).toBe(200)
  return out.body as R
}
const EDIT = "call/fs_edit", EDIT_CELL = "call/fs_edit|request,asker:person,age:0"
put({ shape: "credits", target: "selection", w_person: 1, w_lapse: 1, w_close: 1, gamma: 0.5, depth: 4, w_check: 0.5, promise_window: 3 }, "owner", "owner")
const ask = (what: string) => put({ shape: "world_changed", what }, "kid-person", "person")
const sel = (root: R, a: string, cell: string, extra: R = {}) =>
  put({ shape: "selection", arm: "treated", a, cell, root: root.id, ...extra }, "walk-test", "walk")
const filler = (root: R) => sel(root, "wait-for", "wait-for|asker:person,age:0")
const selections = (ids: string[], stored = false): R[] => store.serveRead({ ids, ...(stored ? { stored: true } : {}) } as never) as R[]
const useOf = (ids: string[], stored = false) => selections(ids, stored).map((r) => r.use)

// Root A: an edit nobody takes, the window passed. Root B: an edit of the same move, its window not yet passed.
const A = ask("use stamp A"), B = ask("use stamp B")
const editA = sel(A, EDIT, EDIT_CELL)
const editB = sel(B, EDIT, EDIT_CELL)
const fillA = filler(A); filler(A); filler(A)
// Root D: an edit whose answer the commit (another move) took within the window.
const D = ask("use stamp D")
const editD = sel(D, EDIT, EDIT_CELL)
const result = put({ shape: "fileEditResult", selection_ref: editD.id }, "walk-test", "walk")
sel(D, "call/git_commit", "call/git_commit|fileEditResult,asker:person,age:0", { from: result.id })
// Root E: two edits nobody took, then an edit of the same move whose answer the commit took: each is its own judgment.
const E = ask("use stamp E")
const idleE = sel(E, EDIT, EDIT_CELL)
const idleE2 = sel(E, EDIT, EDIT_CELL)
const usedE = sel(E, EDIT, EDIT_CELL)
const resultE = put({ shape: "fileEditResult", selection_ref: usedE.id }, "walk-test", "walk")
sel(E, "call/git_commit", "call/git_commit|fileEditResult,asker:person,age:0", { from: resultE.id })
filler(E); filler(E); filler(E)
// Root M: six edits of one move nobody took, then the window passes on each.
const M = ask("use stamp M")
const idleM = [0, 1, 2, 3, 4, 5].map(() => sel(M, EDIT, EDIT_CELL))
filler(M); filler(M); filler(M)
// Root X: an edit nobody took, the window passed; root Z: an edit whose window has not passed; then, newer, root Y: an
// edit of the same move whose answer the commit took.
const X = ask("use stamp X"), Z = ask("use stamp Z"), Y = ask("use stamp Y")
const idleX = sel(X, EDIT, EDIT_CELL); filler(X); filler(X); filler(X)
const openZ = sel(Z, EDIT, EDIT_CELL)
const usedY = sel(Y, EDIT, EDIT_CELL)
sel(Y, "call/git_commit", "call/git_commit|fileEditResult,asker:person,age:0", { from: put({ shape: "fileEditResult", selection_ref: usedY.id }, "walk-test", "walk").id })
// Root W: the edit's answer taken by the commit, then, newer, the commit's answer taken by the push: two moves used.
const Wr = ask("use stamp W")
const editW = sel(Wr, EDIT, EDIT_CELL)
const commitW = sel(Wr, "call/git_commit", "call/git_commit|fileEditResult,asker:person,age:0", { from: put({ shape: "fileEditResult", selection_ref: editW.id }, "walk-test", "walk").id })
sel(Wr, "call/git_push", "call/git_push|gitCommit,asker:person,age:0", { from: put({ shape: "gitCommit", selection_ref: commitW.id }, "walk-test", "walk").id })
// A selection whose writer put a use of its own, on a root no window has passed on.
const C = ask("use stamp C")
const forged = sel(C, EDIT, EDIT_CELL, { use: { r: 0, key: "forged" } })
// A row of another shape whose writer named a field use: records says nothing of it, so it is kept as written.
const other = put({ shape: "world_changed", what: "use stamp other", use: "the writer's own" }, "kid-person", "person")

describe("a selection read says whether what it made was used", () => {
  test("[MUST-FAIL] an edit nobody took within the window reads use r 0, keyed by the selection itself", () => {
    expect(useOf([editA.id])).toEqual([{ r: 0, key: `unused|${editA.id}` }])
  })
  test("[MUST-FAIL] an edit whose answer the commit took within the window reads use r 1", () => {
    expect(useOf([editD.id])).toEqual([{ r: 1, key: `use|${D.id}|${EDIT}` }])
  })
  test("[MUST-FAIL] a later use of the same move on the same request erases no earlier unused stamp: each reads its own", () => {
    expect(useOf([idleE.id, idleE2.id, usedE.id])).toEqual([
      { r: 0, key: `unused|${idleE.id}` }, { r: 0, key: `unused|${idleE2.id}` }, { r: 1, key: `use|${E.id}|${EDIT}` }])
  })
  test("[MUST-FAIL] many unused selections of one request and move are each stamped r 0, by their own id", () => {
    expect(useOf(idleM.map((s) => s.id))).toEqual(idleM.map((s) => ({ r: 0, key: `unused|${s.id}` })))
  })
  test("[MUST-FAIL] another request's newer use of the same move neither stamps this request's selections nor erases a stamp", () => {
    expect(useOf([idleX.id, openZ.id, usedY.id])).toEqual([{ r: 0, key: `unused|${idleX.id}` }, undefined, { r: 1, key: `use|${Y.id}|${EDIT}` }])
  })
  test("[GUARD] two requests' uses of one move are stamped each on its own request", () => {
    expect(useOf([editD.id, usedY.id])).toEqual([{ r: 1, key: `use|${D.id}|${EDIT}` }, { r: 1, key: `use|${Y.id}|${EDIT}` }])
  })
  test("[GUARD] two moves used on one request are stamped each by its own move, the newer one included", () => {
    expect(useOf([editW.id, commitW.id])).toEqual([{ r: 1, key: `use|${Wr.id}|${EDIT}` }, { r: 1, key: `use|${Wr.id}|call/git_commit` }])
  })
  test("[GUARD] another move's selection on the judged root reads no use: the stamp is the judged move's own", () => {
    expect(useOf([fillA.id])).toEqual([undefined])
  })
  test("[GUARD] the same move on another root, not yet judged, reads no use: the stamp is the judged selection's own", () => {
    expect(useOf([editB.id])).toEqual([undefined])
  })
  test("[MUST-FAIL] a use the writer put on its row is not read: only the fold's grade is", () => {
    expect(useOf([forged.id])).toEqual([undefined])
  })
  test("[MUST-FAIL] read beside a stamped selection, a row of another shape keeps a use its writer put there: only a selection is stamped", () => {
    expect(useOf([editA.id, other.id])).toEqual([{ r: 0, key: `unused|${editA.id}` }, "the writer's own"])
  })
  test("[GUARD] a read of the rows as stored carries no stamp, and keeps what was written", () => {
    expect(useOf([editA.id, forged.id], true)).toEqual([undefined, { r: 0, key: "forged" }])
  })
  test("[MUST-FAIL] a window that passes after an earlier read is read: the stamp follows the store", () => {
    filler(B); filler(B); filler(B)
    expect(useOf([editB.id])).toEqual([{ r: 0, key: `unused|${editB.id}` }])
  })
})
