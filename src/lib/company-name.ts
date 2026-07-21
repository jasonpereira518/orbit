/** Pure company-name helpers — safe for client bundles (no DB). */

export function normalizeCompanyName(raw: string) {
  return raw.trim().replace(/\s+/g, " ").toLowerCase();
}

export function displayCompanyName(raw: string) {
  return raw.trim().replace(/\s+/g, " ");
}
