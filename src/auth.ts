// SPDX-License-Identifier: MIT
import { IDENTITY_URL, OWNER_KEY_ID } from "./config"
import { AUTH_SCHEME, IDENTITY_RESOLVE } from "./routes"
import { AUTHENTICATION, OWNER, PERSON, VESSEL_KEY } from "./shapes"
import { type Row, rows } from "./store"

export type Who = { ok: boolean; keyId: string; writer: string; role: string }
type Answer = { success: boolean; data: { authenticated: boolean; keyId: string } }

const known = new Map<string, string>()

export const keyOf = (req: Request): string => String(req.headers.get("authorization")).split(" ").slice(1).join(" ")

const validate = async (key: string): Promise<string | undefined> => {
  const h = new Bun.CryptoHasher("sha256").update(key).digest("hex")
  const hit = known.get(h)
  if (hit !== undefined) {
    return hit
  }
  const init = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ impulse: { type: AUTHENTICATION, pointer: { type: "apiKey", apiKey: key } } }),
    timeout: false,
  }
  const r = await fetch(new URL(IDENTITY_RESOLVE, IDENTITY_URL).href, init)
  if (!r.ok) {
    return undefined
  }
  const a = (await r.json()) as Answer
  if (!a.success) {
    return undefined
  }
  if (!a.data.authenticated) {
    return undefined
  }
  known.set(h, String(a.data.keyId))
  return String(a.data.keyId)
}

export const authenticate = async (req: Request): Promise<Who> => {
  const keyId = await validate(keyOf(req))
  if (keyId === undefined) {
    return { ok: false, keyId: "", writer: "", role: "" }
  }
  if (keyId === OWNER_KEY_ID) {
    return { ok: true, keyId, writer: OWNER, role: OWNER }
  }
  const latest = new Map<string, Row>()
  for (const r of rows.filter((x) => x.shape === VESSEL_KEY).filter((x) => x.role === OWNER)) {
    latest.set(String(r.key_id), r)
  }
  const v = latest.get(keyId)
  if (v === undefined) {
    return { ok: true, keyId, writer: keyId, role: PERSON }
  }
  return { ok: true, keyId, writer: String(v.vessel_id), role: String(v.vessel_role) }
}
