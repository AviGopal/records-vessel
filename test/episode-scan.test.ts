// SPDX-License-Identifier: MIT
// The episode read finds every open root's rows (store.ts rootRows, episodeOf, citedBy) in a fixed number of passes over
// the store, whatever the number of roots. Measured before: about seven whole-store passes per root (rootRows), so on a
// 74k-row store with 41 open roots the read spent 8-14 s finding rows.
//
// The answers are the ones records gave before this change: test/fixtures/episode-snapshot.json was written once by
// test/fixtures/episode-run.ts run on records at cf75ec85 (the parent), over the fixtures in episode-rows.ts, for every
// prefix of each fixture's rows: both read forms ({episode} and {episode, roots: "all"}), each answer's sha256 over its
// JSON and the ids it holds, and the last prefix's answers whole. The same runner, run on this tree, must give the same.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
const SNAPSHOT = (await Bun.file(join(import.meta.dir, "fixtures", "episode-snapshot.json")).json()) as Record<string, Ran>

type Ids = { shared: string[]; roots: Array<{ root: string; rows: string[]; awaits: boolean }> }
type Ran = { fixture: string; rows: number; prefixes: Record<string, { sha: { one: string; all: string }; one: string[]; all: Ids }>; last: { n: number; one: unknown; all: unknown } }

const runner = async (job: object): Promise<any> => {
  const dir = mkdtempSync(join(tmpdir(), "records-episode-scan-"))
  try {
    writeFileSync(join(dir, "job.json"), JSON.stringify(job))
    const p = Bun.spawn([process.execPath, "test/fixtures/episode-run.ts", join(dir, "job.json"), join(dir, "answer.json")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://127.0.0.1:1", RECORDS_ENDPOINT: "http://127.0.0.1:1",
        RECORDS_DATA_DIR: join(dir, "data"), IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "unused",
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited]
    if (code !== 0) throw new Error(`episode-run exited ${code}: ${err}`)
    return await Bun.file(join(dir, "answer.json")).json()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("the episode read's answer is the parent's", () => {
  for (const name of Object.keys(SNAPSHOT)) {
    test(`${name}: equal at every prefix of the rows, both forms, byte for byte`, async () => {
      const want = SNAPSHOT[name]!
      const got = (await runner({ fixture: name })) as Ran
      expect(got.rows).toBe(want.rows)
      expect(Object.keys(got.prefixes).length).toBe(want.rows)
      // ids first, so a difference says which root lost or gained which row; then the bytes
      for (const n of Object.keys(want.prefixes)) {
        expect([n, got.prefixes[n]?.one, got.prefixes[n]?.all]).toEqual([n, want.prefixes[n]!.one, want.prefixes[n]!.all])
        expect([n, got.prefixes[n]?.sha]).toEqual([n, want.prefixes[n]!.sha])
      }
      expect(got.last).toEqual(want.last)
    }, 120_000)
  }

  // What the fixtures hold, read from the parent's answers: so an equal answer is equal over the cases that matter.
  test("the fixtures cover the groupings: a selection in two roots, a gap's episode, a stall, a person's mark, idling", () => {
    const last = (name: string) => SNAPSHOT[name]!.prefixes[String(SNAPSHOT[name]!.rows)]!.all
    const mixed = last("mixed")
    expect(mixed.roots.length).toBeGreaterThanOrEqual(3)
    const inRoots = new Map<string, number>()
    for (const r of mixed.roots) for (const id of r.rows) inRoots.set(id, (inRoots.get(id) ?? 0) + 1)
    expect([...inRoots.values()].some((k) => k >= 2)).toBe(true)
    // a row the store holds twice is answered twice
    expect(mixed.roots.some((r) => r.rows.length !== new Set(r.rows).size)).toBe(true)
    const gaps = last("gaps")
    expect(gaps.roots.some((r) => r.rows.length > 3)).toBe(true)
    expect(gaps.roots.every((r) => r.awaits)).toBe(true)
    const idle = last("idle")
    expect(idle.roots.length).toBe(1)
    expect(idle.roots[0]!.awaits).toBe(false)
    // somewhere along the gaps fixture the reopened gap's episode restarts: a root's row count drops between prefixes
    const sizes = Object.values(SNAPSHOT.gaps!.prefixes).map((p) => p.all.roots.reduce((k, r) => k + r.rows.length, 0))
    expect(sizes.some((k, i) => i > 0 && k < sizes[i - 1]!)).toBe(true)
  })
})

describe("what the episode read costs", () => {
  test("[MUST-FAIL] the rows a read takes from the store per stored row do not grow with the number of open roots", async () => {
    const one = await runner({ wide: [60, 0] })
    const eleven = await runner({ wide: [60, 10] })
    const many = await runner({ wide: [60, 20] })
    expect([one.roots, eleven.roots, many.roots]).toEqual([1, 11, 21])
    const per = (x: { n: number; reads_all: number }) => x.reads_all / x.n
    // the same store but for the unworked asks: a read takes each stored row the same few times, not once more per root
    expect({ eleven: per(eleven) / per(one) <= 1.25, many: per(many) / per(one) <= 1.25, perRow: [per(one), per(eleven), per(many)] })
      .toEqual({ eleven: true, many: true, perRow: [per(one), per(eleven), per(many)] })
    // the single-root form reads the oldest root only, so it never grew with the others
    expect(many.reads_one / many.n / (one.reads_one / one.n)).toBeLessThanOrEqual(1.25)
  }, 120_000)
})
