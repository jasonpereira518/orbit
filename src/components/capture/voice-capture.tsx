"use client";

/**
 * The Voice tab: a microphone, and not much else until you have spoken. After you stop,
 * a short "transcribing" beat, then the words appear underneath where you can fix a name
 * before Extract. No paste box — that is the Messy Notes tab, one click away.
 */
import { useRef } from "react";
import { motion } from "motion/react";
import { Loader2, Upload } from "lucide-react";
import { VoiceRecorder } from "@/components/capture/voice-recorder";
import { IngestMeta, MissingKeyNotice } from "@/components/capture/messy-notes-capture";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { AUDIO_FILE_ACCEPT } from "@/lib/capture/ingest-client";
import type { CaptureIngest } from "@/lib/capture/use-capture-ingest";
import { DUR, EASE_HOUSE, SPRING_SOFT } from "@/lib/motion";
import { toast } from "@/lib/toast";
import { MAX_RECORDING_MS, formatElapsed } from "@/lib/voice-recording";

export function VoiceCapture({
  ingest,
  onExtract,
  extracting,
  canTranscribe,
  panelId,
  tabId,
}: {
  ingest: CaptureIngest;
  onExtract: () => void;
  extracting: boolean;
  canTranscribe: boolean;
  panelId: string;
  tabId: string;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const hasTranscript = ingest.notes.trim().length > 0;
  const busy = ingest.busy || extracting;

  return (
    <div id={panelId} role="tabpanel" aria-labelledby={tabId} className="space-y-4 rounded-2xl border border-border/70 bg-card p-5 sm:p-6">
      {!ingest.hasApiKey && <MissingKeyNotice />}
      {!canTranscribe && ingest.hasApiKey && (
        <div className="rounded-xl border border-amber-200/80 bg-amber-50/70 px-3 py-3 text-sm dark:border-amber-900/50 dark:bg-amber-950/30">
          <p className="font-medium text-foreground">Add a key that can transcribe audio</p>
          <p className="mt-1 text-muted-foreground">Voice notes transcribe with OpenAI, Gemini or Wispr — Anthropic can’t hear audio.</p>
        </div>
      )}

      <motion.div layout transition={SPRING_SOFT} className="flex flex-col items-center gap-3 py-2 text-center">
        {!hasTranscript && (
          <h2 className="font-[family-name:var(--font-display)] text-2xl text-ink">Say who you met</h2>
        )}
        <VoiceRecorder
          size={hasTranscript ? "default" : "hero"}
          onRecording={ingest.handleRecording}
          busy={busy}
          busyLabel={ingest.busy ? "Transcribing…" : "Reading…"}
          idleHint={hasTranscript ? "Record again to replace the transcript" : undefined}
          onCapReached={() => toast.info(`Stopped at ${formatElapsed(MAX_RECORDING_MS)} — your recording was kept`)}
        />
        <input
          ref={fileRef}
          type="file"
          accept={AUDIO_FILE_ACCEPT}
          className="sr-only"
          onChange={(e) => {
            ingest.handleFilesSelected(Array.from(e.target.files ?? []));
            e.target.value = "";
          }}
        />
        <Button variant="link" size="sm" className="text-muted-foreground" disabled={busy} onClick={() => fileRef.current?.click()}>
          <Upload className="size-3.5" /> or upload a recording
        </Button>
      </motion.div>

      {ingest.busy && !hasTranscript && (
        <div className="space-y-2" aria-hidden>
          <Skeleton className="h-4 w-11/12" />
          <Skeleton className="h-4 w-full" />
          <Skeleton className="h-4 w-9/12" />
          <Skeleton className="h-4 w-4/12" />
        </div>
      )}

      {hasTranscript && (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: DUR.slow, ease: EASE_HOUSE }}
          className="space-y-3"
        >
          <div>
            <Label htmlFor="voice-transcript">Your transcript — fix names before extracting</Label>
            <Textarea
              id="voice-transcript"
              className="mt-2 min-h-[180px]"
              value={ingest.notes}
              onChange={(e) => ingest.setNotes(e.target.value)}
              disabled={extracting}
            />
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {ingest.busy && (
              <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Transcribing…
              </span>
            )}
            <IngestMeta fileName={ingest.fileName} sources={ingest.sources} />
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button
              disabled={busy || !ingest.hasApiKey}
              className="bg-primary text-primary-foreground hover:bg-primary/90 sm:flex-1"
              onClick={onExtract}
            >
              {extracting ? "Reading…" : "Extract people"}
            </Button>
            <Button variant="ghost" className="text-muted-foreground" disabled={busy} onClick={ingest.reset}>
              Clear
            </Button>
          </div>
        </motion.div>
      )}
    </div>
  );
}
