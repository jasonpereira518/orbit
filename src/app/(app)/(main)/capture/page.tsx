import { headers } from "next/headers";
import { userAgentFromString } from "next/server";
import { getContact } from "@/actions/contacts";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { CaptureFormLazy } from "@/components/capture/capture-form-lazy";
import { UnresolvedMentionsCard } from "@/components/capture/unresolved-mentions-card";

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string }>;
}) {
  const params = await searchParams;
  const requestedContactId = params.contactId || null;
  const modeParam =
    params.mode === "structured" ||
    params.mode === "messy" ||
    params.mode === "voice"
      ? params.mode
      : null;

  const settingsPromise = getSettings();
  const planPromise = getPlanOverview();

  let contactId: string | null = null;
  let contactName: string | null = null;
  if (requestedContactId) {
    const contact = await getContact(requestedContactId);
    if (contact) {
      contactId = contact.id;
      contactName = contact.preferredName || contact.fullName;
    }
  }

  // On a phone, voice is the way in no matter which door you came through — you are
  // rarely at a keyboard when you have just met someone. Decided from the user agent on
  // the server rather than a media query on the client, so the first paint is already
  // the right tab instead of Messy Notes flicking over to Voice.
  const isPhone =
    userAgentFromString((await headers()).get("user-agent") ?? undefined).device
      .type === "mobile";

  const settings = await settingsPromise;
  const { usage } = await planPromise;
  const defaultMode =
    modeParam || (isPhone ? "voice" : contactId ? "structured" : "messy");

  return (
    // A flex column rather than stacked spacing so the notices can drop below the form
    // on a phone, where the mic has to be the first thing on screen.
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-6">
      {/* The phone's app header already names the app, and every row of heading here is a
          row the mic sits lower. */}
      <div className="hidden sm:block">
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Capture
        </h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
            : "Paste notes about one person or many, review each profile, then save."}
        </p>
      </div>
      {/* Only on the general capture page: when you arrived to log an interaction with one
          named person, a list of other people is a distraction from the thing you came for. */}
      {!contactId && (
        <div className="empty:hidden max-sm:order-last">
          <UnresolvedMentionsCard />
        </div>
      )}
      {/* Capture creates contacts, so the same cap applies. Logging an interaction with
          an existing contact is never blocked — only creating new people is. */}
      {!contactId && (
        <div className="empty:hidden max-sm:order-last">
          <ContactQuotaNotice used={usage.used} limit={usage.limit} />
        </div>
      )}
      <CaptureFormLazy
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
        hasApiKey={settings.hasApiKey}
      />
    </div>
  );
}
