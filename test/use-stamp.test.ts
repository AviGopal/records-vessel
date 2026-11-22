// SPDX-License-Identifier: MIT
// Whether what a selection made was used is records' to say: a plain read of a selection carries use {r, key}, the
// fold's own use grade of that selection (fold.ts useGrades), and nothing when the fold has not judged it, whatever its
// writer put there. A detector that classes unused output reads this stamp, never a copy of the rule. Over records' own
// store module, in this process, on a store of its own.
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
// A selection whose writer put a use of its own, on a root no window has passed on.
const C = ask("use stamp C")
const forged = sel(C, EDIT, EDIT_CELL, { use: { r: 0, key: "forged" } })
// A row of another shape whose writer named a field use: records says nothing of it, so it is kept as written.
const other = put({ shape: "world_changed", what: "use stamp other", use: "the writer's own" }, "kid-person", "person")

describe("a selection read says whether what it made was used", () => {
  test("[MUST-FAIL] an edit nobody took within the window reads use r 0, keyed by its root and move", () => {
    expect(useOf([editA.id])).toEqual([{ r: 0, key: `use|${A.id}|${EDIT}` }])
  })
  test("[MUST-FAIL] an edit whose answer the commit took within the window reads use r 1", () => {
    expect(useOf([editD.id])).toEqual([{ r: 1, key: `use|${D.id}|${EDIT}` }])
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
    expect(useOf([editA.id, other.id])).toEqual([{ r: 0, key: `use|${A.id}|${EDIT}` }, "the writer's own"])
  })
  test("[GUARD] a read of the rows as stored carries no stamp, and keeps what was written", () => {
    expect(useOf([editA.id, forged.id], true)).toEqual([undefined, { r: 0, key: "forged" }])
  })
  test("[MUST-FAIL] a window that passes after an earlier read is read: the stamp follows the store", () => {
    filler(B); filler(B); filler(B)
    expect(useOf([editB.id])).toEqual([{ r: 0, key: `use|${B.id}|${EDIT}` }])
  })
})
