import Papa from "papaparse";
import type { Contact } from "@/db/schema";
import { findDuplicateCandidates, linkedinSlug } from "@/lib/duplicates";

export type LinkedInMessageRow = {
  conversationId: string;
  conversationTitle: string;
  from: string;
  senderProfileUrl: string;
  to: string;
  date: string;
  subject: string;
  content: string;
};

export type ParsedLinkedInMessage = LinkedInMessageRow & {
  parsedDate: Date | null;
};

function csvGet(row: Record<string, string>, ...keys: string[]) {
  for (const k of keys) {
    const found = Object.entries(row).find(
      ([key]) => key.trim().toLowerCase() === k.toLowerCase()
    );
    if (found?.[1]) return found[1].trim();
  }
  return "";
}

export function mapLinkedInMessageRow(
  row: Record<string, string>
): LinkedInMessageRow {
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
      "conversation_title",
      "Title"
    ),
    from: csvGet(row, "FROM", "From", "Sender", "Sender Name"),
    senderProfileUrl: csvGet(
      row,
      "SENDER PROFILE URL",
      "Sender Profile URL",
      "sender_profile_url",
      "Profile URL",
      "FROM PROFILE URL"
    ),
    to: csvGet(row, "TO", "To", "Recipient", "Recipients"),
    date: csvGet(row, "DATE", "Date", "Sent At", "Timestamp"),
    subject: csvGet(row, "SUBJECT", "Subject"),
    content: csvGet(row, "CONTENT", "Content", "Message", "Body", "Text"),
  };
}

export function parseLinkedInMessageDate(raw: string): Date | null {
  if (!raw.trim()) return null;
  const d = new Date(raw);
  if (!Number.isNaN(d.getTime())) return d;
  // LinkedIn sometimes uses "YYYY-MM-DD HH:mm:ss UTC"
  const normalized = raw.replace(" UTC", "Z").replace(" ", "T");
  const d2 = new Date(normalized);
  return Number.isNaN(d2.getTime()) ? null : d2;
}

export function parseLinkedInMessagesCsv(csvText: string): {
  columns: string[];
  messages: ParsedLinkedInMessage[];
} {
  // LinkedIn exports sometimes include a notes header row before the real headers
  let text = csvText;
  const lines = csvText.split(/\r?\n/);
  const headerIdx = lines.findIndex((line) =>
    /conversation\s*id|sender\s*profile\s*url|content/i.test(line)
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
    .filter((m) => m.content || m.from || m.senderProfileUrl)
    .map((m) => ({
      ...m,
      parsedDate: parseLinkedInMessageDate(m.date),
      conversationId:
        m.conversationId ||
        `untitled:${m.conversationTitle || m.from || "unknown"}`,
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
  participantUrls: string[];
  participantNames: string[];
  match:
    | {
        contactId: string;
        fullName: string;
        reason: string;
        confidence: number;
      }
    | null;
  sampleContent: string;
};

function nameFromTitleOrFrom(title: string, from: string) {
  const titleName = title.trim();
  // Group chats often contain commas or "and"
  if (titleName && !/,|\sand\s/i.test(titleName) && titleName.length < 80) {
    return titleName;
  }
  return from.trim();
}

export function resolveConversations(
  messages: ParsedLinkedInMessage[],
  existing: Contact[],
  selfLinkedInUrl?: string | null
): ConversationResolution[] {
  const selfSlug = linkedinSlug(selfLinkedInUrl);
  const byConv = new Map<string, ParsedLinkedInMessage[]>();

  for (const m of messages) {
    const list = byConv.get(m.conversationId) || [];
    list.push(m);
    byConv.set(m.conversationId, list);
  }

  const resolutions: ConversationResolution[] = [];

  for (const [conversationId, msgs] of byConv) {
    const urls = [
      ...new Set(
        msgs
          .map((m) => m.senderProfileUrl)
          .filter(Boolean)
          .filter((u) => !selfSlug || linkedinSlug(u) !== selfSlug)
      ),
    ];
    const names = [
      ...new Set(
        msgs
          .map((m) => nameFromTitleOrFrom(m.conversationTitle, m.from))
          .filter(Boolean)
      ),
    ];

    let match: ConversationResolution["match"] = null;

    for (const url of urls) {
      const dups = findDuplicateCandidates(existing, { linkedinUrl: url });
      if (dups[0] && dups[0].confidence >= 0.9) {
        match = {
          contactId: dups[0].contact.id,
          fullName: dups[0].contact.fullName,
          reason: dups[0].reason,
          confidence: dups[0].confidence,
        };
        break;
      }
    }

    if (!match) {
      for (const name of names) {
        const dups = findDuplicateCandidates(existing, { fullName: name });
        if (dups[0] && dups[0].confidence >= 0.6) {
          match = {
            contactId: dups[0].contact.id,
            fullName: dups[0].contact.fullName,
            reason: dups[0].reason,
            confidence: dups[0].confidence,
          };
          break;
        }
      }
    }

    const dated = msgs
      .map((m) => m.parsedDate)
      .filter((d): d is Date => !!d)
      .sort((a, b) => b.getTime() - a.getTime());

    const withContent = msgs.find((m) => m.content)?.content || "";

    resolutions.push({
      conversationId,
      conversationTitle: msgs[0]?.conversationTitle || names[0] || "Untitled",
      messageCount: msgs.length,
      latestDate: dated[0] || null,
      participantUrls: urls,
      participantNames: names,
      match,
      sampleContent: withContent.slice(0, 160),
    });
  }

  return resolutions.sort(
    (a, b) => (b.latestDate?.getTime() || 0) - (a.latestDate?.getTime() || 0)
  );
}

export function participantIdentity(resolution: ConversationResolution): {
  fullName: string;
  linkedinUrl?: string;
  firstName?: string;
  lastName?: string;
} {
  const fullName =
    resolution.participantNames[0] ||
    resolution.conversationTitle ||
    "LinkedIn contact";
  const parts = fullName.split(/\s+/);
  return {
    fullName,
    linkedinUrl: resolution.participantUrls[0],
    firstName: parts[0],
    lastName: parts.length > 1 ? parts.slice(1).join(" ") : undefined,
  };
}
