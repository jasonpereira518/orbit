/**
 * Recruiter contact details are per link; the shared row holds only what sharing users
 * vouch for (audit A8). Run: npx tsx scripts/smoke-recruiter-pii.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { recruiters, userSettings } from "../src/db/schema";
import {
  ensureUserLink,
  pickPooledPii,
  resolveRecruiterPii,
  resweepUserRatings,
  toPublicRecruiter,
  upsertCanonicalRecruiter,
} from "../src/lib/recruiters";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
const none = { email: null, phone: null, linkedinUrl: null };

async function main() {
  console.log("Pure");
  const row = { email: "shared@r.test", phone: null, linkedinUrl: null };
  check("own link wins", resolveRecruiterPii(row, { email: "mine@r.test", phone: null, linkedinUrl: null }, true).email === "mine@r.test");
  check("pooled viewer falls back to the shared row", resolveRecruiterPii(row, null, true).email === "shared@r.test");
  check("a link alone no longer unlocks someone else's details", resolveRecruiterPii(row, { ...none }, false).email === null);
  check("strict: an unvouched value is dropped", pickPooledPii(row, [], { strict: true }).email === null);
  check("strict: a vouched value stays (case-insensitive)", pickPooledPii(row, [{ ...none, email: "SHARED@r.test" }], { strict: true }).email === "shared@r.test");
  check("legacy: an unvouched value stays", pickPooledPii(row, [], { strict: false }).email === "shared@r.test");
  check("legacy: withdrawn by its owner, it goes", pickPooledPii(row, [], { strict: false, withdrawn: { ...none, email: "shared@r.test" } }).email === null);
  check("an empty field is filled from a pooled link", pickPooledPii({ ...none }, [{ ...none, phone: "+1 555" }], { strict: true }).phone === "+1 555");

  console.log("\nDatabase");
  const db = await getDb();
  await db.insert(userSettings).values([
    { userId: "smoke-pii-private", recruiterSharing: 0 },
    { userId: "smoke-pii-sharer", recruiterSharing: 1 },
    { userId: "smoke-pii-viewer", recruiterSharing: 1 },
  ]);
  const created = await upsertCanonicalRecruiter(
    { fullName: "Pat Recruiter", firm: "Acme Talent", email: "pat.private@r.test" },
    { contributePii: false, createdByUserId: "smoke-pii-private" }
  );
  check("a private user's email never reaches the shared row", created.email === null && created.createdByUserId === "smoke-pii-private");
  const { link: privateLink } = await ensureUserLink({ userId: "smoke-pii-private", recruiterId: created.id, email: "pat.private@r.test" });
  check("...it is on their own link", privateLink.email === "pat.private@r.test");

  const same = await upsertCanonicalRecruiter({ fullName: "Pat Recruiter", firm: "Acme Talent", email: "pat@acme.test" }, { contributePii: true, createdByUserId: "smoke-pii-sharer" });
  const { link: sharerLink } = await ensureUserLink({ userId: "smoke-pii-sharer", recruiterId: same.id, email: "pat@acme.test" });
  check("a sharing user's email fills the shared row", same.id === created.id && same.email === "pat@acme.test");
  const fresh = (await db.query.recruiters.findFirst({ where: eq(recruiters.id, created.id) }))!;
  check("the private owner still sees their own address", toPublicRecruiter(fresh, privateLink, false).email === "pat.private@r.test");
  check("a pooled viewer sees the contributed one", toPublicRecruiter(fresh, null, true).email === "pat@acme.test");

  await db.update(userSettings).set({ recruiterSharing: 0 }).where(eq(userSettings.userId, "smoke-pii-sharer"));
  await resweepUserRatings("smoke-pii-sharer");
  const after = (await db.query.recruiters.findFirst({ where: eq(recruiters.id, created.id) }))!;
  check("turning sharing off withdraws the contribution", after.email === null, String(after.email));
  check("...but the contributor keeps it on their link", sharerLink.email === "pat@acme.test");

  await db.delete(recruiters).where(eq(recruiters.id, created.id));
  console.log("\nAll recruiter-PII checks passed.");
}

run(main);
