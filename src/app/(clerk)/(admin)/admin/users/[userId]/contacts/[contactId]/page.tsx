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
import { CopyId } from "@/components/admin/copy-id";
import { requireAdminUserId } from "@/lib/admin";
import { recordAccountView } from "@/lib/admin-operations";
import { getAdminContactDetail } from "@/lib/admin-user-detail";

export const metadata = { title: "Admin · Contact" };

/**
 * One contact record, for when the account-level view is not enough.
 *
 * Alongside the prose, each interaction still shows presence and counts — "notes on 12 of
 * 14 interactions". That survived the removal of the reveal gate because it was never
 * really about redaction: it is the fastest answer to what a support ticket actually asks
 * (did the capture write anything, did the import land), and it is computed across every
 * interaction rather than the fifty rendered below.
 */
export default async function AdminContactDetailPage({
  params,
}: {
  params: Promise<{ userId: string; contactId: string }>;
}) {
  const { userId, contactId } = await params;
  const decoded = decodeURIComponent(userId);

  const adminUserId = await requireAdminUserId();
  await recordAccountView(adminUserId, decoded);

  const detail = await getAdminContactDetail(decoded, contactId);
  if (!detail) notFound();

  const { contact, interactions } = detail;
  const fields = contact.detail;
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
        title={contact.name}
        subtitle={
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span>
              {[contact.title, contact.company].filter(Boolean).join(" · ") ||
                "No title or company"}
            </span>
            <CopyId value={contactId} label="contact ID" />
          </span>
        }
      />

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

        <AdminPanel title="Contact details">
          {fields ? (
            <dl className="space-y-0">
              <DefinitionRow label="Full name">{fields.fullName}</DefinitionRow>
              <DefinitionRow label="Email">{fields.email ?? "—"}</DefinitionRow>
              <DefinitionRow label="Phone">{fields.phone ?? "—"}</DefinitionRow>
              <DefinitionRow label="Location">{fields.location ?? "—"}</DefinitionRow>
              <DefinitionRow label="School">{fields.school ?? "—"}</DefinitionRow>
              <DefinitionRow label="LinkedIn">
                {fields.linkedinUrl ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="How they met">
                {fields.howMet ?? fields.metContext ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="AI summary">
                {fields.aiSummary ?? "—"}
              </DefinitionRow>
              <DefinitionRow label="Notes">
                <span className="whitespace-pre-wrap">{fields.notes ?? "—"}</span>
              </DefinitionRow>
              <DefinitionRow label="Key facts">
                {fields.keyFacts.length > 0 ? (
                  <ul className="list-inside list-disc">
                    {fields.keyFacts.map((f: string, i: number) => (
                      <li key={i}>{f}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </DefinitionRow>
              <DefinitionRow label="Opportunities">
                {fields.opportunities.length > 0 ? (
                  <ul className="list-inside list-disc">
                    {fields.opportunities.map((o: string, i: number) => (
                      <li key={i}>{o}</li>
                    ))}
                  </ul>
                ) : (
                  "—"
                )}
              </DefinitionRow>
              <DefinitionRow label="Interactions">
                {interactions.length} logged, {withNotes} with notes
              </DefinitionRow>
            </dl>
          ) : (
            // Unreachable from this page — `getAdminContactDetail` always populates
            // `detail` — but the type allows null because the account-level summary read
            // shares the row shape.
            <EmptyState>Record unavailable.</EmptyState>
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
                  <Th>Notes</Th>
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
                    {row.detail.rawNotes ?? row.detail.aiSummary ? (
                      <span className="whitespace-pre-wrap text-xs">
                        {row.detail.rawNotes ?? row.detail.aiSummary}
                      </span>
                    ) : (
                      // Nothing written. Say which of the two is missing rather than
                      // printing an em dash — "no notes, no summary, 3 topics" is a
                      // diagnosis; "—" is a shrug.
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
