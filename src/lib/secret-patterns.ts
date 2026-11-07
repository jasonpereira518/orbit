/** Import-free: shared by `ai-security` (model output) and `sentry-scrub` (every runtime). */

/**
 * Secret-shaped strings. None of these should ever appear in a model's answer: Orbit never
 * puts a credential in a prompt, so one showing up means either a user pasted it into a note
 * (and the answer is about to repeat it somewhere it may be shared or logged) or something
 * upstream is badly wrong. Either way the answer should not carry it.
 */
export const SECRET_PATTERNS: ReadonlyArray<[string, RegExp]> = [
  ["orbit_api_key", /\b(?:orb_live|orb_test|mcpk_live)_[0-9a-f]{8}_[A-Za-z0-9_-]{20,}/g],
  ["anthropic_key", /\bsk-ant-[A-Za-z0-9_-]{20,}/g],
  ["openai_key", /\bsk-(?:proj-|or-v1-)?[A-Za-z0-9_-]{32,}/g],
  ["google_key", /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ["github_token", /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{30,}/g],
  ["slack_token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/g],
  ["stripe_key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ["aws_access_key", /\bAKIA[0-9A-Z]{16}\b/g],
  ["resend_key", /\bre_[A-Za-z0-9]{8,}_[A-Za-z0-9]{20,}/g],
  ["twilio_api_key_sid", /\bSK[0-9a-f]{32}\b/g],
  ["jwt", /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["private_key", /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g],
];
