"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "@/lib/toast";

import { getWritingInstructions, saveWritingInstructions } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { MAX_WRITING_INSTRUCTIONS } from "@/lib/writing-instructions";

/**
 * "How I like things written" — the second box in the chat Context sheet.
 *
 * Separate from the box above it on purpose, and it looks it: that one is notes for THIS
 * conversation and is saved with the thread; this is a standing preference that applies to
 * every chat and to the draft-writing features, and belongs to the account. So it has its own
 * Save that does not close the sheet, is not tied to the per-thread note's saving or dictation
 * state, and loads when the sheet opens rather than with a thread.
 *
 * The text never travels with a chat request. The server reads it from the signed-in user's
 * own row when it builds the prompt, so nothing in a page or a message can supply it.
 */
export function WritingInstructionsField({ active }: { active: boolean }) {
  const id = useId();
  const [loaded, setLoaded] = useState(false);
  const [saved, setSaved] = useState("");
  const [text, setText] = useState("");
  const [saving, setSaving] = useState(false);
  // What the box held when it last saved. The tick shows only while the box still holds it.
  const [receipt, setReceipt] = useState<string | null>(null);

  // Loaded the first time the sheet opens, and only then: it is not per-thread, so a thread
  // switch must never reload (and clobber an edit in progress).
  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    getWritingInstructions()
      .then(({ text: stored }) => {
        if (cancelled) return;
        setSaved(stored ?? "");
        setText(stored ?? "");
        setLoaded(true);
      })
      .catch((err) => {
        if (!cancelled) toast.error(friendlyError(err, "Couldn’t load your writing notes — try again?"));
      });
    return () => {
      cancelled = true;
    };
  }, [active, loaded]);

  const dirty = loaded && text.trim() !== saved.trim();

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const res = await saveWritingInstructions(text);
      const stored = res.text ?? "";
      setSaved(stored);
      setText(stored);
      setReceipt(stored);
      toast.success(stored ? "Writing notes saved" : "Writing notes cleared");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t save your writing notes — try again?"));
    } finally {
      setSaving(false);
    }
  }, [text]);

  // A receipt, not a state: derived, so it disappears the moment the text changes again.
  const justSaved = receipt !== null && text.trim() === receipt.trim();

  return (
    <section aria-labelledby={`${id}-title`} className="flex flex-col gap-2 border-t border-border/60 p-4">
      <div>
        <h3 id={`${id}-title`} className="text-sm font-medium text-foreground">
          How I like things written
        </h3>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
          Applies to every chat and draft. Doesn’t create or change contacts.
        </p>
      </div>
      <Textarea
        rows={4}
        value={text}
        onChange={(e) => setText(e.target.value)}
        maxLength={MAX_WRITING_INSTRUCTIONS}
        disabled={!loaded || saving}
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-hint ${id}-count`}
        placeholder={
          loaded
            ? "e.g. Keep replies under 80 words. No exclamation marks. Sign emails “Jason”."
            : "Loading…"
        }
        className="min-h-[104px] resize-none"
      />
      <div className="flex items-center justify-between gap-2">
        <span
          id={`${id}-count`}
          className="text-xs tabular-nums text-muted-foreground"
          aria-live="polite"
        >
          {text.length}/{MAX_WRITING_INSTRUCTIONS}
        </span>
        <div className="flex items-center gap-2">
          {justSaved && (
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <Check className="size-3.5" aria-hidden /> Saved
            </span>
          )}
          <Button type="button" variant="outline" onClick={save} disabled={!dirty || saving}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        </div>
      </div>
    </section>
  );
}
