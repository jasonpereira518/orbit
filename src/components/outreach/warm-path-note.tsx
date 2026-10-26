import { IntentLink } from "@/components/ui/intent-link";
import { normalizeCompanyKey } from "@/lib/company-name";
import { withoutOwnContact, type WarmPath } from "@/lib/warm-paths";

/**
 * "You already know 2 people at Stripe" — the line that should stop a cold email being sent.
 *
 * Renders nothing when there is no connection, which is the common case and must stay quiet;
 * a row of empty "no warm path" labels would train people to ignore the one that matters.
 *
 * Names link straight to the contact, because the next action is reading what you know about
 * them before asking for anything. A row that is itself one of those contacts is not counted:
 * pass `ownContactId` and they are left out, and the note hides if nobody else is left.
 */
export function WarmPathNote({
  company,
  warmPaths,
  ownContactId,
}: {
  company?: string | null;
  warmPaths?: Record<string, WarmPath[]>;
  ownContactId?: string | null;
}) {
  if (!company || !warmPaths) return null;
  const paths = withoutOwnContact(warmPaths[normalizeCompanyKey(company)], ownContactId);
  if (!paths.length) return null;

  return (
    <div className="mt-1.5 rounded-lg border border-primary/30 bg-primary/5 px-2 py-1.5 text-xs">
      <span className="font-medium text-ink">
        You know {paths.length} {paths.length === 1 ? "person" : "people"} here
      </span>
      <ul className="mt-1 space-y-0.5">
        {paths.map((p) => (
          <li key={p.contactId} className="text-muted-foreground">
            <IntentLink
              href={`/contacts/${p.contactId}`}
              className="text-ink underline-offset-2 hover:underline"
            >
              {p.fullName}
            </IntentLink>
            {" — "}
            {p.reasonLabel}
          </li>
        ))}
      </ul>
    </div>
  );
}
