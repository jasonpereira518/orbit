/**
 * What survives the Google connect round trip.
 *
 * Connecting Gmail is a full-page redirect, so it drops everything on the page — including a
 * draft the person had already edited. Before redirecting, the send dialog stashes what they
 * were about to send; when they come back to `/chat?thread=<id>` the card for that message
 * takes it back. `sessionStorage`, not `localStorage`: it is one tab's errand, it should not
 * outlive the tab, and it holds message text.
 *
 * Every access is wrapped: storage can be blocked, full or absent (private windows, embedded
 * views), and the worst that may happen is that the draft comes back unedited.
 */

const KEY = "orbit:chat-send-resume";

export type SendResume = {
  threadId: string | null;
  messageId: string;
  contactId: string;
  body: string;
  subject: string;
};

export function stashSendResume(resume: SendResume): void {
  try {
    window.sessionStorage.setItem(KEY, JSON.stringify(resume));
  } catch {
    // Not stored: the draft returns as the model wrote it.
  }
}

function read(): SendResume | null {
  try {
    const raw = window.sessionStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SendResume>;
    if (
      typeof parsed.messageId !== "string" ||
      typeof parsed.contactId !== "string" ||
      typeof parsed.body !== "string" ||
      typeof parsed.subject !== "string"
    ) {
      return null;
    }
    return {
      threadId: typeof parsed.threadId === "string" ? parsed.threadId : null,
      messageId: parsed.messageId,
      contactId: parsed.contactId,
      body: parsed.body,
      subject: parsed.subject,
    };
  } catch {
    return null;
  }
}

/**
 * The stash, if it is for this message and this person. Read-only: a render must not remove
 * what a second render (StrictMode, a remount) still needs, so clearing is `clearSendResume`,
 * called from an effect once the card has taken it.
 */
export function peekSendResumeFor(messageId: string, contactId: string): SendResume | null {
  const found = read();
  return found && found.messageId === messageId && found.contactId === contactId ? found : null;
}

export function clearSendResume(): void {
  try {
    window.sessionStorage.removeItem(KEY);
  } catch {
    // A stale stash is harmless: it only ever matches the same message and person.
  }
}
