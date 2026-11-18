// SPDX-License-Identifier: MIT
// An ask_state read is derived once per store state: a repeat read at one seq is served from the kept answer (no
// derivation, said by the refolds a read drains), any new row (a selection, an answer, a person's Right) makes the next
// read derive again, and what a caller does to the rows it was given never reaches the next read. Over records' own
// store module, in this process, on a store of its own.
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

// config.ts reads these once, at import: a store in a directory of its own, nothing served or dialled. The store module
// is one per test process, so another file may have loaded it first, on its own directory, and removed that directory
// when it ended: the directory the store uses is made again here, and removed when the process exits.
Object.assign(process.env, {
  RECORDS_VESSEL_ID: "records-memo-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://127.0.0.1:1", RECORDS_ENDPOINT: "http://127.0.0.1:1",
  RECORDS_DATA_DIR: join(mkdtempSync(join(tmpdir(), "records-askmemo-")), "data"), IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "unused",
})
const store = await import("../src/store")
const { drainRefolds } = await import("../src/fold")
const { DATA_DIR } = await import("../src/config")
mkdirSync(DATA_DIR, { recursive: true })
process.on("exit", () => rmSync(DATA_DIR, { recursive: true, force: true }))
type R = Record<string, any>

const put = (body: R, writer: string, role: string): R => {
  const out = store.write(body, writer, role)
  expect(out.status).toBe(200)
  return out.body as R
}
const walk = (body: R) => put(body, "walk-test", "walk")
// how many times the ask states were derived since the last count
const derived = (): number => drainRefolds().filter((f) => f.fold === "ask_state").length
const read = (): R[] => store.openAskStates() as R[]

put({ shape: "shape_schema", target: "request", inputs: [{ shape: "world_changed", ask: true }] }, "owner", "owner")
put({ shape: "shape_schema", target: "outcome", context: ["answer", "due"], evidence: [{ shape: "answer", deferred_by: "next_act" }] }, "owner", "owner")

describe("an ask_state read is derived once per store state", () => {
  test("[MUST-FAIL] two reads at one seq answer equal rows, and the second derives nothing", () => {
    const a = put({ shape: "world_changed", what: "memo one" }, "kid-person", "person")
    derived()
    const first = read()
    expect(derived()).toBe(1)
    const second = read()
    expect(derived()).toBe(0)
    expect(second).toEqual(first)
    expect(first.find((r) => r.root === a.id)?.waiting_pick).toBe(true)
  })

  test("[MUST-FAIL] a new selection, answer or person's Right makes the next read derive again, and it shows the row", () => {
    const a = put({ shape: "world_changed", what: "memo two" }, "kid-person", "person")
    const mine = (): R | undefined => read().find((r) => r.root === a.id)
    derived()
    expect(mine()?.waiting_pick).toBe(true)
    expect(derived()).toBe(1)
    const sel = walk({ shape: "selection", arm: "treated", cell: "c-memo", root: a.id, a: "produce/answer/ch1" })
    expect(mine()?.waiting_pick).toBeUndefined()
    expect(derived()).toBe(1)
    const ans = put({ shape: "answer", text: "memo answer", selection_ref: sel.id, input_refs: [a.id] }, "described-test", "described")
    expect(mine()?.answered).toBe(ans.id)
    expect(derived()).toBe(1)
    put({ shape: "outcome", r: 1, input_refs: [ans.id] }, "kid-person", "person")
    expect(mine()).toBeUndefined()
    expect(derived()).toBe(1)
  })

  test("[MUST-FAIL] a caller changing the rows it was given changes nothing the next read answers", () => {
    const a = put({ shape: "world_changed", what: "memo three" }, "kid-person", "person")
    derived()
    const before = read()
    expect(derived()).toBe(1)
    const want = structuredClone(before)
    const mine = before.find((r) => r.root === a.id)!
    mine.waiting_pick = false
    mine.root = "changed"
    mine.input_refs.push("changed")
    before.pop()
    // the serve path's where and limit run over the kept rows too
    store.serveRead({ shape: "ask_state", where: { asker: "kid-person" }, limit: 1 })
    const after = read()
    expect(derived()).toBe(0)
    expect(after).toEqual(want)
  })
})
