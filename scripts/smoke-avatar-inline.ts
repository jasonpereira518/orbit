/**
 * `resolveAvatarNow` fetches one contact's photo on the request that created them, so a
 * person logged from a single LinkedIn URL arrives with a face instead of a placeholder.
 *
 * What matters here is what it does NOT do: spend a lookup on a contact that already has a
 * photo or has no profile to look one up from, and never fail the save it is attached to.
 * Both deps are injected, so no network, no Blob store and no quota are involved.
 *
 * Runs against the local PGlite database. Run: npx tsx scripts/smoke-avatar-inline.ts
 */
import "./smoke/_env";

import { eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { contacts } from "../src/db/schema";
import { resolveAvatarNow } from "../src/lib/avatar-backfill";
import { MicrolinkRateLimitError } from "../src/lib/contact-avatar";

const USER = "smoke-avatar-inline-user";
const OTHER_USER = "smoke-avatar-inline-other";
const DURABLE = "https://smoke.public.blob.vercel-storage.com/avatars/x.jpg";
const RESOLVED = "https://smoke.public.blob.vercel-storage.com/avatars/resolved.jpg";

let failures = 0;

function check(label: string, cond: boolean, detail?: string) {
  if (cond) {
    console.log(`  ok  ${label}`);
    return;
  }
  failures += 1;
  console.log(`  FAIL ${label}${detail ? `: ${detail}` : ""}`);
}

/** Records what the resolver was asked to do, so "spent nothing" is assertable. */
function spy(
  behaviour: {
    linkedIn?: (id: string, url: string) => Promise<string | null>;
    remote?: (id: string, url: string) => Promise<string | null>;
  } = {}
) {
  const linkedInCalls: string[] = [];
  const remoteCalls: string[] = [];
  return {
    linkedInCalls,
    remoteCalls,
    deps: {
      resolveLinkedIn: async (id: string, url: string) => {
        linkedInCalls.push(url);
        return behaviour.linkedIn ? behaviour.linkedIn(id, url) : RESOLVED;
      },
      persistRemote: async (id: string, url: string) => {
        remoteCalls.push(url);
        return behaviour.remote ? behaviour.remote(id, url) : RESOLVED;
      },
    },
  };
}

let db: Awaited<ReturnType<typeof getDb>>;

async function seed(
  userId: string,
  fullName: string,
  fields: { linkedinUrl?: string | null; profileImageUrl?: string | null }
) {
  const [row] = await db
    .insert(contacts)
    .values({ userId, fullName, ...fields })
    .returning();
  return row!.id;
}

async function photoOf(id: string) {
  const row = await db.query.contacts.findFirst({ where: eq(contacts.id, id) });
  return row?.profileImageUrl ?? null;
}

async function main() {
  db = await getDb();
  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, OTHER_USER));

  console.log("\nresolves the contact that needs a photo");
  {
    const id = await seed(USER, "Needs photo", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const s = spy();
    const saved = await resolveAvatarNow(db, USER, id, s.deps);
    check("reports that a photo landed", saved === true);
    check("looked the profile up once", s.linkedInCalls.length === 1, s.linkedInCalls.join());
    check("stored the resolved photo", (await photoOf(id)) === RESOLVED);
  }

  console.log("\nspends nothing when there is nothing to do");
  {
    const durable = await seed(USER, "Already has one", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: DURABLE,
    });
    const s1 = spy();
    const savedDurable = await resolveAvatarNow(db, USER, durable, s1.deps);
    check("a durable photo is left alone", savedDurable === false);
    check("no lookup spent on it", s1.linkedInCalls.length === 0 && s1.remoteCalls.length === 0);
    check("the stored photo is unchanged", (await photoOf(durable)) === DURABLE);

    // Nothing to look up FROM: without a profile URL the lookup has no input, so the
    // ordinary backfill would skip this contact too.
    const noUrl = await seed(USER, "No profile", { linkedinUrl: null, profileImageUrl: null });
    const s2 = spy();
    const savedNoUrl = await resolveAvatarNow(db, USER, noUrl, s2.deps);
    check("a contact with no LinkedIn URL is skipped", savedNoUrl === false);
    check("no lookup spent on it either", s2.linkedInCalls.length === 0);
  }

  console.log("\ncaches an already-known remote photo instead of looking one up");
  {
    const id = await seed(USER, "Remote photo", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: "https://media.licdn.com/dms/image/x.jpg",
    });
    const s = spy();
    const saved = await resolveAvatarNow(db, USER, id, s.deps);
    check("the remote photo is persisted", saved === true);
    check("it was cached, not re-looked-up", s.remoteCalls.length === 1 && s.linkedInCalls.length === 0);
    check("the durable URL replaced the remote one", (await photoOf(id)) === RESOLVED);
  }

  console.log("\nnever fails the save it is attached to");
  {
    // Each of these is a different reason a photo can't be had; none of them is a reason the
    // contact should fail to be created.
    const rateLimited = await seed(USER, "Rate limited", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const saved1 = await resolveAvatarNow(
      db,
      USER,
      rateLimited,
      spy({
        linkedIn: async () => {
          throw new MicrolinkRateLimitError(Date.now() + 60_000);
        },
      }).deps
    );
    check("a rate limit returns false rather than throwing", saved1 === false);
    check("no photo was stored", (await photoOf(rateLimited)) === null);

    const broken = await seed(USER, "Lookup exploded", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const saved2 = await resolveAvatarNow(
      db,
      USER,
      broken,
      spy({
        linkedIn: async () => {
          throw new Error("network on fire");
        },
      }).deps
    );
    check("an unexpected failure returns false rather than throwing", saved2 === false);

    const noneFound = await seed(USER, "No photo exists", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const saved3 = await resolveAvatarNow(
      db,
      USER,
      noneFound,
      spy({ linkedIn: async () => null }).deps
    );
    check("a profile with no findable photo returns false", saved3 === false);
    check("and stores nothing", (await photoOf(noneFound)) === null);
  }

  console.log("\nscoped to the owner");
  {
    const theirs = await seed(OTHER_USER, "Someone else's contact", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const s = spy();
    const saved = await resolveAvatarNow(db, USER, theirs, s.deps);
    check("another user's contact is not resolvable", saved === false);
    check("and no lookup was spent", s.linkedInCalls.length === 0);
    check("their row is untouched", (await photoOf(theirs)) === null);
  }

  console.log("\nholds the save to its budget");
  {
    // A slow lookup must not hold the save open. The batch's own deadline only gates
    // STARTING a contact, so with a single one it bounds nothing — this asserts the race
    // that actually does.
    const slow = await seed(USER, "Slow lookup", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const startedAt = Date.now();
    const saved = await resolveAvatarNow(db, USER, slow, {
      ...spy({
        linkedIn: async () =>
          new Promise((resolve) => setTimeout(() => resolve(RESOLVED), 3_000)),
      }).deps,
      deadline: Date.now() + 250,
    });
    const elapsed = Date.now() - startedAt;
    check("returns when the budget expires, not when the lookup does", saved === false);
    check(
      `waited ~250ms rather than the lookup's 3s (took ${elapsed}ms)`,
      elapsed < 1_500,
      `${elapsed}ms`
    );

    const id = await seed(USER, "Past deadline", {
      linkedinUrl: "https://www.linkedin.com/in/sarah-chen",
      profileImageUrl: null,
    });
    const s = spy();
    const saved2 = await resolveAvatarNow(db, USER, id, {
      ...s.deps,
      deadline: Date.now() - 1,
    });
    check("an expired budget attempts nothing", saved2 === false && s.linkedInCalls.length === 0);
  }

  await db.delete(contacts).where(eq(contacts.userId, USER));
  await db.delete(contacts).where(eq(contacts.userId, OTHER_USER));

  if (failures > 0) {
      throw new Error(`${failures} inline-avatar check(s) failed`);
    }
  console.log("\nAll inline-avatar checks passed\n");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
