// SPDX-License-Identifier: MIT
// records starts on its rows file whatever its size: a store past 2^31 - 1 bytes could not be read as one string, and
// every start exited ERR_STRING_TOO_LONG. Run in a child process, since the store opens its file when imported.
import { expect, test } from "bun:test"
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const row = (i: number, more: Record<string, unknown> = {}) =>
  ({ shape: "hop", id: `r${i}`, seq: i, t: "2000-01-01T00:00:00.000Z", writer: "w", role: "r", input_refs: [], ...more })

const start = (dir: string, mem = false) => Bun.spawnSync(["bun", "-e",
  `const s = await import(${JSON.stringify(join(import.meta.dir, "..", "src", "store.ts"))}); ` +
  `console.log(JSON.stringify({ n: s.rows.length, last: s.rows.at(-1)?.id, seq: s.rows.at(-1)?.seq${mem ? ", rss: process.memoryUsage().rss" : ""} }))`], {
  env: {
    PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/root",
    RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
    RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
  },
})
const storeDir = () => {
  const dir = join(mkdtempSync(join(tmpdir(), "rec-rows-")), "records-vessel")
  mkdirSync(dir, { mode: 0o700 })
  return dir
}

test("the store starts on a file of many chunks with every row, in order, as written", () => {
  const dir = storeDir()
  try {
    const n = 20_000
    writeFileSync(join(dir, "rows"), Array.from({ length: n }, (_, i) => JSON.stringify(row(i + 1, { note: "é".repeat(i % 7) })) + "\n").join(""))
    const p = start(dir)
    expect([p.exitCode, p.stderr.toString().slice(0, 300)]).toEqual([0, ""])
    expect(JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!)).toEqual({ n, last: `r${n}`, seq: n })
  } finally { rmSync(join(dir, ".."), { recursive: true, force: true }) }
})

// Past the bound one string can hold: about 2.2 GB on disk and as much again in memory, so it runs only when asked
// (RECORDS_STRING_BOUND_LEG=1), on a machine with room for both. Read whole, the store exits ERR_STRING_TOO_LONG here.
test.if(process.env.RECORDS_STRING_BOUND_LEG === "1")("[MUST-FAIL] the store starts on a file past 2^31 - 1 bytes, with its last row", () => {
  const dir = storeDir()
  try {
    const pad = "p".repeat(100 * 1024 * 1024)
    const fd = openSync(join(dir, "rows"), "w")
    let bytes = 0
    let n = 0
    try {
      while (bytes <= 2 ** 31 - 1) {
        const line = JSON.stringify(row(++n, { pad })) + "\n"
        writeSync(fd, line)
        bytes += Buffer.byteLength(line)
      }
    } finally { closeSync(fd) }
    const p = start(dir, true)
    expect([p.exitCode, p.stderr.toString().slice(0, 300)]).toEqual([0, ""])
    const got = JSON.parse(p.stdout.toString().trim().split("\n").at(-1)!)
    console.log(`[rows-file] ${bytes} bytes, ${n} rows, rss ${got.rss}`)
    expect({ n: got.n, last: got.last, seq: got.seq }).toEqual({ n, last: `r${n}`, seq: n })
  } finally { rmSync(join(dir, ".."), { recursive: true, force: true }) }
}, 600_000)
