"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { parseCaptureNotes, confirmCapture } from "@/actions/capture";
import type { ParsedNote } from "@/lib/ai";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";

type Dup = {
  id: string;
  fullName: string;
  company: string | null;
  title: string | null;
  reason: string;
  confidence: number;
};

export function CaptureForm() {
  const router = useRouter();
  const [notes, setNotes] = useState("");
  const [step, setStep] = useState<"paste" | "review">("paste");
  const [parsed, setParsed] = useState<ParsedNote | null>(null);
  const [duplicates, setDuplicates] = useState<Dup[]>([]);
  const [mergeId, setMergeId] = useState<string | null>(null);
  const [createReminder, setCreateReminder] = useState(true);
  const [score, setScore] = useState(2);
  const [tags, setTags] = useState("");
  const [followUpDays, setFollowUpDays] = useState(14);
  const [pending, start] = useTransition();

  return (
    <div className="space-y-6">
      {step === "paste" && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
          <div>
            <Label htmlFor="notes">Paste rough notes</Label>
            <Textarea
              id="notes"
              className="mt-2 min-h-[200px]"
              placeholder="Met Sarah Chen at AWS Summit. She works at OpenAI on Codex partnerships..."
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
            />
          </div>
          <Button
            disabled={pending || !notes.trim()}
            className="bg-[#0f3d3e] hover:bg-[#0c3233]"
            onClick={() =>
              start(async () => {
                try {
                  const res = await parseCaptureNotes(notes);
                  setParsed(res.parsed);
                  setDuplicates(res.duplicates);
                  setScore(res.parsed.relationship_score_suggestion || 2);
                  setTags((res.parsed.tags || []).join(", "));
                  setFollowUpDays(res.parsed.follow_up_days || 14);
                  setCreateReminder(Boolean(res.parsed.follow_up_recommendation));
                  setMergeId(res.duplicates[0]?.id ?? null);
                  setStep("review");
                } catch (err) {
                  toast.error(
                    err instanceof Error ? err.message : "Failed to parse notes"
                  );
                }
              })
            }
          >
            {pending ? "Parsing…" : "Extract with AI"}
          </Button>
        </div>
      )}

      {step === "review" && parsed && (
        <div className="space-y-4 rounded-2xl border border-border/70 bg-white p-6">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-[#0f3d3e]">Review extraction</h2>
            <Button variant="ghost" onClick={() => setStep("paste")}>
              Back
            </Button>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Name">
              <Input
                value={parsed.name || ""}
                onChange={(e) => setParsed({ ...parsed, name: e.target.value })}
              />
            </Field>
            <Field label="Company">
              <Input
                value={parsed.company || ""}
                onChange={(e) => setParsed({ ...parsed, company: e.target.value })}
              />
            </Field>
            <Field label="Role">
              <Input
                value={parsed.role || ""}
                onChange={(e) => setParsed({ ...parsed, role: e.target.value })}
              />
            </Field>
            <Field label="Met at">
              <Input
                value={parsed.met_at || ""}
                onChange={(e) => setParsed({ ...parsed, met_at: e.target.value })}
              />
            </Field>
          </div>

          <Field label="Summary">
            <Textarea
              value={parsed.summary || ""}
              onChange={(e) => setParsed({ ...parsed, summary: e.target.value })}
            />
          </Field>

          <div className="flex flex-wrap gap-2">
            {(parsed.topics || []).map((t) => (
              <Badge key={t} variant="secondary">
                {t}
              </Badge>
            ))}
          </div>

          {duplicates.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50/50 p-4">
              <p className="mb-2 text-sm font-medium">Possible duplicates</p>
              <div className="space-y-2">
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="radio"
                    name="merge"
                    checked={!mergeId}
                    onChange={() => setMergeId(null)}
                  />
                  Create new contact
                </label>
                {duplicates.map((d) => (
                  <label key={d.id} className="flex items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="merge"
                      checked={mergeId === d.id}
                      onChange={() => setMergeId(d.id)}
                    />
                    Merge into {d.fullName}
                    {d.company ? ` (${d.company})` : ""} — {d.reason}
                  </label>
                ))}
              </div>
            </div>
          )}

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Closeness score">
              <Input
                type="number"
                min={1}
                max={5}
                value={score}
                onChange={(e) => setScore(Number(e.target.value))}
              />
            </Field>
            <Field label="Follow-up days">
              <Input
                type="number"
                min={1}
                value={followUpDays}
                onChange={(e) => setFollowUpDays(Number(e.target.value))}
              />
            </Field>
            <Field label="Tags">
              <Input value={tags} onChange={(e) => setTags(e.target.value)} />
            </Field>
          </div>

          {parsed.follow_up_recommendation && (
            <p className="text-sm text-muted-foreground">
              Suggested: {parsed.follow_up_recommendation}
            </p>
          )}

          <label className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={createReminder}
              onCheckedChange={(v) => setCreateReminder(Boolean(v))}
            />
            Create follow-up reminder (you confirm — AI only suggests)
          </label>

          <Button
            disabled={pending}
            className="bg-[#0f3d3e] hover:bg-[#0c3233]"
            onClick={() =>
              start(async () => {
                try {
                  const res = await confirmCapture({
                    notes,
                    parsed,
                    mergeContactId: mergeId,
                    createReminder,
                    relationshipScore: score,
                    tagNames: tags
                      .split(",")
                      .map((t) => t.trim())
                      .filter(Boolean),
                    followUpDays,
                  });
                  toast.success("Saved to your network");
                  router.push(`/contacts/${res.contactId}`);
                  router.refresh();
                } catch (err) {
                  toast.error(err instanceof Error ? err.message : "Save failed");
                }
              })
            }
          >
            {pending ? "Saving…" : "Confirm & save"}
          </Button>
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
