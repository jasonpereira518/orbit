"use client";

/**
 * Capture's page-wide drop and paste: any file or folder, anywhere on the page.
 *
 * `routeDrop` decides where each file goes; this owns the flows it hands them to — the import
 * queue (from /imports), the notes sorter and fan-out (the Notes Library's), the Voice tab's
 * upload (through `onAudio`), the chat card, and LinkedIn profile links. A drop that splits
 * across more than one of those says how first, and nothing runs until the person agrees.
 *
 * The tabs' own drop zones cancel what they take, and the window hook leaves those alone
 * (`use-window-file-drop.ts`), so a folder dropped on the Notes Library goes only there.
 */
import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { NotesFanoutList } from "@/components/capture/notes-library-upload";
import { NotesSorterDialog } from "@/components/capture/notes-sorter-dialog";
import { FolderTriageCard } from "@/components/imports/folder-triage-card";
import { ImportDropOverlay } from "@/components/imports/import-drop-overlay";
import { ImportQueueCard } from "@/components/imports/import-queue-card";
import { Button } from "@/components/ui/button";
import { addContactsFromLinkedInUrls } from "@/actions/linkedin-drop";
import { MAX_DROP_DEPTH, type DroppedFile } from "@/lib/capture/file-drop";
import {
  hasImports,
  isMixedDrop,
  routeDrop,
  summarizeRoute,
  type RoutedDrop,
} from "@/lib/capture/route-drop";
import { useCaptureFanout } from "@/lib/capture/use-capture-fanout";
import { friendlyError } from "@/lib/errors";
import { handOffChatFiles } from "@/lib/imports/chat-handoff";
import { LINKEDIN_PRIVATE, type DetectionResult } from "@/lib/imports/detect-import-file";
import { IMPORT_COPY } from "@/lib/imports/import-copy";
import { maxImportBytesFor } from "@/lib/imports/import-constants";
import { stageDrop } from "@/lib/imports/use-import-queue";
import { extractLinkedInProfileRefs } from "@/lib/linkedin-paste";
import { toast } from "@/lib/toast";
import { useWindowFileDrop, useWindowFilePaste } from "@/lib/use-window-file-drop";

/** A LinkedIn archive folder is dozens of files: the same cap as /imports. */
const DROP_LIMITS = { maxFiles: 200, maxDepth: MAX_DROP_DEPTH };
const CHATS_HREF = "/imports#import-panel-chats";

type Router = ReturnType<typeof useRouter>;

/**
 * A LinkedIn profile link dragged in from another tab (or pasted onto the page) adds that
 * person straight away — the drop is the whole instruction, so there is no review step.
 * Pasted text that holds no profile link is ignored rather than scolded: people paste onto
 * pages by accident, but nobody drags a link here by accident.
 */
export async function addLinkedInProfilesFromText(text: string, how: "drop" | "paste", router: Router) {
  if (!extractLinkedInProfileRefs(text).length) {
    if (how === "drop") toast.error(IMPORT_COPY.linkNotProfile);
    return;
  }
  const id = toast.loading(IMPORT_COPY.linkAdding);
  try {
    const result = await addContactsFromLinkedInUrls(text);
    const view = (contactId: string) => ({
      label: "View",
      onClick: () => router.push(`/contacts/${contactId}`),
    });
    const { added, existing } = result;
    const guessed = result.degraded ? IMPORT_COPY.linkNameGuessed : undefined;

    if (added.length === 1) {
      toast.success(`Added ${added[0]!.name} to your contacts`, {
        id,
        description: guessed,
        action: view(added[0]!.contactId),
      });
    } else if (added.length > 1) {
      toast.success(`Added ${added.length} people to your contacts`, {
        id,
        description: guessed,
        action: { label: "View", onClick: () => router.push("/contacts") },
      });
    } else if (existing.length === 1) {
      toast.message(`${existing[0]!.name} is already in your contacts`, {
        id,
        action: view(existing[0]!.contactId),
      });
    } else if (existing.length > 1) {
      toast.message(`All ${existing.length} are already in your contacts`, { id });
    }

    if (result.limitMessage) {
      if (added.length || existing.length) toast.error(result.limitMessage);
      else toast.error(result.limitMessage, { id });
    }
    if (added.length) router.refresh();
  } catch (err) {
    toast.error(friendlyError(err, IMPORT_COPY.linkAddFailed), { id });
  }
}

function skippedDescription(ignored: RoutedDrop["ignored"]) {
  const shown = ignored.slice(0, 3).map((i) => `${i.name} — ${i.reason}`);
  if (ignored.length > 3) shown.push(`and ${ignored.length - 3} more`);
  return shown.join(" · ");
}

