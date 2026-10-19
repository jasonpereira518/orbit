/**
 * Rotating ENCRYPTION_SECRET: reads fall back to ENCRYPTION_PREVIOUS_SECRETS, writes always use
 * the current secret, and reencryptAll moves every stored secret across without ever exposing
 * or losing one. Run: npx tsx scripts/smoke-crypto-rotation.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";
import { eq, sql } from "drizzle-orm";
import { getDb } from "../src/db";
import { userSettings } from "../src/db/schema";
import { decrypt, decryptDetailed, decryptOrNull, encrypt } from "../src/lib/crypto";
import { ciphertextColumns, reencryptAll } from "../src/lib/crypto-rotation";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}
const OLD = "old-secret-0123456789-0123456789-0123456789";
const NEW = "new-secret-9876543210-9876543210-9876543210";
const USER = "smoke-crypto-rotation";

run(async () => {
  const saved = { s: process.env.ENCRYPTION_SECRET, p: process.env.ENCRYPTION_PREVIOUS_SECRETS };
  const db = await getDb();
  try {
    console.log("decrypt across a rotation");
    process.env.ENCRYPTION_SECRET = OLD;
    delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    const sealedOld = encrypt("sk-user-key-1");
    check("round trip under one secret", decrypt(sealedOld) === "sk-user-key-1");

    process.env.ENCRYPTION_SECRET = NEW;
    check("rotated with no previous secret: unreadable (the failure to avoid)", decryptOrNull(sealedOld) === null);
    process.env.ENCRYPTION_PREVIOUS_SECRETS = `unrelated-secret-aaaaaaaaaaaaaaaaaaaa, ${OLD}`;
    const d = decryptDetailed(sealedOld);
    check("with the old secret listed, the old value reads and is flagged for re-encryption",
      d.plaintext === "sk-user-key-1" && d.usedPrevious === true);
    const sealedNew = encrypt("sk-user-key-2");
    check("new writes use the current secret, not a previous one", decryptDetailed(sealedNew).usedPrevious === false);
    delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    check("…and read without any previous secret", decrypt(sealedNew) === "sk-user-key-2");
    check("a corrupt value is null, not a throw", decryptOrNull("zz:zz:zz") === null);

    console.log("\nreencryptAll");
    const cols = await ciphertextColumns();
    check("it finds the ciphertext columns by name", cols.length >= 20 && cols.some((c) => c.table === "user_settings" && c.column === "openai_api_key_encrypted")
      && cols.some((c) => c.table === "calendar_subscriptions" && c.column === "ics_url"), String(cols.length));

    // The suite shares one database, and other scripts leave values sealed under their own
    // secrets. Those are legitimately undecryptable here, so measure them first and compare.
    process.env.ENCRYPTION_SECRET = NEW;
    process.env.ENCRYPTION_PREVIOUS_SECRETS = OLD;
    const baseline = (await reencryptAll({ apply: false })).undecryptable;

    process.env.ENCRYPTION_SECRET = OLD;
    delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
    await db.insert(userSettings).values({
      userId: USER,
      openaiApiKeyEncrypted: encrypt("sk-openai-123"),
      geminiApiKeyEncrypted: encrypt("gm-456"),
    });
    process.env.ENCRYPTION_SECRET = NEW;
    process.env.ENCRYPTION_PREVIOUS_SECRETS = OLD;

    const dry = await reencryptAll({ apply: false });
    check("a dry run reports what an old secret still opens and changes nothing",
      dry.remaining >= 2 && dry.rewritten === 0 && dry.undecryptable === baseline, JSON.stringify(dry));
    const applied = await reencryptAll({ apply: true });
    check("apply rewrites them", applied.rewritten >= 2 && applied.undecryptable === baseline, JSON.stringify(applied));
    const again = await reencryptAll({ apply: true });
    check("a second run has nothing left (idempotent)", again.rewritten === 0 && again.remaining === 0, JSON.stringify(again));

    delete process.env.ENCRYPTION_PREVIOUS_SECRETS;
    const row = await db.query.userSettings.findFirst({ where: eq(userSettings.userId, USER) });
    check("after dropping the old secret, every value still reads",
      decryptOrNull(row?.openaiApiKeyEncrypted) === "sk-openai-123" && decryptOrNull(row?.geminiApiKeyEncrypted) === "gm-456");

    await db.execute(sql`UPDATE user_settings SET anthropic_api_key_encrypted = ${encrypt("x").replace(/^.{24}/, "0".repeat(24))} WHERE user_id = ${USER}`);
    const bad = await reencryptAll({ apply: false });
    check("a value no secret opens is counted, so a rotation cannot be finished by mistake", bad.undecryptable === baseline + 1, JSON.stringify(bad));
  } finally {
    await db.delete(userSettings).where(eq(userSettings.userId, USER));
    if (saved.s === undefined) delete process.env.ENCRYPTION_SECRET; else process.env.ENCRYPTION_SECRET = saved.s;
    if (saved.p === undefined) delete process.env.ENCRYPTION_PREVIOUS_SECRETS; else process.env.ENCRYPTION_PREVIOUS_SECRETS = saved.p;
  }
  console.log(failures === 0 ? "\nAll crypto-rotation checks passed." : `\n${failures} check(s) failed.`);
  process.exit(failures === 0 ? 0 : 1);
});
