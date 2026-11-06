/**
 * `suggestIntegrations`: which account to ask for first.
 *
 * The claim worth guarding is what it refuses to claim: a work address gets the default order
 * and no "email_domain" reason, because nothing here can tell Google Workspace from Microsoft
 * 365. A wrong confident guess in onboarding is worse than no guess.
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { providerForEmail, suggestIntegrations } from "../src/lib/integration-suggestions";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

const order = (email: string | null, connected = {}) =>
  suggestIntegrations({ email, connected }).map((s) => s.provider);

run(async () => {
  console.log("what an address points at");
  check("gmail.com is Google", providerForEmail("a@gmail.com") === "google");
  check("googlemail.com is Google", providerForEmail("a@googlemail.com") === "google");
  check("hotmail.com and outlook.com are Microsoft", providerForEmail("a@hotmail.com") === "microsoft" && providerForEmail("a@outlook.com") === "microsoft");
  check("icloud.com and me.com are Apple", providerForEmail("a@icloud.com") === "apple" && providerForEmail("a@me.com") === "apple");
  check("the domain is case-insensitive", providerForEmail("A@GMAIL.COM") === "google");
  check("a work address points at nothing", providerForEmail("jane@acme.com") === null);
  check("a look-alike domain is not Google", providerForEmail("a@notgmail.com") === null && providerForEmail("a@gmail.com.evil.io") === null);
  check("no address, or a malformed one, points at nothing", providerForEmail(null) === null && providerForEmail("nope") === null);

  console.log("\nordering");
  check("a Microsoft address puts Microsoft first, then the rest in fixed order", JSON.stringify(order("a@outlook.com")) === JSON.stringify(["microsoft", "google", "apple"]));
  check("an Apple address puts Apple first", JSON.stringify(order("a@icloud.com")) === JSON.stringify(["apple", "google", "microsoft"]));
  check("a work address gets the default order", JSON.stringify(order("jane@acme.com")) === JSON.stringify(["google", "microsoft", "apple"]));

  const reasons = suggestIntegrations({ email: "a@outlook.com" }).map((s) => s.reason);
  check("only the domain match claims a reason", JSON.stringify(reasons) === JSON.stringify(["email_domain", "default", "default"]));
  const workReasons = suggestIntegrations({ email: "jane@acme.com" }).map((s) => s.reason);
  check("a work address claims no domain reason at all", workReasons.every((r) => r === "default"));

  console.log("\nwhat is already connected");
  check("connected providers are left out", JSON.stringify(order("a@gmail.com", { google: true })) === JSON.stringify(["microsoft", "apple"]));
  check("the next best becomes first when the preferred one is done", suggestIntegrations({ email: "a@gmail.com", connected: { google: true } })[0].provider === "microsoft");
  check("everything connected means nothing left to ask", order("a@gmail.com", { google: true, microsoft: true, apple: true }).length === 0);

  if (failures > 0) {
    console.error(`\n${failures} check(s) failed.`);
    process.exit(1);
  }
  console.log("\nAll integration suggestion checks passed.");
});
