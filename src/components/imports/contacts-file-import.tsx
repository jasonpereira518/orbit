"use client";

import { useEffect, useState, useTransition } from "react";
import { BookUser } from "lucide-react";
import { toast } from "@/lib/toast";
import { previewContactsFile, type ContactsFilePerson } from "@/actions/imports";
import { Button } from "@/components/ui/button";
import { ContactsExportGuide } from "@/components/imports/contacts-export-guide";
import { ImportPeopleReview } from "@/components/imports/import-people-review";
import {
  BusyHint,
  ImportFilePicker,
  ImportWarningBanner,
} from "@/components/imports/import-utils";
import { formatUploadSize } from "@/lib/capture-limits";
import {
  CONTACTS_FILE_FORMAT_LABELS,
  MAX_CONTACTS_FILE_BYTES,
  MAX_CONTACTS_FILE_CHARS,
  compactContactsFileText,
  contactsFileTooLargeMessage,
} from "@/lib/contacts-file";
import { UserFacingError, friendlyError } from "@/lib/errors";
import { startImportJob, useImportJob } from "@/lib/import-job-runner";
import { TOAST_COPY } from "@/lib/toast-copy";

type PreviewResult = Awaited<ReturnType<typeof previewContactsFile>>;
type ContactsPreview = Exclude<PreviewResult, { error: string }>;

/** Extensions first for the file dialog's filter; the MIME types cover browsers that match on those instead. */
const ACCEPT = ".vcf,.vcard,.csv,text/vcard,text/x-vcard,text/csv";

/**
 * Address-book upload: a vCard or contacts CSV from Google, iPhone/iCloud, Android, macOS
 * Contacts or Outlook. The no-OAuth route to the same people the Google and Outlook cards
 * below import — which matters most on a deployment where those cards can't connect at all.
 *
 * Same flow as `LinkedInConnectionsImport`: read the file here, preview it server-side against
 * existing contacts, review, then hand the *text* (not the reviewed rows) to the job runner,
 * which has the server parse it again. Two differences, both about size. The text is compacted
 * first — every embedded contact photo stripped, see `compactContactsFileText` — because the
 * raw export can be mostly photos and it rides in two Server Action requests. And the checks
 * against the file limits run here, before upload, because a request over the platform's body
 * limit never reaches the action to be refused politely.
 */
