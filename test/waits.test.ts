// SPDX-License-Identifier: MIT
// A land refused because only a person's verdict lands it is the gate working, not the request's fault: read from the
// failure row's waits_for field (the walk lifts it from git_land's answer), never from the body.
import { describe, expect, test } from "bun:test"
import { blames } from "../src/fold"

describe("whom a refused land blames", () => {
  const LONG = JSON.stringify({ error: "the change touches what judges changes (x): only a person's verdict lands it", needs_person: Array.from({ length: 60 }, (_, i) => `repos/x/protected/file-${i}.ts`), waits_for: "person" }).slice(0, 1000)
  test("[MUST-FAIL] a failure row carrying waits_for person blames the callee: no r 0 on the asker (46700's shape: a 200, body cut at 1000)", () => {
    expect(blames({ status: 200, body: LONG, waits_for: "person" })).toBe("callee")
    expect(blames({ status: 422, body: "{}", waits_for: "person" })).toBe("callee")
  })
  test("[MUST-FAIL] without the field, a body that mentions it (cut, or wrapped in content) blames as before", () => {
    expect(blames({ status: 200, body: LONG })).toBe("request")
    expect(blames({ status: 200, body: JSON.stringify({ content: { error: "x", waits_for: "person" } }) })).toBe("request")
  })
  test("[MUST-FAIL] a grader's r 0 refusal still blames the request; a 5xx the callee, as before", () => {
    expect(blames({ status: 422, body: JSON.stringify({ error: "a grader judged this tree r 0" }) })).toBe("request")
    expect(blames({ status: 500, body: "{}" })).toBe("callee")
  })
})
