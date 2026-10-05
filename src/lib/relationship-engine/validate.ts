/**
 * Turns a model answer into claims the engine can act on. Three rules, all from capture:
 *
 *  1. Every excerpt must be found, verbatim, in ONE message of the window. That message is
 *     the item's provenance: its date anchors relative phrases and its id becomes the
 *     reminder's source interaction.
 *  2. Dates go through capture's `validateCommitments` with BOTH `today` and `anchor` set to
 *     the message's date. `today` there decides the year of "March 5" and rejects dates in
 *     the past; for a message from 2024 the right "today" is that day, not this one. Whether
 *     the date is still ahead of the real today is rules.ts's question, not this file's.
 *  3. Implied items need IMPLIED_MIN_CONFIDENCE.
 */
import { validateCommitments, type RawCommitmentItem } from "@/lib/date-commitment-extract";
import { IMPLIED_MIN_CONFIDENCE } from "@/lib/implied-next-steps";
import { normalizeForMatch } from "@/lib/verbatim";
import type { RelationshipDigestAnswer } from "@/lib/relationship-engine/extract";
import type { MessageWindow, ValidatedDigest, WindowMessage } from "@/lib/relationship-engine/types";

export function locateExcerpt(window: MessageWindow, excerpt: string): WindowMessage | null {
  const needle = normalizeForMatch(excerpt);
  if (!needle) return null;
  // Newest first: a phrase repeated across messages is attributed to its latest use.
  for (let i = window.messages.length - 1; i >= 0; i--) {
    if (normalizeForMatch(window.messages[i].text).includes(needle)) return window.messages[i];
  }
  return null;
}

export function validateDigest(
  answer: RelationshipDigestAnswer,
  window: MessageWindow,
  openKeys: Set<string>
): ValidatedDigest {
  const facts = answer.facts.filter((f) => locateExcerpt(window, f.excerpt)).map((f) => f.text.trim());

  const dated: ValidatedDigest["dated"] = [];
  const undated: ValidatedDigest["undated"] = [];
  for (const c of answer.commitments) {
    const msg = locateExcerpt(window, c.excerpt);
    if (!msg) continue;
    if (c.raw_date_phrase) {
      const raw: RawCommitmentItem = {
        title: c.title,
        detail: null,
        raw_date_phrase: c.raw_date_phrase,
        date: c.date,
        date_kind: c.date_kind,
        year_stated: c.year_stated,
        person_name: null,
        kind: c.kind,
        confidence: c.confidence,
        source_excerpt: c.excerpt,
      };
      const { commitments } = validateCommitments([raw], msg.text, { today: msg.at, anchor: msg.at });
      const ok = commitments[0];
      if (ok) {
        dated.push({
          text: ok.title,
          owedBy: c.owed_by,
          dueDate: ok.dueDate,
          rawDatePhrase: ok.rawDatePhrase,
          dateBasis: ok.dateBasis,
          actionKind: ok.actionKind,
          confidence: ok.confidenceScore,
          excerpt: c.excerpt,
          messageAt: msg.at,
          interactionId: msg.interactionId,
        });
        continue;
      }
      // A date that will not resolve still leaves a real commitment: keep it undated.
    }
    undated.push({
      text: c.title.trim(),
      owedBy: c.owed_by,
      origin: "explicit",
      confidence: Math.round(c.confidence * 100),
      excerpt: c.excerpt,
      messageAt: msg.at,
      interactionId: msg.interactionId,
      withinDays: null,
    });
  }

  for (const i of answer.implied) {
    if (i.confidence < IMPLIED_MIN_CONFIDENCE) continue;
    const msg = locateExcerpt(window, i.excerpt);
    if (!msg) continue;
    undated.push({
      text: i.text.trim(),
      owedBy: i.owed_by,
      origin: "implied",
      confidence: Math.round(i.confidence * 100),
      excerpt: i.excerpt,
      messageAt: msg.at,
      interactionId: msg.interactionId,
      withinDays: i.within_days != null && i.within_days >= 1 && i.within_days <= 365 ? i.within_days : null,
    });
  }

  const closedKeys = [...new Set(answer.closed.map((c) => c.key))].filter(
    (k) => openKeys.has(k) && answer.closed.some((c) => c.key === k && locateExcerpt(window, c.excerpt))
  );

  let jobChange: ValidatedDigest["jobChange"] = null;
  if (answer.job_change) {
    const msg = locateExcerpt(window, answer.job_change.excerpt);
    if (msg && msg.direction === "in") {
      jobChange = { company: answer.job_change.company.trim(), title: answer.job_change.title, messageAt: msg.at };
    }
  }

  return {
    whatTheyDo: answer.what_they_do,
    workingOn: answer.working_on,
    summary: answer.summary,
    topics: answer.topics,
    facts,
    dated,
    undated,
    closedKeys,
    jobChange,
  };
}
