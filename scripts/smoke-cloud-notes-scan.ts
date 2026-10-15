/**
 * The cloud-notes scan against PGlite, with Google Drive stubbed: the first pass looks back
 * and flags its finds as backlog (never auto-extracted); later passes follow the change cursor;
 * a doc already filed is never filed twice; a name that rules a doc out never opens it; reads
 * and auto-extracts are capped per pass; a dead grant parks the drive for a day instead of
 * failing the pass; the lease stops two runs claiming one drive; and the bell gets one row.
 *
 * Run: npx tsx scripts/smoke-cloud-notes-scan.ts
 */
import "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import { captureJobs, cloudNoteFiles, cloudNoteSources, userSettings } from "../src/db/schema";
import {
  claimDueSources,
  claimStaleSourcesForUser,
  MAX_AUTO_EXTRACT,
  MAX_READS,
  scanSource,
  scanStaleCloudNotesForUser,
  type ScanDeps,
} from "../src/lib/cloud-notes/scan";
import { NO_ENGINES } from "../src/lib/decisions/engine";
import { loadNotificationPanel } from "../src/lib/notification-panel";
import { ensureUserSettings } from "../src/lib/user-settings";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) console.log(`  ok   ${label}`);
  else {
    failures++;
    console.error(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

const USER = "user_cloud_notes_smoke";
const DOC = "application/vnd.google-apps.document";
type Doc = { id: string; name: string; text: string };

/** A fake Drive: the backlog listing, change pages keyed by cursor, and each doc's text. */
function fakeDrive(backlog: Doc[], changes: Record<string, { docs: Doc[]; next: string }>) {
  const texts = new Map<string, string>();
  for (const d of [...backlog, ...Object.values(changes).flatMap((c) => c.docs)]) texts.set(d.id, d.text);
  const exported: string[] = [];
  const file = (d: Doc) => ({ id: d.id, name: d.name, mimeType: DOC, modifiedTime: "2026-10-10T10:00:00Z" });
  const fetchImpl: typeof fetch = async (input) => {
    const url = String(input);
    if (url.includes("/changes/startPageToken")) return Response.json({ startPageToken: "s1" });
    if (url.includes("/changes?")) {
      const page = changes[new URL(url).searchParams.get("pageToken") ?? ""];
      return Response.json({ newStartPageToken: page?.next ?? "end", changes: (page?.docs ?? []).map((d) => ({ file: file(d) })) });
    }
    if (url.includes("/export")) {
      const id = decodeURIComponent(url.split("/files/")[1].split("/export")[0]);
      exported.push(id);
      return new Response(texts.get(id) ?? "", { status: texts.has(id) ? 200 : 404 });
    }
    if (url.includes("/files?")) return Response.json({ files: backlog.map(file) });
    return new Response("", { status: 404 });
  };
  return { fetchImpl, exported };
}

const NOTES = "Notes by Gemini\nAttendees: Ana, Raj\nAna is moving to platform.";

async function main() {
  const db = await getDb();
  await ensureUserSettings(USER);
  await db.update(userSettings).set({ cloudNotesAutoExtract: 1 }).where(eq(userSettings.userId, USER));
  await db.insert(cloudNoteSources).values({ userId: USER, provider: "google" });

  const started: string[] = [];
  const deps = (fetchImpl: typeof fetch, now: Date): ScanDeps => ({
    now,
    ctxFor: async () => ({ token: "t", fetchImpl }),
    engines: async () => NO_ENGINES,
    startRuns: async (ids) => void started.push(...ids),
  });
  const rows = () => db.select().from(cloudNoteFiles).where(eq(cloudNoteFiles.userId, USER));
  const source = async () =>
    (await db.select().from(cloudNoteSources).where(and(eq(cloudNoteSources.userId, USER), eq(cloudNoteSources.provider, "google"))))[0]!;

  console.log("First pass: the 30-day look-back");
  const pass1 = fakeDrive(
    [
      { id: "doc-sync-aaaa", name: "Weekly sync notes", text: NOTES },
      { id: "doc-numb-aaaa", name: "Q4 numbers", text: "Revenue up 4%." },
      { id: "doc-resu-aaaa", name: "Resume 2026", text: "Experience" },
    ],
    {},
  );
  const t1 = new Date("2026-10-14T10:00:00Z");
  const r1 = await scanSource(USER, "google", deps(pass1.fetchImpl, t1));
  let all = await rows();
  check("the meeting notes are found", r1.found === 1 && all.length === 1 && all[0].fileId === "doc-sync-aaaa");
  check("flagged as backlog", all[0]?.fromBackfill === 1 && all[0]?.status === "found");
  check("the backlog is never auto-extracted", started.length === 0 && all[0]?.captureJobId === null);
  check("a résumé is never opened", !pass1.exported.includes("doc-resu-aaaa"), pass1.exported.join());
  let src = await source();
  check("the cursor is taken before the look-back", src.cursor === "s1" && src.backfilledAt !== null);
  check("due again in 30 minutes", src.nextScanAt.getTime() === t1.getTime() + 30 * 60_000);

  console.log("\nLater pass: the change cursor, and auto-extract");
  const pass2 = fakeDrive([], {
    s1: {
      docs: [
        { id: "doc-sync-aaaa", name: "Weekly sync notes", text: NOTES },
        { id: "doc-gemi-aaaa", name: "Untitled document", text: NOTES },
      ],
      next: "s2",
    },
  });
  const r2 = await scanSource(USER, "google", deps(pass2.fetchImpl, new Date("2026-10-14T10:31:00Z")));
  all = await rows();
  const gem = all.find((r) => r.fileId === "doc-gemi-aaaa");
  check("a doc already filed is not filed again", all.filter((r) => r.fileId === "doc-sync-aaaa").length === 1);
  check("the new doc is found and auto-extracted", r2.found === 1 && r2.autoExtracted === 1 && gem?.status === "queued" && gem.fromBackfill === 0);
  check("…as a capture job that was started", Boolean(gem?.captureJobId) && started.includes(gem!.captureJobId!));
  const [job] = await db.select().from(captureJobs).where(eq(captureJobs.id, gem!.captureJobId!));
  check("the job holds the doc's text, labelled with its name", job?.inputText === NOTES && job.sourceLabel === "Untitled document" && job.status === "queued");
  check("the cursor moves on", (await source()).cursor === "s2");

  console.log("\nCaps");
  const many = Array.from({ length: MAX_READS + 5 }, (_, i) => ({ id: `doc-many-${String(i).padStart(4, "0")}`, name: `Thoughts ${i}`, text: "Nothing here." }));
  const pass3 = fakeDrive([], { s2: { docs: many, next: "s3" } });
  await scanSource(USER, "google", deps(pass3.fetchImpl, new Date("2026-10-14T11:02:00Z")));
  check(`at most ${MAX_READS} docs opened per pass`, pass3.exported.length === MAX_READS, String(pass3.exported.length));

  const burst = Array.from({ length: MAX_AUTO_EXTRACT + 2 }, (_, i) => ({ id: `doc-brst-${String(i).padStart(4, "0")}`, name: `Call ${i}`, text: NOTES }));
  const before = started.length;
  const pass4 = fakeDrive([], { s3: { docs: burst, next: "s4" } });
  const r4 = await scanSource(USER, "google", deps(pass4.fetchImpl, new Date("2026-10-14T11:33:00Z")));
  check(`at most ${MAX_AUTO_EXTRACT} auto-extracts per pass`, r4.autoExtracted === MAX_AUTO_EXTRACT && started.length - before === MAX_AUTO_EXTRACT);
  all = await rows();
  check("the rest wait as found", all.filter((r) => r.fileId.startsWith("doc-brst") && r.status === "found").length === 2);

  console.log("\nThe bell");
  const panel = await loadNotificationPanel(USER, new Date("2026-10-14T12:00:00Z"), { withAlerts: false, cloudNotes: true });
  const row = panel.items.filter((i) => i.kind === "cloud_notes");
  const foundCount = all.filter((r) => r.status === "found").length;
  check("one row for every doc waiting", row.length === 1 && row[0].title.startsWith(`${foundCount} meeting notes found in Google Drive`), row[0]?.title);
  check("the toast feed has the found and the auto-extracted", panel.cloudNotes?.newFound.length === foundCount && panel.cloudNotes.newExtracted.length === 1 + MAX_AUTO_EXTRACT);
  const off = await loadNotificationPanel(USER, new Date(), { withAlerts: false });
  check("no row when the feature is off for the viewer", !off.items.some((i) => i.kind === "cloud_notes") && off.cloudNotes === undefined);

  console.log("\nOpening the app");
  const lastScan = (await source()).lastScanAt!;
  const after = (min: number) => new Date(lastScan.getTime() + min * 60_000);
  check("a drive scanned half an hour ago is left alone", (await claimStaleSourcesForUser(USER, after(30))).length === 0);
  const opened = await claimStaleSourcesForUser(USER, after(61));
  check("an hour away claims the drive", opened.join() === "google");
  check("…once: a second open during the scan claims nothing", (await claimStaleSourcesForUser(USER, after(61.5))).length === 0);
  await db.update(cloudNoteSources).set({ leaseUntil: null }).where(eq(cloudNoteSources.userId, USER));
  const pass5 = fakeDrive([], { s4: { docs: [{ id: "doc-open-aaaa", name: "Intro call", text: NOTES }], next: "s5" } });
  const onOpen = await scanStaleCloudNotesForUser(USER, deps(pass5.fetchImpl, after(90)));
  check("the open scan reads the changes and files the new notes", onOpen.scanned === 1 && onOpen.found === 1);
  check("…and the drive is fresh again", (await source()).lastScanAt?.getTime() === after(90).getTime() && (await source()).cursor === "s5");

  console.log("\nA dead grant");
  const dead: typeof fetch = async () => new Response("", { status: 401 });
  const t5 = new Date("2026-10-14T12:04:00Z");
  const r5 = await scanSource(USER, "google", deps(dead, t5));
  src = await source();
  check("parks the drive instead of failing", r5.found === 0 && Boolean(src.lastError) && src.leaseUntil === null);
  check("for a day", src.nextScanAt.getTime() === t5.getTime() + 24 * 60 * 60_000);
  check("opening the app does not retry a dead grant", (await claimStaleSourcesForUser(USER, new Date("2026-10-14T15:00:00Z"))).length === 0);

  console.log("\nThe lease");
  check("a parked drive is not due", (await claimDueSources(10, new Date("2026-10-14T13:00:00Z"))).length === 0);
  await db.update(cloudNoteSources).set({ nextScanAt: new Date("2026-10-14T12:00:00Z") }).where(eq(cloudNoteSources.userId, USER));
  const claim1 = await claimDueSources(10, new Date("2026-10-14T13:00:00Z"));
  const claim2 = await claimDueSources(10, new Date("2026-10-14T13:00:30Z"));
  check("a due drive is claimed once", claim1.length === 1 && claim2.length === 0);

  if (failures) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log("\nAll cloud-notes scan checks passed");
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
