import { and, asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { getDb } from "@/db";
import { contactBriefs, contactOpportunities, contacts, interactions, reminders } from "@/db/schema";
import { completeJson, getAiConfig } from "@/lib/ai";
import { formatHowMetSummary, metContextLabel } from "@/lib/met-context";
import { rebuildContactEmbedding } from "@/lib/search";
import { listOpenActionItems } from "@/lib/action-items";
import { OPEN_OPPORTUNITY_STATUSES, opportunityKindLabel } from "@/lib/opportunity-kinds";
import { isoDay } from "@/lib/suggested-reminder-utils";
import { reportUnlessQuiet } from "@/lib/report-error";

/** Never reject a good summary over an overlong standing paragraph — truncate instead. */
export function clampStanding(s: string) {
  return s.trim().slice(0, 600);
}

const contactBriefSchema = z.object({
  summary: z.string().min(1),
  standing: z.string().min(1).transform(clampStanding),
  /**
   * Optional and nullable on purpose. "Nothing is open" is a real and common answer, and a
   * required field would push the model into inventing a next step to fill it — which is
   * exactly the generic "stay in touch" noise this was added to replace.
   */
  next_step: z
    .string()
    .nullish()
    .transform((v) => {
      const t = v?.replace(/\s+/g, " ").trim();
      return t ? t.slice(0, 160) : null;
    }),
});

/** How many open items of each kind reach the prompt. Enough to choose from, not a list. */
const OPEN_ITEM_LIMIT = 8;

export type ContactBrief = typeof contactBriefs.$inferSelect;

export type RecentDiscussion = {
  interactionId: string;
  dateIso: string;
  line: string;
};
export const RECENT_DISCUSSIONS_LIMIT = 5;

function firstSentence(text: string) {
  const line = text.split(/\n/)[0]?.trim() || text.trim();
  const m = line.match(/^(.+?[.!?])(\s|$)/);
  const s = (m ? m[1] : line).trim();
  return s.length > 120 ? `${s.slice(0, 117)}…` : s;
}

export function buildRecentDiscussions(
  rows: {
    id: string;
    interactionDate: Date | string;
    interactionType: string;
    aiSummary: string | null;
    rawNotes: string | null;
  }[]
): RecentDiscussion[] {
  return [...rows]
    .sort(
      (a, b) =>
        new Date(b.interactionDate).getTime() -
        new Date(a.interactionDate).getTime()
    )
    .map((r) => {
      const text = (r.aiSummary || r.rawNotes || "").trim();
      if (!text) return null;
      return {
        interactionId: r.id,
        dateIso: isoDay(new Date(r.interactionDate)),
        line: firstSentence(text),
      };
    })
    .filter((x): x is RecentDiscussion => x !== null)
    .slice(0, RECENT_DISCUSSIONS_LIMIT);
}

export function isBriefStale(
  brief: { generatedAt: Date | string } | null,
  lastInteractionAt: Date | string | null
) {
  if (!brief) return true;
  if (!lastInteractionAt) return false;
  return (
    new Date(brief.generatedAt).getTime() <
    new Date(lastInteractionAt).getTime()
  );
}

export async function getContactBrief(
  userId: string,
  contactId: string
): Promise<ContactBrief | null> {
  const db = await getDb();
  return (
    (await db.query.contactBriefs.findFirst({
      where: and(
        eq(contactBriefs.contactId, contactId),
        eq(contactBriefs.userId, userId)
      ),
    })) ?? null
  );
}

/**
 * Trim to a word boundary and mark the cut.
 *
 * A hard `slice` ended snippets mid-word: a real profile read "...to ping her after
 * their pl; ... she thinks most teams over-pro." — which looks like corrupted data
 * rather than an abridged note. This is the summary Orbit falls back to whenever the AI
 * provider is missing or failing, so it is exactly what is on screen if a key runs out
 * mid-demo. Falls back to a hard cut only when a single word is longer than the budget.
 */
function clip(text: string, max: number) {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  const cut = trimmed.slice(0, max);
  const lastSpace = cut.lastIndexOf(" ");
  const body = lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut;
  return `${body.replace(/[\s,;:.\u2013\u2014-]+$/, "")}\u2026`;
}

function buildDeterministicSummary(input: {
  fullName: string;
  preferredName?: string | null;
  title?: string | null;
  company?: string | null;
  metContext?: string | null;
  dateMet?: Date | string | null;
  howMet?: string | null;
  notes?: string | null;
  interactionSnippets: string[];
}) {
  const name = input.preferredName?.trim() || input.fullName;
  const roleBits = [input.title, input.company].filter(Boolean).join(" at ");
  const met = formatHowMetSummary({
    metContext: input.metContext,
    dateMet: input.dateMet,
    howMet: input.howMet,
  });

  const parts: string[] = [];
  parts.push(
    roleBits
      ? `${name} is ${roleBits}.`
      : `${name} is in your orbit.`
  );
  if (met) {
    // `formatHowMetSummary` joins context, date and details with "·" for the profile
    // card's label. Dropping that into prose produced "You met through Jul 3, 2026 ·
    // AWS Summit — hallway track…", so it is introduced as a label here too.
    parts.push(`How you met: ${met}.`);
  } else if (metContextLabel(input.metContext)) {
    parts.push(`You connected via ${metContextLabel(input.metContext)}.`);
  }
  if (input.notes?.trim()) {
    parts.push(clip(input.notes, 280));
  }
  if (input.interactionSnippets.length > 0) {
    const covered = input.interactionSnippets.slice(0, 3).join("; ");
    // No trailing period when the last snippet was clipped — "over-pro….' reads worse
    // than either mark on its own.
    parts.push(
      `Recent conversations covered: ${covered}${covered.endsWith("\u2026") ? "" : "."}`
    );
  }
  return clip(parts.join(" "), 1200);
}

/**
 * Builds (or rebuilds) a person-level AI brief covering who they are, how you met,
 * what you've talked about, and where things currently stand. Persists to
 * `contacts.ai_summary` (the narrative summary) and `contact_briefs` (summary +
 * standing + deterministic recent discussions).
 */
export async function generateAndStoreContactBrief(
  userId: string,
  contactId: string,
  options?: { force?: boolean }
): Promise<{ summary: string | null; standing: string | null; nextStep?: string | null } | null> {
  const db = await getDb();
  const contact = await db.query.contacts.findFirst({
    where: and(eq(contacts.id, contactId), eq(contacts.userId, userId)),
    with: { contactTags: { with: { tag: true } } },
  });
  if (!contact) return null;

  const recent = await db.query.interactions.findMany({
    where: and(
      eq(interactions.userId, userId),
      eq(interactions.contactId, contactId)
    ),
    orderBy: [desc(interactions.interactionDate)],
    limit: 20,
  });

  // What the brief could never see before: the things this relationship actually owes.
  // Loaded in parallel and each guarded, because a brief that fails because one side query
  // failed is strictly worse than a brief written without that side.
  const [openOpportunities, pendingReminders, openItems] = await Promise.all([
    db
      .select({
        kind: contactOpportunities.kind,
        label: contactOpportunities.label,
        dueDate: contactOpportunities.dueDate,
        sourceExcerpt: contactOpportunities.sourceExcerpt,
      })
      .from(contactOpportunities)
      .where(
        and(
          eq(contactOpportunities.userId, userId),
          eq(contactOpportunities.contactId, contactId),
          inArray(contactOpportunities.status, [...OPEN_OPPORTUNITY_STATUSES])
        )
      )
      .orderBy(asc(contactOpportunities.dueDate))
      .limit(OPEN_ITEM_LIMIT)
      .catch(() => []),
    db
      .select({ title: reminders.title, dueDate: reminders.dueDate })
      .from(reminders)
      .where(
        and(
          eq(reminders.userId, userId),
          eq(reminders.contactId, contactId),
          eq(reminders.status, "pending")
        )
      )
      .orderBy(asc(reminders.dueDate))
      .limit(OPEN_ITEM_LIMIT)
      .catch(() => []),
    listOpenActionItems(userId, contactId).catch(() => []),
  ]);

  const opportunityLines = openOpportunities.map((o) =>
    [
      `- [${opportunityKindLabel(o.kind)}] ${o.label}`,
      o.dueDate ? ` — due ${isoDay(new Date(o.dueDate))}` : "",
      o.sourceExcerpt ? ` — "${o.sourceExcerpt.slice(0, 160)}"` : "",
    ].join("")
  );
  const commitmentLines = [
    ...pendingReminders.map(
      (r) => `- ${r.dueDate ? `${isoDay(new Date(r.dueDate))} · ` : ""}${r.title}`
    ),
    ...openItems.slice(0, OPEN_ITEM_LIMIT).map((i) => `- ${i.text}`),
  ];

  const interactionSnippets = recent
    .map((i) => {
      const text = (i.aiSummary || i.rawNotes || "").trim();
      if (!text) return null;
      const when = i.interactionDate
        ? new Date(i.interactionDate).toISOString().slice(0, 10)
        : "?";
      return `[${when} · ${i.interactionType}] ${text.slice(0, 400)}`;
    })
    .filter(Boolean) as string[];

  const hasSignal =
    Boolean(contact.howMet?.trim()) ||
    Boolean(contact.metContext) ||
    Boolean(contact.notes?.trim()) ||
    Boolean(contact.title || contact.company) ||
    interactionSnippets.length > 0;

  if (!hasSignal && !options?.force) {
    return { summary: contact.aiSummary, standing: null };
  }

  const profileBlock = [
    `Name: ${contact.fullName}`,
    contact.preferredName ? `Preferred name: ${contact.preferredName}` : null,
    contact.title ? `Role: ${contact.title}` : null,
    contact.company ? `Company: ${contact.company}` : null,
    contact.location ? `Location: ${contact.location}` : null,
    contact.industry ? `Industry: ${contact.industry}` : null,
    formatHowMetSummary({
      metContext: contact.metContext,
      dateMet: contact.dateMet,
      howMet: contact.howMet,
    })
      ? `How you met: ${formatHowMetSummary({
          metContext: contact.metContext,
          dateMet: contact.dateMet,
          howMet: contact.howMet,
        })}`
      : null,
    contact.notes?.trim() ? `Notes: ${contact.notes.trim().slice(0, 800)}` : null,
    contact.contactTags?.length
      ? `Tags: ${contact.contactTags.map((ct) => ct.tag.name).join(", ")}`
      : null,
    contact.keyFacts?.length
      ? `Key facts: ${contact.keyFacts.join("; ")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const transcript =
    interactionSnippets.length > 0
      ? interactionSnippets.join("\n").slice(0, 12_000)
      : "(no interactions logged yet)";

  let summary: string | null = null;
  let standing: string | null = null;
  let nextStep: string | null = null;
  let model: string | null = null;

  try {
    const config = await getAiConfig(userId, "contact.brief");
    const content = await completeJson(userId, {
      operation: "contact.brief",
      temperature: 0.3,
      user: [
        `Profile:\n${profileBlock}`,
        opportunityLines.length ? `Open opportunities:\n${opportunityLines.join("\n")}` : null,
        commitmentLines.length ? `Open commitments:\n${commitmentLines.join("\n")}` : null,
        `Interactions (newest first):\n${transcript}`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      system: `You write concise relationship memory for a personal networking CRM called Orbit.
Return strict JSON: { "summary": string, "standing": string, "next_step": string|null }
summary — 2–4 sentences as before (who, how met, what discussed).
standing — 2–3 sentences on WHERE THINGS STAND RIGHT NOW: the most recent thread, anything the user owes or is waiting on, and the natural next step. Present tense, second person, under 70 words, grounded only in what you were given. If nothing is open, say so plainly.
next_step — ONE imperative clause naming the single most useful thing to do next, 12 words or fewer, no trailing period. Prefer a named open commitment or opportunity over anything generic: "Ask Maya about the infra referral" beats "stay in touch". Null when nothing is open — do not invent one to fill the field.

Write 2–4 sentences for summary that cover:
1) who this person is (role/company when known),
2) how the user met them (context, date, details),
3) what they have talked about or the relationship substance so far.

