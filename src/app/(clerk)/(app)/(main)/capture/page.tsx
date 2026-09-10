import { getContact } from "@/actions/contacts";
import { getPlanOverview, getSettings } from "@/actions/settings";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { CaptureFormLazy } from "@/components/capture/capture-form-lazy";

export default async function CapturePage({
  searchParams,
}: {
  searchParams: Promise<{ contactId?: string; mode?: string }>;
}) {
  const params = await searchParams;
  const requestedContactId = params.contactId || null;
  const modeParam =
    params.mode === "structured" || params.mode === "messy"
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

  const settings = await settingsPromise;
  const { usage } = await planPromise;
  const defaultMode = modeParam || (contactId ? "structured" : "messy");

  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Capture
        </h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — or paste notes that mention others too.`
            : "Paste notes about one person or many, review each profile, then save."}
        </p>
      </div>
      {/* Capture creates contacts, so the same cap applies. Logging an interaction with
          an existing contact is never blocked — only creating new people is. */}
      {!contactId && (
        <ContactQuotaNotice used={usage.used} limit={usage.limit} />
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
