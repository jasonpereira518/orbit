"use client";

import { AlertCircle, Paperclip, X } from "lucide-react";
import { formatUploadSize } from "@/lib/capture-limits";

export type ComposeAttachment = {
  id: string;
  filename: string;
  size: number;
  /** Set once the upload finished; only these are sent. */
  pathname?: string;
  /** 0–100 while uploading. */
  progress: number;
  error?: string;
};

/** The composer's files: name, size, upload progress or what went wrong, and remove. */
export function AttachmentList({
  items,
  onRemove,
  disabled,
}: {
  items: ComposeAttachment[];
  onRemove: (id: string) => void;
  disabled?: boolean;
}) {
  if (!items.length) return null;
  return (
    <ul aria-label="Attachments" className="flex flex-wrap gap-1.5">
      {items.map((a) => {
        const uploading = !a.pathname && !a.error;
        return (
          <li
            key={a.id}
            className={`relative flex max-w-full min-w-0 items-center gap-1.5 overflow-hidden rounded-lg border px-2 py-1 text-xs ${
              a.error ? "border-destructive/50 text-destructive" : "border-border/70"
            }`}
          >
            {a.error ? <AlertCircle className="size-3.5 shrink-0" aria-hidden /> : <Paperclip className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />}
            <span className="min-w-0 truncate font-medium">{a.filename}</span>
            <span className="shrink-0 text-muted-foreground">
              {a.error ?? (uploading ? `${Math.round(a.progress)}%` : formatUploadSize(a.size))}
            </span>
            <button
              type="button"
              className="-mr-1 shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground disabled:opacity-50"
              aria-label={`Remove ${a.filename}`}
              onClick={() => onRemove(a.id)}
              disabled={disabled}
            >
              <X className="size-3" aria-hidden />
            </button>
            {uploading && (
              <span
                aria-hidden
                className="absolute bottom-0 left-0 h-0.5 bg-primary transition-[width]"
                style={{ width: `${a.progress}%` }}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
