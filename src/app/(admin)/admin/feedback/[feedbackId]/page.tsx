import Link from "next/link";
import { notFound } from "next/navigation";
import { CopyId } from "@/components/admin/copy-id";
import {
  AdminPageHeader,
  AdminPanel,
  CodeDetail,
  DefinitionRow,
  EmptyState,
  RelativeTime,
} from "@/components/admin/primitives";
import {
  DeleteFeedbackScreenshotButton,
  FeedbackStatusActions,
} from "@/components/admin/feedback-status-actions";
import { loadFeedbackDetail } from "@/lib/admin-feedback";

export const metadata = { title: "Admin · Feedback entry" };

function kb(bytes: number) {
  return `${Math.round(bytes / 1024)} KB`;
}

/**
 * One feedback entry, with everything that came with it.
 *
 * The gallery renders `/api/feedback/screenshots/[shotId]` rather than any stored bytes:
 * `loadFeedbackDetail` never selects `inline_data`, so the images stay out of the RSC
 * payload entirely. `scripts/smoke-feedback-admin.ts` asserts that, because it is the kind
 * of property that erodes the first time someone adds a column to a select.
 */
export default async function AdminFeedbackDetailPage({
  params,
}: {
  params: Promise<{ feedbackId: string }>;
}) {
  const { feedbackId } = await params;
  const detail = await loadFeedbackDetail(feedbackId);
  if (!detail) notFound();

  const { entry, screenshots, submitter } = detail;
  const contextEntries = Object.entries(entry.context ?? {});

  return (
    <>
      <AdminPageHeader
        title="Feedback"
        subtitle={
          <>
            {entry.category ?? entry.kind} · {entry.area ?? "unspecified area"} ·{" "}
            <RelativeTime date={entry.createdAt} />{" "}
            <Link
              href="/admin/feedback"
              className="underline underline-offset-2 hover:text-foreground"
            >
              Back to all feedback
            </Link>
          </>
        }
      />

      <div className="grid gap-6">
        <AdminPanel title="What they said">
          {entry.text ? (
            <p className="whitespace-pre-wrap text-sm leading-relaxed">{entry.text}</p>
          ) : (
            <EmptyState>No text — this entry is a score only.</EmptyState>
          )}
          {entry.score != null && (
            <p className="mt-3 text-xs text-muted-foreground">PMF score: {entry.score}/3</p>
          )}
        </AdminPanel>

        <AdminPanel title={`Screenshots (${screenshots.length})`}>
          {screenshots.length === 0 ? (
            <EmptyState>Nothing was attached.</EmptyState>
          ) : (
            <ul className="grid gap-6 md:grid-cols-2">
              {screenshots.map((shot) => (
                <li key={shot.id} className="grid gap-2">
                  {/* eslint-disable-next-line @next/next/no-img-element -- served by an
                      auth-gated API route, not a remote origin next/image can optimise. */}
                  <img
                    src={`/api/feedback/screenshots/${shot.id}`}
                    alt={shot.note ?? `Screenshot ${shot.position + 1}`}
                    loading="lazy"
                    className="w-full rounded-md border border-border"
                  />
                  {shot.note && <p className="text-sm">{shot.note}</p>}
                  <div className="flex items-center justify-between text-xs text-muted-foreground">
                    <span>
                      {shot.width && shot.height ? `${shot.width}×${shot.height} · ` : ""}
                      {kb(shot.byteSize)} · {shot.contentType}
                    </span>
                    <DeleteFeedbackScreenshotButton id={shot.id} />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </AdminPanel>

        <AdminPanel title="Where they were">
          <dl>
            {contextEntries.length === 0 ? (
              <EmptyState>No context was recorded.</EmptyState>
            ) : (
              contextEntries.map(([key, value]) => (
                <DefinitionRow key={key} label={key}>
                  {typeof value === "object" && value !== null ? (
                    <CodeDetail>{JSON.stringify(value)}</CodeDetail>
                  ) : (
                    String(value ?? "—")
                  )}
                </DefinitionRow>
              ))
            )}
          </dl>
        </AdminPanel>

        <AdminPanel title="Submitter">
          <dl>
            <DefinitionRow label="Email">
              {submitter?.email ?? (
                <span className="text-muted-foreground">account purged</span>
              )}
            </DefinitionRow>
            <DefinitionRow label="User">
              <span className="inline-flex items-center gap-2">
                <CopyId value={entry.userId} />
                <Link
                  href={`/admin/users/${entry.userId}`}
                  className="underline underline-offset-2 hover:text-primary"
                >
                  Open account
                </Link>
              </span>
            </DefinitionRow>
            {submitter?.createdAt && (
              <DefinitionRow label="Signed up">
                <RelativeTime date={submitter.createdAt} />
              </DefinitionRow>
            )}
          </dl>
        </AdminPanel>

        <AdminPanel title="Triage">
          <dl className="mb-4">
            <DefinitionRow label="Status">{entry.status}</DefinitionRow>
            {entry.statusChangedAt && (
              <DefinitionRow label="Changed">
                <RelativeTime date={entry.statusChangedAt} />
              </DefinitionRow>
            )}
            {entry.statusChangedBy && (
              <DefinitionRow label="By">
                <CopyId value={entry.statusChangedBy} />
              </DefinitionRow>
            )}
            {entry.resolutionNote && (
              <DefinitionRow label="Resolution">{entry.resolutionNote}</DefinitionRow>
            )}
          </dl>
          <FeedbackStatusActions id={entry.id} status={entry.status} />
        </AdminPanel>
      </div>
    </>
  );
}
