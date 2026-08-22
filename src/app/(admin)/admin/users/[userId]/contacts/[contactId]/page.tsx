import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import {
  AdminPageHeader,
  AdminPanel,
  AdminTable,
  DefinitionRow,
  EmptyState,
  RelativeTime,
  SecretState,
  Td,
  Th,
} from "@/components/admin/primitives";
import { RevealBanner } from "@/components/admin/reveal-grant";
import { RevealContactButton } from "@/components/admin/reveal-contact";
import { requireAdminUserId } from "@/lib/admin";
import { activeRevealGrant, describeActiveGrant } from "@/lib/admin-reveal";
import { getAdminContactDetail } from "@/lib/admin-user-detail";

export const metadata = { title: "Admin · Contact" };

/**
 * One contact record, for when the account-level view is not enough.
 *
 * The masked view is built entirely from presence and counts — "notes on 12 of 14
 * interactions" answers the question a support ticket actually asks (did the capture write
 * anything, did the import land) without reading a word of what was written. Those booleans
 * come from SQL predicates rather than from the row, because the masked query does not
 * select the columns they describe.
 */
export default async function AdminContactDetailPage({
  params,
}: {
  params: Promise<{ userId: string; contactId: string }>;
}) {
  const { userId, contactId } = await params;
  const decoded = decodeURIComponent(userId);

  const adminUserId = await requireAdminUserId();
  const [grant, grantSummary] = await Promise.all([
    activeRevealGrant(adminUserId, decoded),
    describeActiveGrant(adminUserId, decoded),
  ]);

  const detail = await getAdminContactDetail(decoded, contactId, { grant });
  if (!detail) notFound();

  const { contact, interactions } = detail;
  const revealed = contact.revealed;
  const withNotes = interactions.filter((i) => i.hasRawNotes).length;

  return (
    <>
      <Link
        href={`/admin/users/${encodeURIComponent(decoded)}#contacts`}
        className="mb-3 inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-primary"
      >
        <ArrowLeft className="size-3" aria-hidden /> Back to the account
      </Link>

      <AdminPageHeader
        title={contact.maskedName}
        subtitle={
          <span className="font-mono text-xs">
            {[contact.title, contact.company].filter(Boolean).join(" · ") ||
              contactId}
          </span>
        }
        action={
          !revealed ? (
            <RevealContactButton targetUserId={decoded} contactId={contactId} />
          ) : undefined
        }
      />

      {grantSummary && (
        <div className="mb-4">
          <RevealBanner
            targetUserId={decoded}
            reason={grantSummary.reason}
            expiresAt={grantSummary.expiresAt.toISOString()}
          />
        </div>
      )}

      <div className="space-y-6">
        <AdminPanel title="Record">
          <dl className="space-y-0">
            <DefinitionRow label="Company">{contact.company ?? "—"}</DefinitionRow>
            <DefinitionRow label="Title">{contact.title ?? "—"}</DefinitionRow>
            <DefinitionRow label="Source">{detail.source ?? "—"}</DefinitionRow>
            <DefinitionRow label="Industry">{detail.industry ?? "—"}</DefinitionRow>
            <DefinitionRow label="Relationship score">
              {detail.relationshipScore ?? "—"}
              {detail.statedCloseness != null &&
                ` (stated ${detail.statedCloseness})`}
            </DefinitionRow>
            <DefinitionRow label="Added">
              <RelativeTime date={contact.createdAt} /> ago
            </DefinitionRow>
            <DefinitionRow label="Last interaction">
              {detail.lastInteractionAt ? (
                <>
                  <RelativeTime date={detail.lastInteractionAt} /> ago
                </>
              ) : (
                "—"
              )}
            </DefinitionRow>
            <DefinitionRow label="Next follow-up">
              {detail.nextFollowUpAt
                ? detail.nextFollowUpAt.toISOString().slice(0, 10)
                : "—"}
            </DefinitionRow>
            <DefinitionRow label="Reminders">{detail.reminderCount}</DefinitionRow>
            <DefinitionRow label="Tags">{detail.tagCount}</DefinitionRow>
            <DefinitionRow label="Embeddings">{detail.embeddingCount}</DefinitionRow>
          </dl>
        </AdminPanel>

        {/* Masked: what exists. Unmasked: what it says. Same section either way, so the
            difference between the two views is obvious rather than inferred. */}
        <AdminPanel title={revealed ? "Contact details" : "What this record holds"}>
          {revealed ? (
            <dl className="space-y-0">
              <DefinitionRow label="Full name">{revealed.fullName}</DefinitionRow>
              <DefinitionRow label="Email">{revealed.email ?? "—"}</DefinitionRow>
              <DefinitionRow label="Phone">{revealed.phone ?? "—"}</DefinitionRow>
              <DefinitionRow label="Location">{revealed.location ?? "—"}</DefinitionRow>
              <DefinitionRow label="School">{revealed.school ?? "—"}</DefinitionRow>
              <DefinitionRow label="LinkedIn">
                {revealed.linkedinUrl ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="How they met">
                {revealed.howMet ?? revealed.metContext ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="AI summary">
                {revealed.aiSummary ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="Notes">
                <span className="whitespace-pre-wrap">{revealed.notes ?? "—"}</span>
              </DefinitionRow>
              <DefinitionRow label="Key facts">
                {revealed.keyFacts.length > 0 ? (
                  <ul className="list-inside list-disc">
                    {revealed.keyFacts.map((f, i) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </DefinitionRow>
              <DefinitionRow label="Opportunities">
                {revealed.opportunities.length > 0 ? (
                  <ul className="list-inside list-disc">
                    {revealed.opportunities.map((o, i) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </DefinitionRow>
            </dl>
          ) : (
            <>
              <p className="mb-3 text-xs text-muted-foreground">
                This person never signed up for Orbit. Reading what someone wrote about
                them needs a reason, and the reason is logged.
              </p>
              <dl className="space-y-0">
                <DefinitionRow label="Interactions">
                  {interactions.length} logged, {withNotes} with notes
                </DefinitionRow>
              </dl>
            </>
          )}
        </AdminPanel>

        <AdminPanel title={`Interactions (${interactions.length})`}>
          {interactions.length === 0 ? (
            <EmptyState>Nothing logged against this contact.</EmptyState>
          ) : (
            <AdminTable
              head={
                <>
                  <Th>Type</Th>
                  <Th>Source</Th>
                  <Th numeric>When</Th>
                  {revealed ? <Th>Notes</Th> : <Th>Content</Th>}
                </>
              }
            >
              {interactions.map((row) => (
                <tr
                  key={row.id}
                  className="border-b border-border/40 last:border-b-0 align-top"
                >
                  <Td>{row.interactionType}</Td>
                  <Td className="text-muted-foreground">{row.source ?? "—"}</Td>
                  <Td numeric className="whitespace-nowrap">
                    <RelativeTime date={row.interactionDate} /> ago
                  </Td>
                  <Td className="max-w-96">
                    {row.revealed ? (
                      <span className="whitespace-pre-wrap text-xs">
                        {row.revealed.rawNotes ??
                          row.revealed.aiSummary ??
                          "—"}
                      </span>
                    ) : (
                      // Presence, not content: computed from SQL predicates, because the
                      // masked query never selects the columns they describe.
                      <span className="flex flex-wrap items-center gap-2 text-xs">
                        <span className="flex items-center gap-1">
                          <span className="text-muted-foreground">notes</span>
                          <SecretState present={row.hasRawNotes} absentLabel="none" />
                        </span>
                        <span className="flex items-center gap-1">
                          <span className="text-muted-foreground">summary</span>
                          <SecretState present={row.hasAiSummary} absentLabel="none" />
                        </span>
                        <span className="text-muted-foreground">
                          {row.topicCount} topic{row.topicCount === 1 ? "" : "s"}
                        </span>
                      </span>
                    )}
                  </Td>
                </tr>
              ))}
            </AdminTable>
          )}
        </AdminPanel>
      </div>
    </>
  );
}
