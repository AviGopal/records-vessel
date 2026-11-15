// SPDX-License-Identifier: MIT
// A fresh install starts records on an empty volume: its data directory does not exist yet. records must make it, not
// exit ENOENT on every start (the boot crash-looped: install acceptance never reached "served"). Run in a child process,
// since the store opens its file when imported.
import { expect, test } from "bun:test"
import { existsSync, mkdtempSync, statSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

test("[MUST-FAIL] records starts on a volume whose data directory does not exist yet, and makes it", () => {
  const base = mkdtempSync(join(tmpdir(), "rec-dd-"))
  const dir = join(base, "substrate", "records-vessel")
  const p = Bun.spawnSync(["bun", "-e", `await import(${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))})`], {
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root",
      RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
      RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
    },
  })
  expect([p.exitCode, p.stderr.toString().slice(0, 300)]).toEqual([0, ""])
  expect(existsSync(join(dir, "rows"))).toBe(true)
  expect(statSync(dir).mode & 0o777).toBe(0o700)
})
