"use client";

import { Check, Loader2 } from "lucide-react";
import { useCallback, useEffect, useId, useState } from "react";
import { toast } from "@/lib/toast";

import {
  getWritingInstructions,
  refreshStyleProfile,
  saveStyleProfile,
  saveWritingInstructions,
} from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { friendlyError } from "@/lib/errors";
import { MAX_WRITING_INSTRUCTIONS, STYLE_PROFILE_MAX } from "@/lib/writing-instructions";

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
  // null = not learned yet, "" = turned off, text = what drafts are told.
  const [styleProfile, setStyleProfile] = useState<string | null>(null);

  // Loaded the first time the sheet opens, and only then: it is not per-thread, so a thread
  // switch must never reload (and clobber an edit in progress).
  useEffect(() => {
    if (!active || loaded) return;
    let cancelled = false;
    getWritingInstructions()
      .then(({ text: stored, styleProfile: learned }) => {
        if (cancelled) return;
        setSaved(stored ?? "");
        setText(stored ?? "");
        setStyleProfile(learned);
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
      {loaded && <LearnedStyle profile={styleProfile} onChange={setStyleProfile} />}
    </section>
  );
}

const REFRESH_COPY = {
  no_mailbox: "Connect Gmail or Outlook with mail access first",
  too_few: "Not enough sent mail to learn from yet",
  failed: "Couldn’t read your style this time — try again?",
} as const;

/**
 * "Learned from your sent mail": the style profile Orbit distilled from the user's own sent
 * email (`@/lib/writing-style-profile`). Editable (their edit is then their text), refreshable,
 * and Turn off clears it and stops Orbit learning it again on its own.
 */
function LearnedStyle({ profile, onChange }: { profile: string | null; onChange: (p: string) => void }) {
  const id = useId();
  const [draft, setDraft] = useState(profile ?? "");
  const [busy, setBusy] = useState<"save" | "refresh" | "off" | null>(null);
  const dirty = Boolean(profile) && draft.trim() !== (profile ?? "").trim();

  async function refresh() {
    setBusy("refresh");
    try {
      const res = await refreshStyleProfile();
      if (res.status === "built") {
        onChange(res.profile);
        setDraft(res.profile);
        toast.success("Learned how you write");
      } else toast.error(REFRESH_COPY[res.status]);
    } catch (err) {
      toast.error(friendlyError(err, REFRESH_COPY.failed));
    } finally {
      setBusy(null);
    }
  }

  async function store(text: string, kind: "save" | "off") {
    setBusy(kind);
    try {
      const res = await saveStyleProfile(text);
      onChange(res.styleProfile);
      setDraft(res.styleProfile);
      toast.success(res.styleProfile ? "Style saved" : "Orbit won’t learn from your sent mail");
    } catch (err) {
      toast.error(friendlyError(err, "Couldn’t save that — try again?"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="mt-2 flex flex-col gap-2" aria-labelledby={`${id}-title`} role="group">
      <div>
        <h4 id={`${id}-title`} className="text-xs font-medium text-foreground">
          Learned from your sent mail
        </h4>
        <p id={`${id}-hint`} className="mt-0.5 text-xs text-muted-foreground">
          {profile
            ? "How Orbit thinks you write. Your notes above win where they differ."
            : profile === ""
              ? "Off. Orbit won’t read your sent mail to learn your style."
              : "After your first draft, Orbit reads about 20 recent sent emails to match your style. Only this description is kept."}
        </p>
      </div>
      {profile ? (
        <Textarea
          rows={5}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          maxLength={STYLE_PROFILE_MAX}
          disabled={busy !== null}
          aria-labelledby={`${id}-title`}
          aria-describedby={`${id}-hint`}
          className="min-h-[112px] resize-none text-xs"
        />
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        {profile ? (
          <Button type="button" variant="ghost" size="sm" onClick={() => store("", "off")} disabled={busy !== null}>
            {busy === "off" ? <Loader2 className="size-4 animate-spin" /> : "Turn off"}
          </Button>
        ) : null}
        <Button type="button" variant="outline" size="sm" onClick={refresh} disabled={busy !== null}>
          {busy === "refresh" ? (
            <Loader2 className="size-4 animate-spin" />
          ) : profile ? (
            "Refresh"
          ) : profile === "" ? (
            "Turn on"
          ) : (
            "Learn now"
          )}
        </Button>
        {dirty ? (
          <Button type="button" variant="outline" size="sm" onClick={() => store(draft, "save")} disabled={busy !== null}>
            {busy === "save" ? <Loader2 className="size-4 animate-spin" /> : "Save"}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