export function CaptureImportStrip({
  disabled = false,
  hasApiKey,
  chatImports = false,
  onAudio,
  onNotesQueued,
}: {
  /** The page is mid-capture: a drop would land behind the review. */
  disabled?: boolean;
  hasApiKey: boolean;
  /** `feature.chat-imports` is live for this viewer. */
  chatImports?: boolean;
  /** Recordings go to the Voice tab's upload. */
  onAudio: (files: File[]) => void;
  /** The jobs a sorted notes drop created, once every note has settled. */
  onNotesQueued: (jobIds: string[]) => void;
}) {
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  /** A mixed drop, waiting for the person to agree to the split. */
  const [pending, setPending] = useState<{ routed: RoutedDrop; fromFolder: boolean } | null>(null);
  /** A folder's importable files, waiting for the person to confirm which. */
  const [triage, setTriage] = useState<DetectionResult | null>(null);
  const [notes, setNotes] = useState<DroppedFile[] | null>(null);
  const fanout = useCaptureFanout({ onSettled: onNotesQueued });

  const run = useCallback(
    (routed: RoutedDrop, fromFolder: boolean, summarized: boolean) => {
      if (routed.linkedinUrls.length) {
        void addLinkedInProfilesFromText(routed.linkedinUrls.join("\n"), "drop", router);
      }
      if (routed.audio.length) onAudio(routed.audio);
      if (routed.notes.length) {
        if (!hasApiKey) toast.error("Add an AI key in Settings to read notes");
        else if (fanout.running) toast.message("Those notes can go once the ones above finish");
        else setNotes(routed.notes);
      }
      if (routed.chats.length) {
        handOffChatFiles(routed.chats);
        // The chat card lives on /imports for now; the hand-off waits there until it mounts.
        if (!isMixedDrop(routed)) router.push(CHATS_HREF);
        else
          toast.message(`${routed.chats.length === 1 ? "A chat export is" : `${routed.chats.length} chat exports are`} ready`, {
            action: { label: "Review", onClick: () => router.push(CHATS_HREF) },
          });
      }
      if (hasImports(routed)) {
        // A LinkedIn export is ~35 files: say up front what happens to them, so a person who
        // dropped the whole folder knows the private ones never leave their device.
        const kept = routed.imports.exportFiles.length;
        const privateCount = routed.imports.ignored.filter((d) => d.reason === LINKEDIN_PRIVATE).length;
        if (kept) {
          toast.info(
            `Orbit will keep ${kept} files from your LinkedIn export${
              privateCount
                ? ` — ${privateCount} private ${privateCount === 1 ? "file stays" : "files stay"} on your device`
                : ""
            }`,
          );
        }
        // Same rule as /imports: a folder with several readable files is a choice to confirm.
        if (fromFolder && routed.imports.candidates.length >= 2) setTriage(routed.imports);
        else void stageDrop(routed.imports);
      } else if (routed.ignored.length && !summarized) {
        // The queue would have listed these; with no queue, say so here.
        toast.message(`${routed.ignored.length} skipped`, { description: skippedDescription(routed.ignored) });
      }
    },
    [fanout.running, hasApiKey, onAudio, router],
  );

  const handleDrop = useCallback(
    async (files: DroppedFile[], truncated: boolean, text = "") => {
      if (!files.length && !text.trim()) return;
      setScanning(true);
      try {
        const routed = await routeDrop(files, { maxBytes: maxImportBytesFor, truncated, chatImports, text });
        if (!summarizeRoute({ ...routed, ignored: [] })) {
          if (text.trim()) toast.error(IMPORT_COPY.linkNotProfile);
          else
            toast.error("Nothing in that drop is something Orbit reads", {
              description: skippedDescription(routed.ignored),
            });
          return;
        }
        const fromFolder = files.some((f) => f.path !== "");
        if (isMixedDrop(routed)) setPending({ routed, fromFolder });
        else run(routed, fromFolder, false);
      } finally {
        setScanning(false);
      }
    },
    [chatImports, run],
  );

  const { active, kind, reading } = useWindowFileDrop({
    disabled,
    onFiles: (result) => void handleDrop(result.files, result.truncated),
    onText: (text) => void handleDrop([], false, text),
    limits: DROP_LIMITS,
  });
  useWindowFilePaste({
    disabled,
    onFiles: (files) => void handleDrop(files.map((file) => ({ file, path: "" })), false),
    // Pasted text with no profile link in it is someone's stray paste, not a request.
    onText: (text) => {
      if (extractLinkedInProfileRefs(text).length) void handleDrop([], false, text);
    },
  });

  return (
    <>
      <ImportDropOverlay active={active} kind={kind} />
      <div className="space-y-4 empty:hidden">
        {(reading || scanning) && (
          <p className="inline-flex items-center gap-1.5 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            Reading that drop…
          </p>
        )}

        {pending && (
          <section
            aria-label="What Orbit will do with that drop"
            className="space-y-3 rounded-2xl border border-border/70 bg-card p-4"
          >
            <div>
              <p className="text-sm font-medium text-foreground">{summarizeRoute(pending.routed)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Notes are sorted before they’re read, and imports reviewed before anything is saved.
              </p>
            </div>
            {pending.routed.ignored.length > 0 && (
              <details className="text-xs text-muted-foreground">
                <summary className="cursor-pointer">What’s skipped</summary>
                <ul className="mt-1 space-y-0.5">
                  {pending.routed.ignored.map((i, n) => (
                    <li key={`${i.name}-${n}`}>
                      {i.name} — {i.reason}
                    </li>
                  ))}
                </ul>
              </details>
            )}
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                onClick={() => {
                  setPending(null);
                  run(pending.routed, pending.fromFolder, true);
                }}
              >
                Go ahead
              </Button>
              <Button type="button" size="sm" variant="ghost" onClick={() => setPending(null)}>
                Cancel
              </Button>
            </div>
          </section>
        )}

        {triage && (
          <FolderTriageCard
            result={triage}
            onCancel={() => setTriage(null)}
            onConfirm={(chosen) => {
              setTriage(null);
              void stageDrop(chosen);
            }}
          />
        )}

        {/* Draws its own finish card (`ImportFinishCard`) when the run is done. */}
        <ImportQueueCard onFinishUndone={() => router.refresh()} />

        {notes && (
          <NotesSorterDialog
            incoming={notes}
            onCancel={() => setNotes(null)}
            onConfirm={(plans, resolve) => {
              fanout.start(plans, resolve);
              setNotes(null);
            }}
          />
        )}

        <NotesFanoutList fanout={fanout} />
      </div>
    </>
  );
}
