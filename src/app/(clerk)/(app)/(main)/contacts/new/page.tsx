import Link from "next/link";
import { ContactForm } from "@/components/contacts/contact-form";
import { ContactQuotaNotice } from "@/components/contacts/contact-quota-notice";
import { LockedFeature } from "@/components/locked-feature";
import { getPlanOverview } from "@/actions/settings";
import { RenderStamp } from "@/components/layout/render-stamp";

export default async function NewContactPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // "Add" from a meeting's prep card: the guest's name and address, prefilled.
  const params = await searchParams;
  const one = (v: string | string[] | undefined) => (typeof v === "string" ? v.trim().slice(0, 200) : "");
  const initial = one(params.name) || one(params.email) ? { fullName: one(params.name), email: one(params.email) } : undefined;
  const { usage } = await getPlanOverview();
  const atLimit = usage.limit !== null && usage.remaining === 0;

  // Don't render a form that cannot succeed. The server-side check in
  // `createContactForUser` is still the real boundary — it holds against a direct POST —
  // but a thrown error is the wrong way to tell someone about a plan limit, and Next.js
  // masks thrown Server Function messages in production anyway.
  if (atLimit) {
    return (
      <div className="mx-auto max-w-2xl">
        <RenderStamp />
        <LockedFeature
          title={`You've reached ${usage.limit} contacts`}
          description="Every contact you already have stays right where it is — fully visible and editable. Upgrading lifts the limit so you can keep adding people."
          highlights={[
            "Unlimited contacts on Orbit Pro and Orbit Max",
            "Nothing is ever hidden or deleted at the limit",
            "Your existing notes, reminders, and history are untouched",
          ]}
        />
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <RenderStamp />
      <div>
        <h1 className="font-[family-name:var(--font-display)] text-3xl text-ink">
          Add contact
        </h1>
        <p className="mt-1 text-muted-foreground">
          Quick manual entry. Prefer{" "}
          <Link href="/capture" className="text-primary underline">
            AI capture
          </Link>{" "}
          for messy notes.
        </p>
      </div>
      <ContactQuotaNotice used={usage.used} limit={usage.limit} />
      <ContactForm initial={initial} />
    </div>
  );
}
