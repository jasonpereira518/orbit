/**
 * Email signatures: cleaning, the "-- " delimiter, and storage.
 * Run: npx tsx scripts/smoke-email-signature.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { appendSignature, cleanSignature, SIGNATURE_MAX, stripSignature } from "../src/lib/email/signature";
import { loadEmailSettings, saveEmailSignature } from "../src/lib/email/settings";
import { purgeUserData } from "../src/lib/user-data";

const USER = "smoke-email-signature-user";
function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}

async function main() {
  check("blank is null", cleanSignature("  \n ") === null);
  check("non-string is null", cleanSignature(42) === null);
  check("trimmed, CRLF normalized", cleanSignature("  Jason\r\nOrbit  ") === "Jason\nOrbit");
  check("control and zero-width characters stripped", cleanSignature(`Ja${String.fromCharCode(0x200b, 0)}son`) === "Jason");
  check("markup is kept as text, never interpreted", cleanSignature("<b>Jason</b>") === "<b>Jason</b>");
  check("capped", Array.from(cleanSignature("x".repeat(SIGNATURE_MAX + 50)) ?? "").length === SIGNATURE_MAX);

  check("append uses the standard delimiter", appendSignature("Hi Maya", "Jason") === "Hi Maya\n\n-- \nJason");
  check("no signature, body unchanged", appendSignature("Hi Maya", null) === "Hi Maya");
  check("strip undoes append", stripSignature(appendSignature("Hi Maya", "Jason"), "Jason") === "Hi Maya");
  check("strip leaves a body without it alone", stripSignature("Hi Maya\n-- Jason", "Jason") === "Hi Maya\n-- Jason");
  check("an already signed body is not signed twice", appendSignature("Hi Maya\n\n-- \nJason", "Jason") === "Hi Maya\n\n-- \nJason");

  await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  try {
    check("nothing stored yet", (await loadEmailSettings(USER)).signature === null);
    check("save returns the cleaned value", (await saveEmailSignature(USER, "  Jason P\r\n")) === "Jason P");
    check("load reads it back", (await loadEmailSettings(USER)).signature === "Jason P");
    check("saving blank clears it", (await saveEmailSignature(USER, "   ")) === null && (await loadEmailSettings(USER)).signature === null);
  } finally {
    await purgeUserData(USER, { keepSettings: false }).catch(() => {});
  }
  console.log("\nAll email-signature checks passed.");
}

run(main);
