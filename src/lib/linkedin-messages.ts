import Papa from "papaparse";
import type { Contact } from "@/db/schema";
import {
  buildDuplicateIndex,
  findDuplicateCandidatesIndexed,
  linkedinSlug,
} from "@/lib/duplicates";
import { csvGet } from "@/lib/linkedin-connections";

export type LinkedInMessageRow = {
  conversationId: string;
  conversationTitle: string;
  from: string;
  senderProfileUrl: string;
  to: string;
  recipientProfileUrls: string[];
  date: string;
  subject: string;
  content: string;
};

export type ParsedLinkedInMessage = LinkedInMessageRow & {
  parsedDate: Date | null;
};

/** Keep only real LinkedIn profile URLs (linkedin.com/in/…). */
export function extractProfileUrls(raw: string): string[] {
  if (!raw.trim()) return [];
  const matches = raw.match(/https?:\/\/(?:www\.)?linkedin\.com\/in\/[^\s,;"'<>]+/gi);
  if (matches?.length) {
    return [
      ...new Set(
        matches.map((u) => u.replace(/[.,;)"']+$/g, "").replace(/\/$/, ""))
      ),
    ];
  }
  // Fallback: split on commas/semicolons if LinkedIn omitted the scheme oddly
  return [
    ...new Set(
      raw
        .split(/[,;]+/)
        .map((s) => s.trim())
        .filter((u) => /linkedin\.com\/in\//i.test(u))
    ),
  ];
}

export function isLikelyPersonName(name: string): boolean {
  const t = name.trim();
  if (!t || t.length < 2 || t.length > 60) return false;
  if (/https?:\/\//i.test(t)) return false;
  if (
    /\b(linkedin|offer|job alert|newsletter|invitation|hiring|recruiter|talent|team|group|event|message|inmail|notification|sponsored)\b/i.test(
      t
    )
  ) {
    return false;
  }
  // Multi-person titles like "Jane, Alex, Sam"
  if (/,/.test(t)) return false;
  if (/\sand\s/i.test(t)) return false;

  const words = t.split(/\s+/).filter(Boolean);
  if (words.length < 1 || words.length > 4) return false;
  return words.every((w) => /^[\p{L}'’.-]+$/u.test(w));
}

export function nameFromLinkedInSlug(url: string): string {
  const slug = linkedinSlug(url);
  if (!slug) return "LinkedIn contact";
  return slug
    .split("-")
    .filter((p) => p && !/^\d+$/.test(p))
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join(" ");
}

export function mapLinkedInMessageRow(
  row: Record<string, string>
): LinkedInMessageRow {
  const senderProfileUrl =
    extractProfileUrls(
      csvGet(
        row,
        "SENDER PROFILE URL",
        "Sender Profile URL",
        "sender_profile_url",
        "FROM PROFILE URL"
      )
    )[0] || "";

  const recipientProfileUrls = extractProfileUrls(
    csvGet(
      row,
      "RECIPIENT PROFILE URLS",
      "Recipient Profile URLs",
      "recipient_profile_urls",
      "RECIPIENT PROFILE URL",
      "TO PROFILE URL"
    )
  );

  return {
    conversationId: csvGet(
      row,
      "CONVERSATION ID",
      "Conversation ID",
      "conversation_id",
      "Thread ID"
    ),
    conversationTitle: csvGet(
      row,
      "CONVERSATION TITLE",
      "Conversation Title",
      "conversation_title"
    ),
    from: csvGet(row, "FROM", "From", "Sender", "Sender Name"),
    senderProfileUrl,
    to: csvGet(row, "TO", "To", "Recipient", "Recipients"),
    recipientProfileUrls,
    date: csvGet(row, "DATE", "Date", "Sent At", "Timestamp"),
    subject: csvGet(row, "SUBJECT", "Subject"),
    content: csvGet(row, "CONTENT", "Content", "Message", "Body", "Text"),
  };
}

export function parseLinkedInMessageDate(raw: string): Date | null {
  if (!raw.trim()) return null;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;
  const normalized = raw.replace(" UTC", "Z").replace(" ", "T");
  const d2 = new Date(normalized);
  return Number.isNaN(d2.getTime()) ? null : d2;
}

export function parseLinkedInMessagesCsv(csvText: string): {
  columns: string[];
  messages: ParsedLinkedInMessage[];
} {
  let text = csvText;
  const lines = csvText.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) =>
    /conversation\s*id/i.test(line) && /sender\s*profile\s*url/i.test(line)
  );
  if (headerIdx > 0) {
    text = lines.slice(headerIdx).join("\n");
  }

  const parsed = Papa.parse<Record<string, string>>(text, {
    header: true,
    skipEmptyLines: true,
  });

  if (parsed.errors.length && !parsed.data.length) {
    throw new Error(parsed.errors[0]?.message || "Failed to parse messages CSV");
  }

  const messages = parsed.data
    .map(mapLinkedInMessageRow)
    // Require a conversation id and some identity signal — not subject/content alone
    .filter(
      (m) =>
        m.conversationId &&
        (m.senderProfileUrl ||
          m.recipientProfileUrls.length > 0 ||
          m.content ||
          m.from)
    )
    .map((m) => ({
      ...m,
      parsedDate: parseLinkedInMessageDate(m.date),
    }));

  return {
    columns: parsed.meta.fields || [],
    messages,
  };
}

export type ConversationResolution = {
  conversationId: string;
  conversationTitle: string;
  messageCount: number;
  latestDate: Date | null;
  /** Non-self LinkedIn profile URLs in this thread */
  participantUrls: string[];
  participantNames: string[];
  /** Primary person for this conversation (1:1 counterpart or most active other) */
  primaryUrl: string | null;
  primaryName: string | null;
  match:
    | {
        contactId: string;
        fullName: string;
        reason: string;
        confidence: number;
      }
    | null;
  sampleContent: string;
  skippedReason?: string;
};

function allProfileUrlsInMessage(m: ParsedLinkedInMessage): string[] {
  const urls = [
    ...(m.senderProfileUrl ? [m.senderProfileUrl] : []),
    ...m.recipientProfileUrls,
  ];
  return [
    ...new Set(urls.filter((u) => linkedinSlug(u))),
  ];
}

export type SelfIdentity = {
  /** Best guess at the account owner's profile URL, or "" if none could be formed. */
  url: string;
  slug: string;
  /**
   * Whether the guess is trustworthy enough to label messages with.
   *
   * Participant selection can live with a wrong guess — it picks a slightly worse
   * counterpart. Direction cannot: mistaking the owner for the other person inverts "you
   * said" and "they said" for every message in the export. So when the file cannot identify
   * an owner, `messageDirection` returns null and the whole import stays undirected rather
   * than confidently backwards.
   */
  confident: boolean;
};

/**
 * Who owns this export.
 *
 * Ranked by how many distinct CONVERSATIONS a profile appears in, not how many messages.
 * The owner is a participant in every conversation by definition, while any one counterpart
 * appears in only their own — so conversation count separates them cleanly where message
 * count does not.
 *
 * Message count was the original heuristic and is provably wrong on a common shape: in a 1:1
 * thread, every message names both the sender and the recipient, so both sides score exactly
 * the same. The counts tie, `>` never fires for the runner-up, and the winner is whichever
 * slug the Map saw first — i.e. whoever happened to message first. An export dominated by
 * one thread inverted every message in it. Message count is kept only as a tiebreak.
 */
export function resolveSelfIdentity(
  messages: ParsedLinkedInMessage[],
  explicit?: string | null
): SelfIdentity {
  const explicitSlug = explicit ? linkedinSlug(explicit) : "";
  // The user told us who they are in settings. Nothing in a CSV beats that.
  if (explicit && explicitSlug) {
    return { url: explicit, slug: explicitSlug, confident: true };
  }

  const conversations = new Map<string, Set<string>>();
  const messageCounts = new Map<string, number>();
  const allConversations = new Set<string>();

  for (const m of messages) {
    if (m.conversationId) allConversations.add(m.conversationId);
    for (const url of allProfileUrlsInMessage(m)) {
      const slug = linkedinSlug(url);
      if (!slug) continue;
      messageCounts.set(slug, (messageCounts.get(slug) || 0) + 1);
      if (!m.conversationId) continue;
      let seen = conversations.get(slug);
      if (!seen) {
        seen = new Set<string>();
        conversations.set(slug, seen);
      }
      seen.add(m.conversationId);
    }
  }

  const ranked = [...messageCounts.keys()]
    .map((slug) => ({
      slug,
      threads: conversations.get(slug)?.size ?? 0,
      messages: messageCounts.get(slug) || 0,
    }))
    .sort((a, b) => b.threads - a.threads || b.messages - a.messages);

  const best = ranked[0];
  if (!best) return { url: "", slug: "", confident: false };

  const runnerUp = ranked[1];
  const totalThreads = allConversations.size;
  const confident =
    // A single-conversation export genuinely cannot say which side owns it.
    totalThreads >= 2 &&
    best.threads >= 2 &&
    // A clear winner, not a coin flip between two people who look alike.
    (!runnerUp || best.threads > runnerUp.threads) &&
    // And an owner should turn up across the file, not in one corner of it.
    best.threads * 3 >= totalThreads;

  // Prefer a canonical URL as it appears in the file over a synthesised one.
  for (const m of messages) {
    for (const url of allProfileUrlsInMessage(m)) {
      if (linkedinSlug(url) === best.slug) {
        return { url, slug: best.slug, confident };
      }
    }
  }
  return {
    url: `https://www.linkedin.com/in/${best.slug}`,
    slug: best.slug,
    confident,
  };
}

/**
 * The account owner's profile URL, or "" if none could be formed.
 *
 * Thin wrapper kept for the participant-resolution callers, which want a URL and have no use
 * for the confidence flag. Anything labelling messages must use `resolveSelfIdentity`.
 */
export function inferSelfLinkedInUrl(
  messages: ParsedLinkedInMessage[],
  explicit?: string | null
): string {
  return resolveSelfIdentity(messages, explicit).url;
}

/**
 * Who sent one message: `"out"` from the account owner, `"in"` from the other party.
 *
 * Returns null — never a guess — when the sender cannot be established: no self identity, an
 * unconfident one, or a row whose SENDER PROFILE URL is blank, which real exports do produce.
 * Null flows through to `interactions.direction` and readers treat it as "unknown", which is
 * the honest answer and a distinct case from a one-sided thread.
 */
export function messageDirection(
  m: ParsedLinkedInMessage,
  self: SelfIdentity
): "in" | "out" | null {
  if (!self.confident || !self.slug) return null;
  const senderSlug = linkedinSlug(m.senderProfileUrl);
  if (!senderSlug) return null;
  return senderSlug === self.slug ? "out" : "in";
}

function buildUrlNameMap(messages: ParsedLinkedInMessage[]) {
  const map = new Map<string, string>();

  for (const m of messages) {
    const senderSlug = linkedinSlug(m.senderProfileUrl);
    if (senderSlug && isLikelyPersonName(m.from)) {
      if (!map.has(senderSlug)) map.set(senderSlug, m.from.trim());
    }

    // If TO lists a single likely name and there is exactly one recipient URL
    if (
      m.recipientProfileUrls.length === 1 &&
      isLikelyPersonName(m.to)
    ) {
      const slug = linkedinSlug(m.recipientProfileUrls[0]);
      if (slug && !map.has(slug)) map.set(slug, m.to.trim());
    }
  }

  return map;
}

function resolveNameForUrl(
  url: string,
  urlNames: Map<string, string>,
  conversationTitle: string,
  counterpartCount: number
): string {
  const slug = linkedinSlug(url);
  const known = slug ? urlNames.get(slug) : undefined;
  if (known) return known;

  // Only trust conversation title as a name for true 1:1 threads
  if (counterpartCount === 1 && isLikelyPersonName(conversationTitle)) {
    return conversationTitle.trim();
  }

  return nameFromLinkedInSlug(url);
}

export function resolveConversations(
  messages: ParsedLinkedInMessage[],
  existing: Contact[],
  selfLinkedInUrl?: string | null
): ConversationResolution[] {
  const selfUrl = inferSelfLinkedInUrl(messages, selfLinkedInUrl);
  const selfSlug = linkedinSlug(selfUrl);
  const urlNames = buildUrlNameMap(messages);
  const byConv = new Map<string, ParsedLinkedInMessage[]>();

  for (const m of messages) {
    if (!m.conversationId) continue;
    const list = byConv.get(m.conversationId) || [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }

  const resolutions: ConversationResolution[] = [];

  // Built once for the whole export, not once per conversation: the two probes below run
  // inside the loop, so a linear scan here made this O(conversations x contacts) with a
  // Levenshtein in the inner loop — ~9s for 2,000 conversations against 3,000 contacts.
  const duplicateIndex = buildDuplicateIndex(existing);

  for (const [conversationId, msgs] of byConv) {
    const urlSet = new Set<string>();
    for (const m of msgs) {
      for (const url of allProfileUrlsInMessage(m)) {
        const slug = linkedinSlug(url);
        if (!slug) continue;
        if (selfSlug && slug === selfSlug) continue;
        urlSet.add(url);
      }
    }

    // Dedupe by slug (keep first URL form)
    const bySlug = new Map<string, string>();
    for (const url of urlSet) {
      const slug = linkedinSlug(url);
      if (slug && !bySlug.has(slug)) bySlug.set(slug, url);
    }
    const counterpartUrls = [...bySlug.values()];

    const conversationTitle = msgs[0]?.conversationTitle || "";
    const dated = msgs
      .map((m) => m.parsedDate)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime());
    const withContent = msgs.find((m) => m.content)?.content || "";

    if (counterpartUrls.length === 0) {
      // System / LinkedIn notifications without another /in/ profile — skip
      resolutions.push({
        conversationId,
        conversationTitle,
        messageCount: msgs.length,
        latestDate: dated[0] || null,
        participantUrls: [],
        participantNames: [],
        primaryUrl: null,
        primaryName: null,
        match: null,
        sampleContent: withContent.slice(0, 160),
        skippedReason: "No other LinkedIn profile in this thread",
      });
      continue;
    }

    // Prefer the other person who sent the most messages in this thread
    const sendCounts = new Map<string, number>();
    for (const m of msgs) {
      const slug = linkedinSlug(m.senderProfileUrl);
      if (!slug || slug === selfSlug) continue;
      sendCounts.set(slug, (sendCounts.get(slug) || 0) + 1);
    }
    let primaryUrl = counterpartUrls[0];
    let bestSend = -1;
    for (const url of counterpartUrls) {
      const slug = linkedinSlug(url);
      const n = slug ? sendCounts.get(slug) || 0 : 0;
      if (n > bestSend) {
        bestSend = n;
        primaryUrl = url;
      }
    }

    const participantNames = counterpartUrls.map((url) =>
      resolveNameForUrl(url, urlNames, conversationTitle, counterpartUrls.length)
    );
    const primaryName = resolveNameForUrl(
      primaryUrl,
      urlNames,
      conversationTitle,
      counterpartUrls.length
    );

    let match: ConversationResolution["match"] = null;
    const urlDup = findDuplicateCandidatesIndexed(duplicateIndex, {
      linkedinUrl: primaryUrl,
    });
    if (urlDup[0] && urlDup[0].confidence >= 0.9) {
      match = {
        contactId: urlDup[0].contact.id,
        fullName: urlDup[0].contact.fullName,
        reason: urlDup[0].reason,
        confidence: urlDup[0].confidence,
      };
    } else if (isLikelyPersonName(primaryName)) {
      const nameDup = findDuplicateCandidatesIndexed(duplicateIndex, {
        fullName: primaryName,
      });
      if (nameDup[0] && nameDup[0].confidence >= 0.85) {
        match = {
          contactId: nameDup[0].contact.id,
          fullName: nameDup[0].contact.fullName,
          reason: nameDup[0].reason,
          confidence: nameDup[0].confidence,
        };
      }
    }

    resolutions.push({
      conversationId,
      conversationTitle,
      messageCount: msgs.length,
      latestDate: dated[0] || null,
      participantUrls: counterpartUrls,
      participantNames,
      primaryUrl,
      primaryName,
      match,
      sampleContent: withContent.slice(0, 160),
    });
  }

  return resolutions
    .filter((r) => r.primaryUrl)
    .sort(
      (a, b) => (b.latestDate?.getTime() || 0) - (a.latestDate?.getTime() || 0)
    );
}

export function participantIdentity(resolution: ConversationResolution): {
  fullName: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
} | null {
  if (!resolution.primaryUrl) return null;

  const fullName =
    resolution.primaryName ||
    resolution.match?.fullName ||
    nameFromLinkedInSlug(resolution.primaryUrl);

  if (!isLikelyPersonName(fullName) && !resolution.primaryUrl) {
    return null;
  }

  const parts = fullName.split(/\s+/);
  return {
    fullName,
    linkedinUrl: resolution.primaryUrl,
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
  };
}
