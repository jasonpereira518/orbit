/**
 * Compose drafts in localStorage: account-scoped keys, TTL, shape validation, and storage
 * that throws. Run: npx tsx scripts/smoke-compose-draft.ts
 */
import {
  clearComposeDraft,
  composeDraftKey,
  COMPOSE_DRAFT_TTL_MS,
  readComposeDraft,
  writeComposeDraft,
} from "../src/lib/compose-draft";

function check(label: string, ok: boolean, detail?: string) {
  if (!ok) throw new Error(`${label} failed${detail ? `: ${detail}` : ""}`);
  console.log(`  ok  ${label}`);
}
function memory(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear: () => m.clear(),
    key: (i: number) => [...m.keys()][i] ?? null,
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

const s = memory();
const key = composeDraftKey("u1", "c1");
check("keys are per account and per contact", key !== composeDraftKey("u2", "c1") && key !== composeDraftKey("u1", null));
const draft = { to: ["maya@work.io"], cc: [], bcc: [], subject: "Hi", body: "Coffee?" };
writeComposeDraft(s, key, draft, 1_000);
check("round-trips", JSON.stringify(readComposeDraft(s, key, 2_000)) === JSON.stringify(draft));
check("expires after the TTL", readComposeDraft(s, key, 1_000 + COMPOSE_DRAFT_TTL_MS + 1) === null);
check("and the expired entry is removed", s.getItem(key) === null);
writeComposeDraft(s, key, { ...draft, subject: "", body: "  " }, 1_000);
check("an empty draft is not stored", s.getItem(key) === null);
s.setItem(key, "{not json");
check("junk reads as nothing, and is removed", readComposeDraft(s, key) === null && s.getItem(key) === null);
s.setItem(key, JSON.stringify({ to: "nope", body: 5, savedAt: Date.now() }));
check("a wrong shape reads as nothing", readComposeDraft(s, key) === null);
writeComposeDraft(s, key, draft);
clearComposeDraft(s, key);
check("clear removes it", s.getItem(key) === null);
const broken = {
  getItem() {
    throw new Error("denied");
  },
  setItem() {
    throw new Error("full");
  },
  removeItem() {
    throw new Error("denied");
  },
} as unknown as Storage;
check(
  "storage that throws never throws out",
  (() => {
    writeComposeDraft(broken, key, draft);
    clearComposeDraft(broken, key);
    return readComposeDraft(broken, key) === null;
  })()
);
console.log("\nAll compose-draft checks passed.");
