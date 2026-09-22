/**
 * Fixture shapes for `scripts/eval-ai.ts`. Every fixture is SYNTHETIC — invented people,
 * invented companies, invented mail. Real notes never go in this repo.
 *
 * Expectations are deliberately partial: a case lists what a correct answer MUST contain
 * (and what it must NOT), never a full expected object, so a model that adds a harmless
 * extra topic or phrases a summary differently is not marked wrong.
 */

/** `scripts/eval-fixtures/ai-capture-eval.json` — runs the whole capture parse (people + dates). */
export type CaptureEvalFixture = {
  cases: Array<{
    id: string;
    /** single | multi | long | referral | messy-ocr | email | dates | mentions … (free text, for grouping). */
    kind: string;
    notes: string;
    /** The upload moment, YYYY-MM-DD. Relative dates in the notes count from this. */
    today: string;
    hints?: { eventDate?: string | null; seedPeople?: Array<{ name?: string; email?: string }> };
    expect: {
      /** People the user actually talked to — each must come back as a review card. */
      people: Array<{
        name: string;
        /** Only fields listed are scored. A value matches case-insensitively, either containing the other. */
        company?: string;
        role?: string;
        email?: string;
        /** Opportunity kinds that must appear on this person (e.g. "referral"). */
        opportunityKinds?: string[];
      }>;
      /** Named in the notes but NOT talked to: must never come back as a review card. */
      notParticipants?: string[];
      /** Stated, dated commitments that must be suggested as reminders. */
      reminders?: Array<{ dueDate: string; person?: string }>;
      /** Strings that must not appear anywhere in the result (an invented company, say). */
      forbidden?: string[];
    };
  }>;
};

/** `scripts/eval-fixtures/ai-recruiter-eval.json` — the Gmail recruiter classifier. */
export type RecruiterEvalFixture = {
  cases: Array<{
    id: string;
    /** agency | in-house | hiring-manager | ats | newsletter | colleague | sales | friend … */
    kind: string;
    senderName: string;
    senderEmail: string;
    firmGuess: string | null;
    messages: Array<{ subject: string; body: string; date: string }>;
    expect: {
      isRecruiter: boolean;
      /** When a recruiter: hiring companies that must be named. */
      companies?: string[];
      /** When a recruiter: role titles that must be named (substring match). */
      roles?: string[];
    };
  }>;
};

/** `scripts/eval-fixtures/ai-extension-eval.json` — the extension's profile-page parser. */
export type ExtensionEvalFixture = {
  cases: Array<{
    id: string;
    /** The name the page adapter already read, or null (it corroborates, not replaces). */
    identityName: string | null;
    /** Page text as the extension captures it: nav chrome, "People also viewed", posts… */
    pageText: string;
    expect: {
      fullName?: string;
      title?: string;
      company?: string;
      location?: string;
      school?: string;
      /** Fields that must come back null because the page does not state them. */
      mustBeNull?: Array<"title" | "company" | "location" | "school" | "email">;
      /** Names from page furniture that must not leak into any field. */
      forbidden?: string[];
    };
  }>;
};

/** `scripts/eval-fixtures/ai-ocr-eval.json` — photographed notes, rendered from text at run time. */
export type OcrEvalFixture = {
  cases: Array<{
    id: string;
    /** "print" renders in a plain font, "hand" in a handwriting font. */
    style: "print" | "hand";
    /** The note as written, line by line. */
    lines: string[];
    /** Names that must survive OCR exactly (case-insensitive). */
    names: string[];
  }>;
};

/** `scripts/eval-fixtures/ai-transcribe-eval.json` — spoken with macOS `say` at run time. */
export type TranscribeEvalFixture = {
  cases: Array<{
    id: string;
    script: string;
    /** Names that must be transcribed correctly (case-insensitive). */
    names: string[];
  }>;
};

/** `scripts/eval-fixtures/ai-chat-eval.json` — questions over `contact-search-eval.json`'s network. */
export type ChatEvalFixture = {
  cases: Array<{
    id: string;
    question: string;
    /** Emails (from contact-search-eval.json) of contacts the answer must name. */
    mustMention: string[];
  }>;
};

/** `scripts/eval-fixtures/ai-digest-eval.json` — meeting transcripts for the digest. */
export type DigestEvalFixture = {
  cases: Array<{
    id: string;
    title: string;
    /** The person who recorded it (the user). Never counted as an attendee. */
    userName: string;
    /** Names from the calendar invite, if any, as the recorder passes them. */
    calendarAttendees: string[];
    /**
     * One paragraph per ~1-minute recorded chunk, as the transcriber returns them: no
     * speaker labels, people identified only by what is said. Over 30,000 characters in
     * total exercises the map/reduce path.
     */
    transcript: string[];
    expect: {
      /** Participants who were present (the recorder excluded). */
      attendees: string[];
      /** Substrings: each must appear in some action item. */
      actionItems: string[];
    };
  }>;
};

export type ResearchEvalFixture = {
  cases: Array<{
    id: string;
    question: string;
    /** Earlier turns of the conversation, for follow-up cases. */
    priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
    /** What `chooseDepth` must route this to. */
    expectDepth: "single" | "research";
    /** Emails (from contact-search-eval.json) the answer must name or recommend. */
    mustMention: string[];
    /** Facts that live only in a note (passage-search-eval.json), which the answer must state. */
    mustSay: string[];
    /** Claims the notes do not support. */
    forbidden?: string[];
  }>;
};

export type ChatRoutingEvalFixture = {
  cases: Array<{
    id: string;
    question: string;
    priorTurns?: Array<{ role: "user" | "assistant"; content: string }>;
    expect: {
      depth: "single" | "research";
      attention: boolean;
      recruiters: boolean;
      /** Seeded company names whose rosters should attach. */
      roster: string[];
    };
    why?: string;
  }>;
};

/** A contact card as the duplicate and mention fixtures write one. */
export type EvalCard = {
  fullName: string;
  title?: string;
  company?: string;
  school?: string;
  location?: string;
  email?: string;
  aiSummary?: string;
};

export type DuplicatesEvalFixture = {
  pairs: Array<{ id: string; a: EvalCard; b: EvalCard; same: boolean; why?: string }>;
};

export type MentionsEvalFixture = {
  cases: Array<{
    id: string;
    sentence: string;
    mention: string;
    nearPerson?: string;
    candidates: EvalCard[];
    /** The candidate index the mention means, or "none". */
    expect: number | "none";
    why?: string;
  }>;
};

