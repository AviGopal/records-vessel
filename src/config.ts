// SPDX-License-Identifier: MIT
const need = (name: string, v: string | undefined): string => {
  if (v === undefined) {
    console.error(`missing env ${name}`)
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need("RECORDS_VESSEL_ID", process.env.RECORDS_VESSEL_ID)
export const PORT = Number(need("RECORDS_PORT", process.env.RECORDS_PORT))
export const DISCOVERY_URL = need("DISCOVERY_URL", process.env.DISCOVERY_URL)
export const ENDPOINT = need("RECORDS_ENDPOINT", process.env.RECORDS_ENDPOINT)
export const DATA_DIR = need("RECORDS_DATA_DIR", process.env.RECORDS_DATA_DIR)
export const IDENTITY_URL = need("IDENTITY_VESSEL_URL", process.env.IDENTITY_VESSEL_URL)
export const KEY = need("METABOB_API_KEY", process.env.METABOB_API_KEY)
// This node's federation transport, as its bootstrap identity names it. Unset (no federation): no on-behalf-of token is
// accepted, since there is no node to have minted it for.
export const TRANSPORT_ID = process.env.FED_VESSEL_ID ?? ""
