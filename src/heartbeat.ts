// SPDX-License-Identifier: MIT
import { AGAIN_MS, again } from "./again"
import { DISCOVERY_URL, ENDPOINT, KEY, VESSEL_ID } from "./config"
import { AUTH_SCHEME, HEARTBEAT, REGISTER } from "./routes"

type Answer = { nextHeartbeatMs: number }
type Posted = { ok: true; answer: Answer } | { ok: false; status: number; why: string }

const NO_LIMIT_MS = 2147483647

// One post to discovery: its answer, or why there was none (status 0: nothing came back), never a throw.
const post = async (path: string, payload: object): Promise<Posted> => {
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `${AUTH_SCHEME} ${KEY}` },
    body: JSON.stringify(payload),
    timeout: false,
  }
  try {
    const r = await fetch(new URL(path, DISCOVERY_URL).href, init)
    if (!r.ok) return { ok: false, status: r.status, why: (await r.text().catch(() => "")).slice(0, 200) }
    return { ok: true, answer: (await r.json()) as Answer }
  } catch (e) {
    return { ok: false, status: 0, why: e instanceof Error ? `${e.name}: ${e.message}` : String(e) }
  }
}

// Discovery not answering, or refusing, never ends records: it holds the trace store and the learner, and a restart
// rebuilds the fold and cuts every call in flight. It says why and asks again, waiting longer each time.
const said = (path: string, p: { status: number; why: string }, wait: number): void =>
  console.error(`[records] ${path} ${p.status === 0 ? "had no answer" : `answered ${p.status}`} (${p.why}); asking again in ${Math.round(wait / 1000)} s`)

let registration: object = {}

const registered = async (): Promise<void> => {
  for (let wait = AGAIN_MS; ; wait = again(wait)) {
    const p = await post(REGISTER, registration)
    if (p.ok) return
    said(REGISTER, p, wait)
    await Bun.sleep(wait)
  }
}

export const register = async (shapes: string[], declared: { shape_inputs?: object; shape_descriptions?: object; shape_answers?: object } = {}): Promise<void> => {
  registration = { vesselId: VESSEL_ID, endpoint: ENDPOINT, shapes, resolve_timeout_ms: NO_LIMIT_MS, ...declared }
  await registered()
}

// A heartbeat discovery answers 404 for does not know this vessel (discovery restarted): it is registered again, as at
// start.
export const beat = async (): Promise<void> => {
  for (let wait = AGAIN_MS; ;) {
    const p = await post(HEARTBEAT, { vesselId: VESSEL_ID })
    if (p.ok) {
      wait = AGAIN_MS
      await Bun.sleep(p.answer.nextHeartbeatMs)
      continue
    }
    said(HEARTBEAT, p, wait)
    if (p.status === 404) {
      await registered()
      continue
    }
    await Bun.sleep(wait)
    wait = again(wait)
  }
}
