// SPDX-License-Identifier: MIT
const need = (v: string | undefined): string => {
  if (v === undefined) {
    process.exit(1)
  }
  return v
}
export const VESSEL_ID = need(process.env.RECORDS_VESSEL_ID)
export const PORT = Number(need(process.env.RECORDS_PORT))
export const DISCOVERY_URL = need(process.env.DISCOVERY_URL)
export const KEY_PATH = need(process.env.RECORDS_KEY_PATH)
export const ENDPOINT = need(process.env.RECORDS_ENDPOINT)
export const DATA_DIR = need(process.env.RECORDS_DATA_DIR)
export const IDENTITY_URL = need(process.env.IDENTITY_URL)
export const OWNER_KEY_ID = need(process.env.RECORDS_OWNER_KEY_ID)
export const KEY = (await Bun.file(KEY_PATH).text()).trim()
