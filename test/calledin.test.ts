// SPDX-License-Identifier: MIT
// Which earned templates the walk is shown in shared (store.ts earned, calledIn): the walk's ended calls are found once
// per read and each template's root keeps its own from them, not found by a whole-store pass per root. Measured before:
// 147 passes per read over an 81.6k-row store, about 1 s of every episodes read.
//
// The answers are the ones records gave before this change: test/fixtures/calledin-snapshot.json was written once by
// test/fixtures/calledin-run.ts run on records at b3d7c668 (the parent), over the stores in calledin-rows.ts and
// episode-rows.ts's mixed, gaps and idle, for every prefix of each store's rows: the shared ids in order and each read
// form's sha256 over its whole answer. The same runner, run on this tree, must give the same.
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const ROOT = join(import.meta.dir, "..")
type Ran = Record<string, { rows: number; prefixes: Record<string, { shared: string[]; sha: { all: string; one: string } }>; templates: string[] }>
const SNAPSHOT = (await Bun.file(join(import.meta.dir, "fixtures", "calledin-snapshot.json")).json()) as Ran

const runner = async (job: object): Promise<any> => {
  const dir = mkdtempSync(join(tmpdir(), "records-calledin-"))
  try {
    writeFileSync(join(dir, "job.json"), JSON.stringify(job))
    const p = Bun.spawn([process.execPath, "test/fixtures/calledin-run.ts", join(dir, "job.json"), join(dir, "answer.json")], {
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "",
        RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://127.0.0.1:1", RECORDS_ENDPOINT: "http://127.0.0.1:1",
        RECORDS_DATA_DIR: join(dir, "data"), IDENTITY_VESSEL_URL: "http://127.0.0.1:1", METABOB_API_KEY: "unused",
      },
      stdout: "pipe", stderr: "pipe",
    })
    const [, err, code] = [await new Response(p.stdout).text(), await new Response(p.stderr).text(), await p.exited]
    if (code !== 0) throw new Error(`calledin-run exited ${code}: ${err}`)
    return await Bun.file(join(dir, "answer.json")).json()
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe("the templates shared are the parent's", () => {
  test("at every prefix of every store: the shared ids in order, and both read forms' whole answers", async () => {
    const got = (await runner({ snapshot: true })) as Ran
    expect(Object.keys(got)).toEqual(Object.keys(SNAPSHOT))
    for (const [name, want] of Object.entries(SNAPSHOT)) {
      expect([name, got[name]!.rows]).toEqual([name, want.rows])
      for (const n of Object.keys(want.prefixes)) {
        expect([name, n, got[name]!.prefixes[n]?.shared]).toEqual([name, n, want.prefixes[n]!.shared])
        expect([name, n, got[name]!.prefixes[n]?.sha]).toEqual([name, n, want.prefixes[n]!.sha])
      }
      expect([name, got[name]!.templates]).toEqual([name, want.templates])
    }
  }, 120_000)

  // What the earned store holds, read from the parent's answer: so an equal answer is equal over the cases that matter.
  test("the earned store covers each conjunct: shared by an ended call, an ended run and calls in order; not by the rest", () => {
    const shown = SNAPSHOT.earned!.templates
    expect(shown).toEqual(["by-a-call", "by-a-run", "in-order", "diff-then-land"])
    // before its last row (the ended hop that completes diff-then-land) the template is not shared; after it, it is
    const n = SNAPSHOT.earned!.rows
    const sizes = [n - 1, n].map((k) => SNAPSHOT.earned!.prefixes[String(k)]!.shared.length)
    expect(sizes[1]! - sizes[0]!).toBe(1)
  })

  test("a read, then the walk's ended hop written, then a read: the second read shares the template the hop completes", async () => {
    const got = await runner({ twice: true })
    expect(got).toEqual({
      last: { shape: "hop", phase: "ended", kind: "call", writer: "walk-1" }, status: 200,
      before: ["by-a-call", "by-a-run", "in-order"], after: ["by-a-call", "by-a-run", "in-order", "diff-then-land"],
    })
  }, 120_000)
})

describe("what finding the earned templates costs", () => {
  test("[MUST-FAIL] the rows a read takes from the store per stored row do not grow with the number of earned templates", async () => {
    const one = await runner({ count: [60, 1] })
    const all = await runner({ count: [60, 60] })
    // every template reaches calledIn and is shared
    expect([one.shared_templates, all.shared_templates]).toEqual([1, 60])
    const per = (x: { n: number; reads: number }) => x.reads / x.n
    // the stores differ by 59 template rows: a read takes each stored row the same few times, not once more per template
    expect({ grows: per(all) / per(one) > 1.25, perRow: [per(one), per(all)] }).toEqual({ grows: false, perRow: [per(one), per(all)] })
  }, 120_000)
})
