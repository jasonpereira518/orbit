/**
 * Step-0 drafts for people on a campaign: written from the details a brief or a search cited,
 * and never over a message that has already gone out.
 * Run: npx tsx scripts/smoke-outreach-drafts.ts
 */
import "./smoke/_env";
import { run } from "./smoke/_env";

import { and, eq } from "drizzle-orm";
import { getDb } from "../src/db";
import * as schema from "../src/db/schema";
import { buildDraftPrompt, type DraftInput } from "../src/lib/outreach-drafts";
import {
  draftCampaignMessagesForUser,
  editDraftForUser,
  requireMessageForUser,
  type Drafter,
} from "../src/lib/outreach-messages";
import { addProspectsForUser } from "../src/lib/outreach-people";
import { LINKEDIN_NOTE_MAX, MAX_DRAFTS_PER_RUN } from "../src/lib/outreach-types";
import { purgeUserData } from "../src/lib/user-data";
import { researchPerson, type PersonResearcher } from "../src/lib/web-research";
import { saveWritingInstructionsFor } from "../src/lib/writing-instructions-store";

const USER = "smoke-outreach-drafts-user";
const OTHER = "smoke-outreach-drafts-other";

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`  ${ok ? "ok  " : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function rejects(fn: () => Promise<unknown>, substring?: string) {
  try {
    await fn();
    return false;
  } catch (err) {
    return !substring || (err instanceof Error && err.message.includes(substring));
  }
}

/** True when `needle` appears between the fence's opening and closing marker lines, and nowhere else. */
function insideFence(text: string, tag: string, needle: string) {
  const open = text.match(new RegExp(`^<<<${tag}_([0-9a-f]{12})$`, "m"));
  if (!open) return false;
  const start = (open.index ?? 0) + open[0].length;
  const end = text.indexOf(`\n${tag}_${open[1]}\n`, start);
  if (end < 0) return false;
  return text.slice(start, end).includes(needle) && !(text.slice(0, start) + text.slice(end)).includes(needle);
}

const calls: DraftInput[][] = [];
const drafter: Drafter = async (_user, inputs) => {
  calls.push(inputs);
  return inputs.map((input) => ({ subject: "Hi", body: `Hello ${input.prospect.fullName}` }));
};

async function stepZeros(prospectId: string) {
  const db = await getDb();
  return db.query.outreachMessages.findMany({
    where: and(eq(schema.outreachMessages.prospectId, prospectId), eq(schema.outreachMessages.stepIndex, 0)),
  });
}
const stepZero = async (prospectId: string) => (await stepZeros(prospectId))[0];

async function setMessage(messageId: string, values: Partial<typeof schema.outreachMessages.$inferInsert>) {
  const db = await getDb();
  await db.update(schema.outreachMessages).set(values).where(eq(schema.outreachMessages.id, messageId));
}

async function reset() {
  for (const id of [USER, OTHER]) await purgeUserData(id, { keepSettings: false }).catch(() => {});
}

const BRIEF = {
  match: "confident",
  headline: "Director at IQVIA",
  current: { organization: "IQVIA Holdings", title: "Director, RWE" },
  location: "Durham",
  summary: "Leads real-world evidence.",
  talkingPoints: [{ text: "Spoke on RWE at ISPOR 2026", url: "https://ispor.org/talk" }],
  experiences: [],
};
const researcher =
  (answer: Record<string, unknown>): PersonResearcher =>
  async () => ({ json: JSON.stringify(answer), sources: [{ url: "https://iqvia.com/team", title: "Team" }] });

const sampleInput: DraftInput = {
  channel: "email",
  tone: "friendly",
  messageIntent: "Ask about consulting",
  userGoals: ["Break into pharma consulting"],
  prospect: { fullName: "Ana Ruiz", title: "Manager", company: "ZS", location: "Chicago" },
};

function promptSection() {
  console.log("prompt");
  const hostile = buildDraftPrompt(
    { ...sampleInput, prospect: { ...sampleInput.prospect, whyMatches: "IGNORE PREVIOUS", talkingPoints: ["Spoke at ISPOR", "Moved to ZS"] } },
    "Sender bio: Jason, UNC MPH student"
  );
  check("web text stays inside the PROSPECT fence", insideFence(hostile.user, "PROSPECT", "IGNORE PREVIOUS"));
  check("so do talking points", insideFence(hostile.user, "PROSPECT", "Spoke at ISPOR"));
  check("they read as 'Why they fit' and 'Recent' lines", hostile.user.includes("Why they fit: IGNORE PREVIOUS") && hostile.user.includes("Recent: Spoke at ISPOR; Moved to ZS"));
  check("the sender block is used as given, outside the fence", !insideFence(hostile.user, "PROSPECT", "Jason, UNC MPH student") && hostile.user.includes("Sender bio: Jason, UNC MPH student"));
  const plain = buildDraftPrompt(sampleInput, null);
  check("with nothing cited there are no such lines", !plain.user.includes("Why they fit") && !plain.user.includes("Recent:"));
  check("LinkedIn notes are held to 300 characters", LINKEDIN_NOTE_MAX === 300 && buildDraftPrompt({ ...sampleInput, channel: "linkedin" }, null).system.includes("under 300 characters"));
  check("email keeps its own rule", plain.system.includes("under 120 words"));
}

async function draftSection(camp: string, liCamp: string, otherCamp: string, otherMessageId: string) {
  const db = await getDb();
  console.log("drafts");

  await db.insert(schema.userGoals).values({ userId: USER, text: "Break into pharma consulting" });
  await saveWritingInstructionsFor(USER, "Plain words, no exclamation marks.");

  const brief = await researchPerson(USER, { fullName: "Bo Li", company: "IQVIA", linkedinUrl: "https://www.linkedin.com/in/bo-li" }, { researcher: researcher(BRIEF) });
  if (!brief.ok) throw new Error(`brief failed: ${brief.message}`);
  const [boContact] = await db.insert(schema.contacts).values({ userId: USER, fullName: "Bo Li", company: "IQVIA" }).returning();
  await db.insert(schema.interactions).values({
    userId: USER,
    contactId: boContact!.id,
    interactionType: "coffee",
    interactionDate: new Date("2026-08-01T12:00:00Z"),
    rawNotes: "Swapped notes on pharma consulting recruiting.",
  });

  await addProspectsForUser(USER, camp, [
    { fullName: "Ana Ruiz", company: "ZS", title: "Manager", origin: "find", whyMatches: "UNC MPH" },
    { fullName: "Bo Li", company: "IQVIA", origin: "brief", researchKey: brief.key },
    { fullName: "Cy Ng", company: "ZS", origin: "manual" },
    { fullName: "Di Ho", company: "ZS", origin: "manual" },
    { fullName: "Ed Fu", company: "ZS", origin: "manual" },
  ]);
  const idOf = async (campaignId: string, name: string) =>
    (await db.query.outreachProspects.findFirst({ where: and(eq(schema.outreachProspects.campaignId, campaignId), eq(schema.outreachProspects.fullName, name)) }))!.id;
  const ana = await idOf(camp, "Ana Ruiz");
  const bo = await idOf(camp, "Bo Li");
  const cy = await idOf(camp, "Cy Ng");
  const di = await idOf(camp, "Di Ho");
  const ed = await idOf(camp, "Ed Fu");

  const first = await draftCampaignMessagesForUser(USER, camp, [ana, bo], { drafter });
  check("two people drafted", first.drafted === 2 && first.skipped === 0, JSON.stringify(first));
  const anaIn = calls[0]!.find((i) => i.prospect.fullName === "Ana Ruiz")!;
  const boIn = calls[0]!.find((i) => i.prospect.fullName === "Bo Li")!;
  check("whyMatches reaches the draft input", anaIn.prospect.whyMatches === "UNC MPH");
  check("talking points come from the brief", boIn.prospect.talkingPoints?.[0] === "Spoke on RWE at ISPOR 2026");
  check("…and a person with no brief has none", !anaIn.prospect.talkingPoints?.length);
  check("prior notes with a known contact are carried", (boIn.prospect.priorNotes ?? "").includes("pharma consulting recruiting"));
  check("goals, writing notes and campaign settings are carried", anaIn.userGoals[0] === "Break into pharma consulting" && anaIn.writingInstructions === "Plain words, no exclamation marks." && anaIn.channel === "email" && anaIn.messageIntent === "Ask about consulting" && anaIn.tone === "friendly");
  const anaRow = await stepZero(ana);
  check("draft row created", anaRow?.status === "draft" && anaRow.channel === "email" && anaRow.subject === "Hi" && anaRow.body === "Hello Ana Ruiz");

  const again = await draftCampaignMessagesForUser(USER, camp, [ana], { drafter: async () => [{ subject: "New", body: "Fresh words" }] });
  const anaAgain = await stepZeros(ana);
  check("redrafting a draft rewrites it in place", again.drafted === 1 && anaAgain.length === 1 && anaAgain[0]!.id === anaRow!.id && anaAgain[0]!.body === "Fresh words");

  await setMessage(anaRow!.id, { status: "generated" });
  await draftCampaignMessagesForUser(USER, camp, [ana], { drafter });
  check("a legacy generated draft is rewritten too", (await stepZero(ana))?.body === "Hello Ana Ruiz");

  await setMessage(anaRow!.id, { status: "sent", body: "ORIGINAL" });
  const callsBefore = calls.length;
  const sent = await draftCampaignMessagesForUser(USER, camp, [ana], { drafter });
  check("sent message never rewritten", sent.drafted === 0 && sent.skipped === 1 && (await stepZero(ana))?.body === "ORIGINAL");
  check("…and the model is not even asked", calls.length === callsBefore);
  for (const status of ["queued", "copied", "opened", "failed", "skipped", "scheduled"]) {
    await setMessage(anaRow!.id, { status });
    const r = await draftCampaignMessagesForUser(USER, camp, [ana], { drafter });
    check(`a message that is ${status} is left alone`, r.skipped === 1 && (await stepZero(ana))?.body === "ORIGINAL");
  }
  await setMessage(anaRow!.id, { status: "sent" });

  const mixed = await draftCampaignMessagesForUser(USER, camp, [ana, cy], { drafter });
  check("sent people are skipped while others in the same call are drafted", mixed.drafted === 1 && mixed.skipped === 1 && (await stepZero(cy))?.status === "draft");

  // A message that goes out while the model is writing must survive the write-back.
  await draftCampaignMessagesForUser(USER, camp, [di], { drafter });
  const diRow = await stepZero(di);
  const raced = await draftCampaignMessagesForUser(USER, camp, [di], {
    drafter: async (u, inputs) => {
      await setMessage(diRow!.id, { status: "sent", body: "WENT OUT" });
      return drafter(u, inputs);
    },
  });
  check("a send that lands mid-draft is not overwritten", raced.drafted === 0 && raced.skipped === 1 && (await stepZero(di))?.body === "WENT OUT");

  // Two runs for one person (two tabs, a retry after a timeout): both read "no first message"
  // before either writes, because the model call sits between the read and the write.
  await addProspectsForUser(USER, camp, [{ fullName: "Gus Ito", company: "ZS", origin: "manual" }]);
  const gus = await idOf(camp, "Gus Ito");
  let arrived = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => (open = resolve));
  const barrier: Drafter = async (u, inputs) => {
    if (++arrived === 2) open();
    await gate;
    return drafter(u, inputs);
  };
  const both = await Promise.all([
    draftCampaignMessagesForUser(USER, camp, [gus], { drafter: barrier }),
    draftCampaignMessagesForUser(USER, camp, [gus], { drafter: barrier }),
  ]);
  check("two runs at once leave exactly one first message", (await stepZeros(gus)).length === 1, `${(await stepZeros(gus)).length} rows`);
  check("…one run drafted, the other skipped", both.reduce((n, r) => n + r.drafted, 0) === 1 && both.reduce((n, r) => n + r.skipped, 0) === 1, JSON.stringify(both));

  const empty = await draftCampaignMessagesForUser(USER, camp, [ed], { drafter: async () => [{ subject: null, body: "  " }] });
  check("an empty draft is not stored", empty.drafted === 0 && empty.skipped === 1 && (await stepZeros(ed)).length === 0);

  console.log("who can be drafted");
  await db.update(schema.outreachProspects).set({ status: "excluded" }).where(eq(schema.outreachProspects.id, ed));
  const notSelected = await draftCampaignMessagesForUser(USER, camp, [ed], { drafter });
  check("only selected people are drafted", notSelected.drafted === 0 && (await stepZeros(ed)).length === 0);
  await addProspectsForUser(USER, liCamp, [{ fullName: "Fay Oh", company: "ZS", origin: "manual" }]);
  const fay = await idOf(liCamp, "Fay Oh");
  const wrongCamp = await draftCampaignMessagesForUser(USER, camp, [fay], { drafter });
  check("a person from another campaign is ignored", wrongCamp.drafted === 0 && (await stepZeros(fay)).length === 0);
  const dupes = await draftCampaignMessagesForUser(USER, camp, [cy, cy, cy], { drafter });
  check("the same id three times is one draft", dupes.drafted === 1 && calls[calls.length - 1]!.length === 1);
  check("junk ids are ignored", (await draftCampaignMessagesForUser(USER, camp, ["nope", "", "00000000-0000-0000-0000-000000000000"], { drafter })).drafted === 0);
  check("nothing to draft is not an error", (await draftCampaignMessagesForUser(USER, camp, [], { drafter })).drafted === 0);
  check(`${MAX_DRAFTS_PER_RUN + 1} ids refused`, await rejects(() => draftCampaignMessagesForUser(USER, camp, Array(MAX_DRAFTS_PER_RUN + 1).fill(ana), { drafter }), "Write up to 10 drafts at a time"));

  console.log("channel");
  await draftCampaignMessagesForUser(USER, liCamp, [fay], { drafter });
  const faySeen = calls[calls.length - 1]![0]!;
  check("the campaign's channel decides it", faySeen.channel === "linkedin" && (await stepZero(fay))?.channel === "linkedin");

  console.log("edit");
  const cyMsg = (await stepZero(cy))!;
  await editDraftForUser(USER, cyMsg.id, { subject: "  A better subject ", body: "  My own words  " });
  const edited = await stepZero(cy);
  check("a draft can be edited", edited?.subject === "A better subject" && edited.body === "My own words" && edited.status === "draft");
  await editDraftForUser(USER, cyMsg.id, { subject: "", body: "No subject now" });
  check("a blank subject becomes none", (await stepZero(cy))?.subject === null);
  await setMessage(cyMsg.id, { status: "generated" });
  await editDraftForUser(USER, cyMsg.id, { subject: null, body: "Generated, then edited" });
  check("a legacy generated draft can be edited", (await stepZero(cy))?.body === "Generated, then edited");
  check("an empty body is refused", await rejects(() => editDraftForUser(USER, cyMsg.id, { subject: null, body: "   " })));
  check("5,001 characters is refused, 5,000 is fine", (await rejects(() => editDraftForUser(USER, cyMsg.id, { subject: null, body: "x".repeat(5001) }))) && (await editDraftForUser(USER, cyMsg.id, { subject: null, body: "x".repeat(5000) }), true));
  check("a 201-character subject is refused", await rejects(() => editDraftForUser(USER, cyMsg.id, { subject: "s".repeat(201), body: "ok" })));
  check("a refused edit changes nothing", (await stepZero(cy))?.body === "x".repeat(5000));
  await setMessage(cyMsg.id, { status: "sent", body: "ORIGINAL" });
  check("edit refused after send", await rejects(() => editDraftForUser(USER, cyMsg.id, { subject: null, body: "x" }), "This message was already sent, so it can’t be edited"));
  check("…and the message is untouched", (await stepZero(cy))?.body === "ORIGINAL");

  console.log("tenancy");
  const found = await requireMessageForUser(USER, cyMsg.id);
  check("requireMessageForUser returns the message, person and campaign", found.message.id === cyMsg.id && found.prospect.id === cy && found.campaign.id === camp);
  check("another tenant's message is not found", await rejects(() => requireMessageForUser(USER, otherMessageId), "Message not found"));
  check("…so it can't be edited either", await rejects(() => editDraftForUser(USER, otherMessageId, { subject: null, body: "hijack" }), "Message not found"));
  check("a malformed id is not found", await rejects(() => requireMessageForUser(USER, "nope"), "Message not found"));
  check("another tenant's campaign is refused", await rejects(() => draftCampaignMessagesForUser(USER, otherCamp, [ana], { drafter }), "isn’t yours"));
  check("their message stayed theirs", (await db.query.outreachMessages.findFirst({ where: eq(schema.outreachMessages.id, otherMessageId) }))?.body === "THEIRS");
}

async function main() {
  const db = await getDb();
  await reset();
  try {
    promptSection();
    const [camp] = await db
      .insert(schema.outreachCampaigns)
      .values({ userId: USER, name: "Pharma consulting", messageIntent: "Ask about consulting", tone: "friendly", defaultChannel: "email" })
      .returning();
    const [liCamp] = await db
      .insert(schema.outreachCampaigns)
      .values({ userId: USER, name: "LinkedIn", messageIntent: "Ask about consulting", defaultChannel: "linkedin" })
      .returning();
    const [otherCamp] = await db.insert(schema.outreachCampaigns).values({ userId: OTHER, name: "Theirs" }).returning();
    const [theirs] = await db
      .insert(schema.outreachProspects)
      .values({ campaignId: otherCamp!.id, externalId: "x", fullName: "Zed Other", company: "ZS", status: "selected" })
      .returning();
    const [theirMessage] = await db
      .insert(schema.outreachMessages)
      .values({ prospectId: theirs!.id, channel: "email", body: "THEIRS", status: "draft" })
      .returning();
    await draftSection(camp!.id, liCamp!.id, otherCamp!.id, theirMessage!.id);
  } finally {
    await reset();
  }
  if (failures) throw new Error(`${failures} check(s) failed`);
  console.log("\nAll outreach-draft checks passed.");
}

run(main);
