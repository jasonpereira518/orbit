import { useState } from "react";
import { Check, ChevronDown, Sparkles } from "lucide-react";
import type { ContactFieldSuggestion, PageContext } from "@contract";
import type { OrbitApi } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { StarterList } from "../components/StarterList";
import { Badge, Button } from "../components/ui";
import type { PanelState } from "../state/usePanel";

type Editable = Pick<
  ContactFieldSuggestion,
  "fullName" | "company" | "title" | "location" | "email"
>;

const FIELDS: { key: keyof Editable; label: string }[] = [
  { key: "fullName", label: "Name" },
  { key: "title", label: "Title" },
  { key: "company", label: "Company" },
  { key: "location", label: "Location" },
  { key: "email", label: "Email" },
];

/**
 * One-click save, with the parsed fields tucked behind a "Refine" expander.
 * Fast by default, correctable when the extraction got something wrong.
 */
export function UnknownPersonView({
  page,
  state,
  api,
  onSaved,
}: {
  page: PageContext;
  state: PanelState;
  api: OrbitApi;
  onSaved: () => void;
}) {
  const suggested = state.resolved?.suggested;
  const [fields, setFields] = useState<Editable>({
    fullName: suggested?.fullName ?? "",
    company: suggested?.company ?? "",
    title: suggested?.title ?? "",
    location: suggested?.location ?? "",
    email: suggested?.email ?? "",
  });
  const [howMet, setHowMet] = useState("");
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async (force = false) => {
    if (!fields.fullName?.trim()) {
      setOpen(true);
      setError("A name is required.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await api.saveContact({
        mode: "create",
        page,
        force,
        fields: {
          fullName: fields.fullName.trim(),
          company: fields.company?.trim() || undefined,
          title: fields.title?.trim() || undefined,
          location: fields.location?.trim() || undefined,
          email: fields.email?.trim() || undefined,
          linkedinUrl: suggested?.linkedinUrl ?? undefined,
          xHandle: suggested?.xHandle ?? undefined,
          photoUrl: suggested?.photoUrl ?? undefined,
          howMet: howMet.trim() || suggested?.howMet || undefined,
          tagNames: suggested?.tagNames ?? undefined,
        },
      });
      onSaved();
    } catch (err) {
      const apiError = err as ApiError;
      setError(
        apiError.code === "duplicate"
          ? "Looks like they're already in your orbit."
          : apiError.message
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="scroll-area reveal-stagger flex-1 space-y-3 px-4 py-3">
        <Badge tone="primary">New to your orbit</Badge>

        <StarterList
          starters={state.starters}
          loading={state.startersLoading}
          degraded={state.startersDegraded}
        />

        <div>
          <button
            onClick={() => setOpen((v) => !v)}
            className="flex w-full items-center justify-between rounded-[var(--radius)] px-1 py-1.5 text-[12px] text-[var(--muted-foreground)] hover:bg-[var(--accent)]"
          >
            <span className="inline-flex items-center gap-1.5">
              <Sparkles size={12} />
              Refine what Orbit saves
            </span>
            <ChevronDown
              size={14}
              className={open ? "rotate-180 transition-transform" : "transition-transform"}
            />
          </button>

          {open ? (
            <div className="mt-2 space-y-2">
              {FIELDS.map((f) => (
                <label key={f.key} className="block">
                  <span className="text-[11px] text-[var(--muted-foreground)]">
                    {f.label}
                  </span>
                  <input
                    value={fields[f.key] ?? ""}
                    onChange={(e) =>
                      setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                    }
                    className="mt-0.5 w-full rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
                  />
                </label>
              ))}
              <label className="block">
                <span className="text-[11px] text-[var(--muted-foreground)]">
                  How you met
                </span>
                <textarea
                  rows={2}
                  value={howMet}
                  onChange={(e) => setHowMet(e.target.value)}
                  placeholder="Where does this person fit? (optional)"
                  className="mt-0.5 w-full resize-none rounded-[var(--radius)] border border-[var(--border)] bg-[var(--card)] px-2 py-1.5 text-[13px] outline-none focus:border-[var(--ring)]"
                />
              </label>
            </div>
          ) : null}
        </div>

        {error ? (
          <p className="text-[12px] text-[var(--destructive)]">{error}</p>
        ) : null}
      </div>

      <div className="border-t border-[var(--border)] p-3">
        <Button
          className="w-full"
          onClick={() => save(false)}
          disabled={busy}
        >
          <Check size={14} />
          {busy ? "Adding…" : "Add to network"}
        </Button>
      </div>
    </>
  );
}
