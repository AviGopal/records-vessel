// SPDX-License-Identifier: MIT
// An on-behalf-of token's kept answer is kept under its token, the node it is bound to and the shape served
// (src/obo-key.ts): a yes for one node, shape or token answers no other.
import { describe, expect, test } from "bun:test"
import { oboKeyOf } from "../src/obo-key"

describe("what a token's answer is kept under", () => {
  test("a yes for one node, shape or token is never served for another (a guard)", () => {
    const base = oboKeyOf("d1", "12D3KooWNodeOne", "record_read")
    expect(oboKeyOf("d1", "12D3KooWNodeTwo", "record_read")).not.toBe(base)   // the transport's peer id changed
    expect(oboKeyOf("d1", "12D3KooWNodeOne", "record_summary")).not.toBe(base)
    expect(oboKeyOf("d2", "12D3KooWNodeOne", "record_read")).not.toBe(base)
    expect(oboKeyOf("d1", "12D3KooWNodeOne", "record_read")).toBe(base)
  })
})
