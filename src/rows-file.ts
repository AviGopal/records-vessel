// SPDX-License-Identifier: MIT
// The rows file read as it was written: one JSON row per line, read in the chunks the file gives, never as one string.
// A string has a hard bound (2^31 - 1 characters), and the store's file passed it: read whole, records could not start
// at all, whatever was installed. Read by lines, the only bound on the file is the memory its rows take once parsed.
export async function rowsIn<T>(chunks: AsyncIterable<Uint8Array>): Promise<T[]> {
  const out: T[] = []
  const decoder = new TextDecoder()
  // the pieces of a line not yet ended: a line, or one character's bytes, can span chunks, and is joined once it ends
  let open: string[] = []
  const take = (text: string) => {
    let from = 0
    for (let nl = text.indexOf("\n"); nl !== -1; nl = text.indexOf("\n", from)) {
      const line = open.length === 0 ? text.slice(from, nl) : [...open, text.slice(from, nl)].join("")
      open = []
      if (line.length > 0) out.push(JSON.parse(line) as T)
      from = nl + 1
    }
    if (from < text.length) open.push(text.slice(from))
  }
  for await (const chunk of chunks) take(decoder.decode(chunk, { stream: true }))
  // a last line with no newline after it is a row too, as it was when the file was read whole
  take(decoder.decode() + "\n")
  return out
}
