// SPDX-License-Identifier: MIT
// What ends the walk's wait: it asks for no shape and gives no deadline when nothing it can bound by is ahead, so the wait
// ends only on a row from outside the walk: a person's, the owner's or an operator's (not the owner's configuration or templates), or
// a detector's gap row (one opening or closing changes what the walk has to work). Its own rows, a producer's and a
// detector's other rows and a gap row of any other role end nothing, or the walk would wake on its own writes.
import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const dir = mkdtempSync(join(tmpdir(), "records-wait-ends-"))
Object.assign(process.env, {
  RECORDS_VESSEL_ID: "records-test", RECORDS_PORT: "1", DISCOVERY_URL: "http://discovery.test",
  RECORDS_ENDPOINT: "http://records.test", RECORDS_DATA_DIR: dir, IDENTITY_VESSEL_URL: "http://identity.test", METABOB_API_KEY: "k",
})
const store = await import("../src/store")
afterAll(() => rmSync(dir, { recursive: true, force: true }))

// the walk's wait as it sends one with nothing to bound it: no shapes, no deadline
const waitFrom = () => {
  let got: { shape?: unknown; role?: unknown } | null | undefined
  const p = store.wait([], store.lastSeq()).then((r) => { got = r as typeof got })
  return { p, ended: async () => { await Bun.sleep(0); return got } }
}
const put = (shape: string, role: string, fields: Record<string, unknown> = {}): string => {
  const out = store.write({ shape, ...fields }, `${role}-test`, role)
  expect(out.status).toBe(200)
  return (out.body as { id: string }).id
}
// a selection a producer's row can cite (records takes a described row only for a selection it holds)
const made = put("selection", "walk")

describe("the walk's unbounded wait", () => {
  for (const [shape, role] of [["world_changed", "person"], ["outcome", "person"], ["request", "owner"], ["note", "operator"], ["gap", "detector"]] as const) {
    test(`[GUARD] a ${role}'s ${shape} row ends it`, async () => {
      const w = waitFrom()
      put(shape, role)
      expect(await w.ended()).toMatchObject({ shape, role })
    })
  }

  test("[GUARD] the walk's own rows, a producer's, the owner's configuration and templates, a detector's non-gap row and a gap row not a detector's end nothing; the next outside row does", async () => {
    const w = waitFrom()
    put("answer", "walk")
    put("hop", "walk", { phase: "started" })
    put("answer", "described", { selection_ref: made })
    put("credits", "owner", { target: "selection" })
    put("shape_schema", "owner", { target: "plan", inputs: [] })
    put("activity_template", "owner", { calls: [] })
    put("activity_template", "operator", { calls: [] })
    put("infra_window", "owner", { from: 0, to: 1 })
    put("failure", "detector")
    put("gap", "walk")
    expect(await w.ended()).toBeUndefined()
    put("world_changed", "person")
    expect(await w.ended()).toMatchObject({ shape: "world_changed", role: "person" })
  })
})
