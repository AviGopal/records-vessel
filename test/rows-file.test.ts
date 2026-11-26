// SPDX-License-Identifier: MIT
// The rows file is read by lines, in the chunks the file gives, never as one string: a store past 2^31 - 1 bytes could
// not be read whole, and records could not start at all. Each row is what the whole-file read made of it.
import { expect, test } from "bun:test"
import { rowsIn } from "../src/rows-file"

// the read records made before: the whole file as one string, split on newlines
const whole = (text: string) => text.split("\n").filter((l) => l.length > 0).map((l) => JSON.parse(l))
async function* chunksOf(bytes: Uint8Array, size: number) {
  for (let i = 0; i < bytes.length; i += size) yield bytes.subarray(i, i + size)
}
const row = (i: number, more: Record<string, unknown> = {}) =>
  ({ shape: "hop", id: `r${i}`, seq: i, t: "2000-01-01T00:00:00.000Z", writer: "w", role: "r", input_refs: [], ...more })

test("[MUST-FAIL] a line or a character split across chunks is read whole, a last line with no newline is a row, blank lines are none", async () => {
  const text = [row(1, { note: "é 🙂   \\n" }), row(2, { note: "x".repeat(300) }), row(3, { note: "日本" })].map((r) => JSON.stringify(r)).join("\n") +
    "\n\n" + JSON.stringify(row(4, { note: "no newline after me ✓" }))
  const bytes = new TextEncoder().encode(text)
  for (const size of [1, 2, 3, 5, 7, 64, bytes.length]) expect(await rowsIn(chunksOf(bytes, size))).toEqual(whole(text))
  expect(await rowsIn(chunksOf(new Uint8Array(), 4))).toEqual([])
  // a line that is not a row still stops the read, as it did read whole
  await expect(rowsIn(chunksOf(new TextEncoder().encode('{"id":"a"}\n{"id":'), 3))).rejects.toThrow()
})

test("[MUST-FAIL] what a read leaves behind is collected as it goes, once per bound of bytes read, and the rows are unchanged", async () => {
  const text = Array.from({ length: 50 }, (_, i) => JSON.stringify(row(i + 1, { note: "é".repeat(i % 5) }))).join("\n") + "\n"
  const bytes = new TextEncoder().encode(text)
  let n = 0
  expect(await rowsIn(chunksOf(bytes, 5), () => { n++ }, 100)).toEqual(whole(text))
  // 5-byte chunks reach exactly 100 bytes at every 20th chunk, so a collection follows each 20th, none in between
  expect(bytes.length).toBeGreaterThan(20 * 5 * 10)
  expect(n).toBe(Math.floor(Math.ceil(bytes.length / 5) / 20))
  // by default the bound is large: a small read collects nothing
  let none = 0
  expect(await rowsIn(chunksOf(bytes, 7), () => { none++ })).toEqual(whole(text))
  expect(none).toBe(0)
})
