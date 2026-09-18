/**
 * Who outreach mail is FROM. Orbit's key sends from Orbit's domain; a user's own Resend key
 * must send from a domain verified in THEIR account, or not at all — never from Orbit's.
 * The Resend domains lookup is injected; no network.
 * Run: npx tsx scripts/smoke-outreach-sender.ts
 */
import { UserFacingError } from "../src/lib/errors";
import {
  NO_VERIFIED_DOMAIN_MESSAGE,
  SENDER_CACHE_TTL_MS,
  __clearSenderCacheForTests,
  outreachFromAddress,
  type ListResendDomains,
} from "../src/lib/outreach-sender";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const HOSTED_FROM = "Orbit <outreach@orbit.example>";
function lookup(result: Awaited<ReturnType<ListResendDomains>> | Error) {
  let calls = 0;
  const fn: ListResendDomains = async () => {
    calls++;
    if (result instanceof Error) throw result;
    return result;
  };
  return { fn, calls: () => calls };
}
async function refused(p: Promise<string>) {
  try {
    return { from: await p, error: null as unknown };
  } catch (error) {
    return { from: null, error };
  }
}

async function main() {
  const base = { userId: "u1", apiKey: "re_user_1", resendKeyIsPersonal: true, firstName: "Ada", hostedFrom: HOSTED_FROM };

  console.log("a verified domain is used, with the user's first name");
  __clearSenderCacheForTests();
  let t = 1_000;
  const found = lookup([{ name: "pending.acme.com", status: "pending" }, { name: "acme.com", status: "verified" }]);
  const from = await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("sends as the user from their verified domain", from === "Ada <outreach@acme.com>", from);
  await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("cached for the next send", found.calls() === 1, String(found.calls()));
  t += SENDER_CACHE_TTL_MS + 1;
  await outreachFromAddress({ ...base, listDomains: found.fn, now: () => t });
  check("looked up again after ten minutes", found.calls() === 2, String(found.calls()));
  const nameless = await outreachFromAddress({ ...base, userId: "u2", firstName: null, listDomains: found.fn, now: () => t });
  check("no first name, bare address", nameless === "outreach@acme.com", nameless);
  const rekeyed = lookup([{ name: "other.dev", status: "verified" }]);
  const afterNewKey = await outreachFromAddress({ ...base, apiKey: "re_user_new", listDomains: rekeyed.fn, now: () => t });
  check("a new key is looked up, not served from the old key's cache", afterNewKey === "Ada <outreach@other.dev>" && rekeyed.calls() === 1, afterNewKey);

  console.log("no verified domain refuses the send");
  __clearSenderCacheForTests();
  const none = lookup([{ name: "acme.com", status: "pending" }, { name: "b.io", status: "failed" }]);
  const r1 = await refused(outreachFromAddress({ ...base, listDomains: none.fn }));
  check("refused with the house message", r1.error instanceof UserFacingError && (r1.error as Error).message === NO_VERIFIED_DOMAIN_MESSAGE, String(r1.error));
  const fixed = lookup([{ name: "acme.com", status: "verified" }]);
  const r2 = await outreachFromAddress({ ...base, listDomains: fixed.fn });
  check("a refusal is not cached — verifying then retrying works", r2 === "Ada <outreach@acme.com>", r2);

  console.log("a lookup error refuses too, never falling back to Orbit's domain");
  __clearSenderCacheForTests();
  const broken = lookup(new Error("Resend domains lookup: restricted_api_key"));
  const r3 = await refused(outreachFromAddress({ ...base, listDomains: broken.fn }));
  check("same message", r3.error instanceof UserFacingError && (r3.error as Error).message === NO_VERIFIED_DOMAIN_MESSAGE, String(r3.error));
  check("no from address at all", r3.from === null);

  console.log("hosted sending is unchanged");
  const never = lookup(new Error("must not be called"));
  const hosted = await outreachFromAddress({ ...base, resendKeyIsPersonal: false, apiKey: "re_orbit", listDomains: never.fn });
  check("Orbit's key keeps Orbit's from", hosted === HOSTED_FROM && never.calls() === 0, hosted);

  check("house voice", !NO_VERIFIED_DOMAIN_MESSAGE.includes("'") && !NO_VERIFIED_DOMAIN_MESSAGE.endsWith(".") && !/failed/i.test(NO_VERIFIED_DOMAIN_MESSAGE));
  console.log(failures === 0 ? "\nALL PASS" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}
main().catch((err) => { console.error(err); process.exit(1); });