Rules:
- Use only facts supported by the profile, the open items and the interactions. Do not invent.
- Open opportunities and open commitments are things this relationship already owes or offers. They are the strongest evidence for what to do next; name one rather than reaching for a generic gesture.
- Prefer concrete topics and context over generic praise.
- Write in second person about the relationship ("You met…", "You've talked about…").
- Keep summary under 90 words.`,
    });
    const parsed = contactBriefSchema.parse(JSON.parse(content));
    summary = parsed.summary.trim();
    standing = parsed.standing;
    nextStep = parsed.next_step;
    model = config.model;
  } catch (err) {
    // The deterministic summary is a fine fallback, but a brief that silently never uses
    // the model is a fault worth seeing — unless the cause is the person's own key setup.
    reportUnlessQuiet(err, { where: "job.contact-brief", userId, extra: { contactId } });
    summary = buildDeterministicSummary({
      fullName: contact.fullName,
      preferredName: contact.preferredName,
      title: contact.title,
      company: contact.company,
      metContext: contact.metContext,
      dateMet: contact.dateMet,
      howMet: contact.howMet,
      notes: contact.notes,
      interactionSnippets: interactionSnippets.map((s) =>
        clip(s.replace(/^\[[^\]]+\]\s*/, ""), 120)
      ),
    });
    standing = summary;
    // The no-API-key path still answers "what now" — this is what is on screen when a key
    // runs out mid-demo, and a catch-up card that cannot name a next step is the thing this
    // whole change exists to fix.
    nextStep = deterministicNextStep(opportunityLines, commitmentLines);
    model = null;
  }

  if (!summary?.trim()) return { summary: contact.aiSummary, standing: null };

  await db
    .update(contacts)
    .set({
      aiSummary: summary.trim(),
      updatedAt: new Date(),
    })
    .where(and(eq(contacts.id, contactId), eq(contacts.userId, userId)));

  const recentRows = recent.map((i) => ({
    id: i.id,
    interactionDate: i.interactionDate,
    interactionType: i.interactionType,
    aiSummary: i.aiSummary,
    rawNotes: i.rawNotes,
  }));
  const recentDiscussions = buildRecentDiscussions(recentRows);
  const generatedAt = new Date();
  const basisInteractionId = recent[0]?.id ?? null;

  await db
    .insert(contactBriefs)
    .values({
      contactId,
      userId,
      standing,
      recentDiscussions,
      nextStep,
      generatedAt,
      basisInteractionId,
      model,
    })
    .onConflictDoUpdate({
      target: contactBriefs.contactId,
      set: {
        standing,
        recentDiscussions,
        nextStep,
        generatedAt,
        basisInteractionId,
        model,
      },
    });

  await rebuildContactEmbedding(userId, contactId).catch((err) => {
    reportUnlessQuiet(err, { where: "job.contact-brief.embedding", userId, extra: { contactId } });
    return null;
  });

  return { summary: summary.trim(), standing, nextStep };
}

/**
 * The next step when there is no model: the earliest dated commitment, else the first open
 * opportunity, else nothing.
 *
 * Deliberately not a sentence template — the lines already read as imperatives, and dressing
 * them up ("You should consider...") makes the fallback look like a worse model rather than
 * an honest absence of one.
 */
function deterministicNextStep(
  opportunityLines: readonly string[],
  commitmentLines: readonly string[]
): string | null {
  const first = commitmentLines[0] ?? opportunityLines[0] ?? null;
  if (!first) return null;
  return first.replace(/^-\s*/, "").replace(/\s+—\s+".*$/, "").trim().slice(0, 160) || null;
}
