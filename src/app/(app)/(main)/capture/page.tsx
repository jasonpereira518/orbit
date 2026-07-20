import { getContact } from "@/actions/contacts";
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

  let contactId: string | null = null;
  let contactName: string | null = null;
  if (requestedContactId) {
    const contact = await getContact(requestedContactId);
    if (contact) {
      contactId = contact.id;
      contactName = contact.preferredName || contact.fullName;
    }
  }

  const defaultMode = modeParam || (contactId ? "structured" : "messy");

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Capture
        </h1>
        <p className="mt-1 text-muted-foreground">
          {contactName
            ? `Log an interaction with ${contactName} — messy notes or structured fields.`
            : "Log interactions with messy notes or a structured form."}
        </p>
      </div>
      <CaptureFormLazy
        initialContactId={contactId}
        initialContactName={contactName}
        defaultMode={defaultMode}
      />
    </div>
  );
}
