// SPDX-License-Identifier: MIT
// What a handler's throw means: a refusal of what was asked (Refused) is the caller's, 400; any other throw is records
// failing, 500, and said in the journal by shape, error name and throwing frame, never a message or the pointer's values.
import { describe, expect, spyOn, test } from "bun:test"
import { Refused, dispatch } from "../src/dispatch"

describe("a handler that throws", () => {
  test("[MUST-FAIL] a fault answers 500 and is journaled by name and frame, without its message or the pointer's values; a refusal answers 400; an answer passes through", async () => {
    const handlers = new Map<string, (p: { type: string; secret?: string }, who: unknown) => Promise<Response>>([
      ["faulty", async () => { throw new TypeError("a person wrote PERSON-TEXT-NOT-LOGGED") }],
      ["refusing", async () => { throw new Refused("record_summary needs shape and summarize") }],
      ["fine", async () => Response.json({ ok: true })],
    ])
    const err = spyOn(console, "error").mockImplementation(() => {})
    try {
      const fault = await dispatch({ type: "faulty", secret: "VALUE-NOT-LOGGED" }, {}, handlers)
      const body = JSON.stringify(await fault.json())
      expect([fault.status, body]).toEqual([500, JSON.stringify({ failure: { status: 500, body: "faulty failed: TypeError" } })])
      // the name and the throwing frame (path:line), never the message or the pointer's values
      const said = err.mock.calls.map((a) => a.map(String).join(" "))
      expect([said.length, /^\[records\] faulty failed: TypeError at \S+dispatch\.test\.ts:\d+$/.test(said[0] ?? ""), said.some((l) => l.includes("NOT-LOGGED"))]).toEqual([1, true, false])
      const refused = await dispatch({ type: "refusing" }, {}, handlers)
      expect([refused.status, ((await refused.json()) as any).failure.body]).toEqual([400, "Error: record_summary needs shape and summarize"])
      expect((await dispatch({ type: "fine" }, {}, handlers)).status).toBe(200)
      expect((await dispatch({ type: "unknown" }, {}, handlers)).status).toBe(400)
      expect(err.mock.calls.length).toBe(1) // only the fault is journaled
    } finally {
      err.mockRestore()
    }
  })
})
