// SPDX-License-Identifier: MIT
// A fresh install starts records on an empty volume: its own data directory does not exist yet. records makes that one
// directory (0700), not its parents: a missing parent means the volume is not what records expects, and it exits naming
// it (research). Run in a child process, since the store opens its file when imported.
import { expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const start = (dir: string) => Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))})`], {
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root",
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
    RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
  },
})

test("[MUST-FAIL] parent present, own directory missing: made at 0700, the store starts", () => {
  const parent = mkdtempSync(join(tmpdir(), "rec-dd-"))
  chmodSync(parent, 0o755)
  const dir = join(parent, "records-vessel")
  const p = start(dir)
  expect([p.exitCode, p.stderr.toString().slice(0, 300)]).toEqual([0, ""])
  expect(existsSync(join(dir, "rows"))).toBe(true)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
  expect(statSync(parent).mode & 0o777).toBe(0o755) // the parent is not touched
})

test("[MUST-FAIL] parent missing: exits non-zero naming it, and makes nothing", () => {
  const base = mkdtempSync(join(tmpdir(), "rec-dd-"))
  const parent = join(base, "substrate")
  const p = start(join(parent, "records-vessel"))
  expect(p.exitCode).not.toBe(0)
  expect(p.stderr.toString()).toContain(`the data directory's parent ${parent} does not exist`)
  expect(existsSync(parent)).toBe(false)
})

test("an existing directory is left as it is (its mode too)", () => {
  const parent = mkdtempSync(join(tmpdir(), "rec-dd-"))
  const dir = join(parent, "records-vessel")
  mkdirSync(dir, { mode: 0o755 })
  chmodSync(dir, 0o755)
  const p = start(dir)
  expect(p.exitCode).toBe(0)
  expect(statSync(dir).mode & 0o777).toBe(0o755)
})
