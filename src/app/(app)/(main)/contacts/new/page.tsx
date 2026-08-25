import { ContactForm } from "@/components/contacts/contact-form";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { LockedFeature } from "@/components/locked-feature";
import { getPlanOverview } from "@/actions/settings";

export default async function NewContactPage() {
  const { usage } = await getPlanOverview();
  const atLimit = usage.limit !== null && usage.remaining === 0;

  // Don't render a form that cannot succeed. The server-side check in
  // `createContactForUser` is still the real boundary — it holds against a direct POST —
  // but a thrown error is the wrong way to tell someone about a plan limit, and Next.js
  // masks thrown Server Function messages in production anyway.
  if (atLimit) {
    return (
      <div className="mx-auto max-w-2xl">
        <LockedFeature
          title={`You've reached ${usage.limit} contacts`}
          description="Every contact you already have stays right where it is — fully visible and editable. Upgrading lifts the limit so you can keep adding people."
          highlights={[
            "Unlimited contacts on Orbit Pro and Orbit Lifetime",
            "Nothing is ever hidden or deleted at the limit",
            "Your existing notes, reminders, and history are untouched",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-primary">
          Add contact
        </h1>
        <p className="mt-1 text-muted-foreground">
          Quick manual entry. Prefer{" "}
          <a href="/capture" className="text-primary underline">
            AI capture
          </a>{" "}
          for messy notes.
        </p>
      </div>
      <ContactQuotaNotice used={usage.used} limit={usage.limit} />
      <ContactForm />
    </div>
  );
}