export function ContactsFileImport() {
  const job = useImportJob();
  const [pending, start] = useTransition();

  const [fileText, setFileText] = useState("");
  const [fileName, setFileName] = useState<string | null>(null);
  const [people, setPeople] = useState<ContactsFilePerson[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [warnings, setWarnings] = useState<string[]>([]);

  const fileJob =
    job?.kind === "contacts_file" && job.status === "running" ? job : null;
  const importProgress = fileJob?.progress ?? null;
  const busy = pending || job?.status === "running";

  // Clear local review UI once this job finishes (toast handled globally by
  // ImportJobWatcher). Deferred a microtask for the same react-hooks/set-state-in-effect
  // reason `GoogleContactsImport` gives: this reacts to the external job-runner singleton.
  useEffect(() => {
    if (!job || job.kind !== "contacts_file") return;
    if (
      job.status !== "completed" &&
      job.status !== "failed" &&
      job.status !== "cancelled"
    )
      return;
    queueMicrotask(() => {
      setPeople([]);
      setSelected(new Set());
      setFileText("");
      setFileName(null);
      setWarnings([]);
    });
  }, [job]);

  function applyPreview(res: ContactsPreview) {
    setPeople(res.people);
    setSelected(
      new Set(res.people.filter((p) => !p.isRepeat).map((p) => p.id)),
    );
    setWarnings(res.warnings);
    toast.success(
      `Loaded ${res.totalRows} ${res.totalRows === 1 ? "person" : "people"} from your ${CONTACTS_FILE_FORMAT_LABELS[res.format]}`,
    );
  }

  /**
   * Preview errors arrive as data (see `previewContactsFile`) and are rethrown as
   * `UserFacingError`, which is what lets `friendlyError` show "This looks like a LinkedIn
   * export" instead of the generic preview fallback — they were written to be read.
   */
  async function preview(text: string, name: string) {
    const res = await previewContactsFile(text, name);
    if ("error" in res) throw new UserFacingError(res.error);
    applyPreview(res);
  }

  function resetReview() {
    setPeople([]);
    setSelected(new Set());
    setWarnings([]);
  }

  return (
    <section
      id="import-contacts-file"
      className="space-y-4 rounded-2xl border border-border/70 bg-card p-6"
    >
      <div className="flex items-start gap-3">
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-import-connections/10 text-import-connections">
          <BookUser className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h2 className="min-w-0 text-lg font-medium text-ink">
              Contacts file
            </h2>
            <ContactsExportGuide />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">
            Upload a vCard (.vcf) or contacts CSV from Google Contacts,
            iPhone, Android or Outlook — no account to connect. Photos
            aren&apos;t imported.
          </p>
        </div>
      </div>

      <ImportFilePicker
        accept={ACCEPT}
        disabled={busy}
        fileName={fileName}
        onFile={(file) => {
          if (file.size > MAX_CONTACTS_FILE_BYTES) {
            toast.error(
              `That file is ${formatUploadSize(file.size)} — the limit is ${formatUploadSize(MAX_CONTACTS_FILE_BYTES)}, so export fewer contacts at a time`,
            );
            return;
          }
          start(async () => {
            try {
              setFileName(file.name);
              const text = compactContactsFileText(await file.text());
              if (text.length > MAX_CONTACTS_FILE_CHARS) {
                throw new UserFacingError(contactsFileTooLargeMessage());
              }
              setFileText(text);
              await preview(text, file.name);
            } catch (err) {
              setFileText("");
              resetReview();
              toast.error(friendlyError(err, TOAST_COPY.previewFailed));
            }
          });
        }}
      />

      {pending ? <BusyHint>Reading contacts…</BusyHint> : null}

      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!fileText || busy}
          variant="outline"
          onClick={() =>
            start(async () => {
              try {
                await preview(fileText, fileName || "");
              } catch (err) {
                setWarnings([]);
                toast.error(friendlyError(err, TOAST_COPY.previewFailed));
              }
            })
          }
        >
          Refresh list
        </Button>
        <Button
          disabled={!fileText || busy || selected.size === 0}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
          onClick={() => {
            if (busy) return;
            try {
              startImportJob({
                kind: "contacts_file",
                text: fileText,
                fileName: fileName || "contacts",
                ids: [...selected],
              });
              // Clear the review list immediately; progress lives in the runner.
              resetReview();
              setFileText("");
              setFileName(null);
            } catch (err) {
              toast.error(friendlyError(err, TOAST_COPY.importFailed));
            }
          }}
        >
          {importProgress
            ? `Importing… ${importProgress.done}/${importProgress.total}`
            : `Import ${selected.size} selected`}
        </Button>
      </div>

      <ImportWarningBanner
        warnings={warnings}
        onDismiss={() => setWarnings([])}
      />

      {people.length > 0 && (
        <ImportPeopleReview
          people={people.map((p) => ({
            id: p.id,
            name: p.fullName,
            // Most address-book entries have no job at all, so the email (or, failing
            // that, the number) is what tells two same-named people apart in the list.
            subtitle:
              [p.title, p.company].filter(Boolean).join(" · ") ||
              p.email ||
              p.phone,
            isRepeat: p.isRepeat,
            repeatReason: p.duplicate?.reason,
          }))}
          selectedIds={selected}
          onSelectedIdsChange={setSelected}
          onRemove={(id) => {
            setPeople((prev) => prev.filter((p) => p.id !== id));
            setSelected((prev) => {
              const next = new Set(prev);
              next.delete(id);
              return next;
            });
          }}
        />
      )}
    </section>
  );
}
