// SPDX-License-Identifier: MIT
// A wait with a deadline answers null by then and leaves nothing registered: one left behind per timed-out wait would
// rescan every row on every later write, forever.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "records-wait-"))
Object.assign(process.env, {
  RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
  RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
})
const store = await import("../src/store")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

describe("a wait with a deadline", () => {
  test("[MUST-FAIL] a timed-out wait answers null and leaves no waker behind", async () => {
    const before = store.waiting()
    expect(await store.wait(["never_written"], 1e12, Date.now() + 50)).toBeNull()
    expect(store.waiting()).toBe(before)
    store.write({ shape: "unrelated" }, "walk-test", "walk")
    expect(store.waiting()).toBe(before)
  })

  test("a wait answered by a row leaves no waker behind", async () => {
    const before = store.waiting()
    const pending = store.wait(["probe"], store.lastSeq(), Date.now() + 5_000)
    expect(store.waiting()).toBe(before + 1)
    store.write({ shape: "probe" }, "walk-test", "walk")
    expect(((await pending) as { shape: string }).shape).toBe("probe")
    expect(store.waiting()).toBe(before)
  })
})
