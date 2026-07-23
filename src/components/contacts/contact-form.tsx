"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "@/lib/toast";
import {
  createContact,
  getContactFieldSuggestions,
  lookupLinkedInProfile,
  updateContact,
  type ContactFieldSuggestions,
  type ContactInput,
} from "@/actions/contacts";
import { MET_CONTEXTS, MET_CONTEXT_LABELS, type MetContext } from "@/lib/met-context";
import { SuggestInput } from "@/components/contacts/suggest-input";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";

const EMPTY_SUGGESTIONS: ContactFieldSuggestions = {
  locations: [],
  schools: [],
  locationBySchool: {},
  schoolByLocation: {},
};

function looksLikeLinkedInProfile(url: string) {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(
      trimmed.startsWith("http") ? trimmed : `https://${trimmed}`
    );
    const host = parsed.hostname.replace(/^www\./i, "").toLowerCase();
    return host === "linkedin.com" && /\/in\//i.test(parsed.pathname);
  } catch {
    return /linkedin\.com\/in\//i.test(trimmed);
  }
}

export function ContactForm({
  initial,
  contactId,
  className,
  onSuccess,
}: {
  initial?: Partial<ContactInput> & { tags?: string[] };
  contactId?: string;
  className?: string;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [lookingUp, setLookingUp] = useState(false);
  const lastLookupUrl = useRef<string>("");
  const [suggestions, setSuggestions] =
    useState<ContactFieldSuggestions>(EMPTY_SUGGESTIONS);
  const [form, setForm] = useState({
    fullName: initial?.fullName || "",
    preferredName: initial?.preferredName || "",
    title: initial?.title || "",
    company: initial?.company || "",
    location: initial?.location || "",
    school: initial?.school || "",
    metContext: (initial?.metContext as MetContext | "") || "",
    dateMet: initial?.dateMet
      ? String(initial.dateMet).slice(0, 10)
      : "",
    howMet: initial?.howMet || "",
    email: initial?.email || "",
    phone: initial?.phone || "",
    linkedinUrl: initial?.linkedinUrl || "",
    website: initial?.website || "",
    notes: initial?.notes || "",
    industry: initial?.industry || "",
    sharedInterests: (initial?.sharedInterests || []).join("\n"),
    relationshipScore: initial?.relationshipScore ?? 2,
    priorityLevel: initial?.priorityLevel ?? 0,
    tagNames: (initial?.tagNames || initial?.tags || []).join(", "),
  });

  useEffect(() => {
    let cancelled = false;
    getContactFieldSuggestions()
      .then((data) => {
        if (!cancelled) setSuggestions(data);
      })
      .catch(() => {
        /* suggestions are optional */
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function set<K extends keyof typeof form>(key: K, value: (typeof form)[K]) {
    setForm((f) => ({ ...f, [key]: value }));
  }

  function selectLocation(value: string) {
    setForm((f) => {
      const next = { ...f, location: value };
      if (!f.school.trim()) {
        const paired = suggestions.schoolByLocation[value.toLowerCase()];
        if (paired) next.school = paired;
      }
      return next;
    });
  }

  function selectSchool(value: string) {
    setForm((f) => {
      const next = { ...f, school: value };
      if (!f.location.trim()) {
        const paired = suggestions.locationBySchool[value.toLowerCase()];
        if (paired) next.location = paired;
      }
      return next;
    });
  }

  async function autofillFromLinkedIn(url: string) {
    const trimmed = url.trim();
    if (!looksLikeLinkedInProfile(trimmed)) return;
    if (trimmed === lastLookupUrl.current || lookingUp) return;

    lastLookupUrl.current = trimmed;
    setLookingUp(true);
    try {
      const profile = await lookupLinkedInProfile({
        linkedinUrl: trimmed,
        fullName: form.fullName,
        email: form.email,
      });
      if (!profile) {
        toast.message("No LinkedIn profile match found");
        return;
      }

      setForm((f) => {
        const next = { ...f };
        // Role is the primary autofill; always take LinkedIn title when present.
        if (profile.title) next.title = profile.title;
        if (profile.company && !f.company.trim()) next.company = profile.company;
        if (profile.location && !f.location.trim())
          next.location = profile.location;
        if (profile.school && !f.school.trim()) next.school = profile.school;
        if (profile.email && !f.email.trim()) next.email = profile.email;
        if (profile.linkedinUrl) next.linkedinUrl = profile.linkedinUrl;
        return next;
      });

      if (profile.title) {
        toast.success(`Role filled: ${profile.title}`);
      } else {
        toast.message("LinkedIn profile found, but no role listed");
      }
    } catch (err) {
      lastLookupUrl.current = "";
      toast.error(
        err instanceof Error ? err.message : "Could not look up LinkedIn"
      );
    } finally {
      setLookingUp(false);
    }
  }

  return (
    <form
      className={cn(
        "space-y-4 rounded-2xl border border-border/70 bg-card p-6",
        className
      )}
      onSubmit={(e) => {
        e.preventDefault();
        start(async () => {
          try {
            const payload: ContactInput = {
              fullName: form.fullName.trim(),
              preferredName: form.preferredName.trim(),
              title: form.title.trim(),
              company: form.company.trim(),
              location: form.location.trim(),
              school: form.school.trim(),
              metContext: form.metContext || undefined,
              dateMet: form.dateMet || null,
              howMet: form.howMet.trim(),
              email: form.email.trim(),
              phone: form.phone.trim(),
              linkedinUrl: form.linkedinUrl.trim(),
              website: form.website.trim(),
              notes: form.notes.trim(),
              industry: form.industry.trim(),
              sharedInterests: form.sharedInterests
                .split(/[\n,]/)
                .map((t) => t.trim())
                .filter(Boolean),
              relationshipScore: Number(form.relationshipScore),
              priorityLevel: Number(form.priorityLevel),
              tagNames: form.tagNames
                .split(",")
                .map((t) => t.trim())
                .filter(Boolean),
            };
            if (contactId) {
              await updateContact(contactId, payload);
              toast.success("Contact updated");
              onSuccess?.();
              router.push(`/contacts/${contactId}`);
            } else {
              const c = await createContact(payload);
              toast.success("Contact created");
              onSuccess?.();
              router.push(`/contacts/${c.id}`);
            }
            router.refresh();
          } catch (err) {
            toast.error(err instanceof Error ? err.message : "Failed to save");
          }
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Full name" required>
          <Input
            required
            value={form.fullName}
            onChange={(e) => set("fullName", e.target.value)}
            placeholder="Jason Pereira"
          />
        </Field>
        <Field label="Preferred name">
          <Input
            value={form.preferredName}
            onChange={(e) => set("preferredName", e.target.value)}
            placeholder="Jason"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="LinkedIn URL"
          hint={
            lookingUp
              ? "Looking up profile…"
              : "Paste a profile URL to autofill role"
          }
        >
          <Input
            type="url"
            value={form.linkedinUrl}
            onChange={(e) => {
              lastLookupUrl.current = "";
              set("linkedinUrl", e.target.value);
            }}
            onBlur={(e) => {
              void autofillFromLinkedIn(e.target.value);
            }}
            placeholder="https://linkedin.com/in/..."
            disabled={lookingUp}
          />
        </Field>
        <Field label="Website">
          <Input
            type="url"
            value={form.website}
            onChange={(e) => set("website", e.target.value)}
            placeholder="https://jasonpereira.live"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Company">
          <Input
            value={form.company}
            onChange={(e) => set("company", e.target.value)}
            placeholder="Amazon Web Services (AWS)"
          />
        </Field>
        <Field label="Role" hint="Autofills from LinkedIn when available">
          <Input
            value={form.title}
            onChange={(e) => set("title", e.target.value)}
            placeholder="Solutions Architect intern"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Location">
          <SuggestInput
            value={form.location}
            onChange={(v) => set("location", v)}
            onSelect={selectLocation}
            suggestions={suggestions.locations}
            placeholder="New York, NY"
          />
        </Field>
        <Field label="School">
          <SuggestInput
            value={form.school}
            onChange={(v) => set("school", v)}
            onSelect={selectSchool}
            suggestions={suggestions.schools}
            placeholder="Columbia University"
          />
        </Field>
      </div>
      <div className="space-y-4 rounded-xl border border-border/60 bg-muted/20 p-4">
        <div>
          <p className="text-sm font-medium text-primary">How you met</p>
          <p className="mt-0.5 text-xs text-muted-foreground">
            Context, when it happened, and any details you want to remember.
          </p>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Context">
            <select
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
              value={form.metContext}
              onChange={(e) =>
                set("metContext", e.target.value as MetContext | "")
              }
            >
              <option value="">Select…</option>
              {MET_CONTEXTS.map((value) => (
                <option key={value} value={value}>
                  {MET_CONTEXT_LABELS[value]}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Date met">
            <Input
              type="date"
              value={form.dateMet}
              onChange={(e) => set("dateMet", e.target.value)}
            />
          </Field>
        </div>
        <Field label="Details">
          <Textarea
            rows={2}
            value={form.howMet}
            onChange={(e) => set("howMet", e.target.value)}
            placeholder="Google NYC event, introduced by Alex, coffee chat about internships…"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Email">
          <Input
            type="email"
            value={form.email}
            onChange={(e) => set("email", e.target.value)}
            placeholder="jason@orbit.com"
          />
        </Field>
        <Field label="Phone">
          <Input
            type="tel"
            value={form.phone}
            onChange={(e) => set("phone", e.target.value)}
            placeholder="+1 555 123 4567"
          />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Closeness (1–5)">
          <Input
            type="number"
            min={1}
            max={5}
            value={form.relationshipScore}
            onChange={(e) => set("relationshipScore", Number(e.target.value))}
          />
        </Field>
        <Field label="Priority (0–3)">
          <Input
            type="number"
            min={0}
            max={3}
            value={form.priorityLevel}
            onChange={(e) => set("priorityLevel", Number(e.target.value))}
          />
        </Field>
      </div>
      <Field label="Industry">
        <Input
          value={form.industry}
          onChange={(e) => set("industry", e.target.value)}
          placeholder="Cloud computing, venture capital…"
        />
      </Field>
      <Field label="Shared interests (one per line)">
        <Textarea
          rows={3}
          value={form.sharedInterests}
          onChange={(e) => set("sharedInterests", e.target.value)}
          placeholder={"AI agents\nClimbing\nStartups"}
        />
      </Field>
      <Field label="Tags (comma-separated)">
        <Input
          value={form.tagNames}
          onChange={(e) => set("tagNames", e.target.value)}
          placeholder="AI, OpenAI, internship"
        />
      </Field>
      <Field label="Notes">
        <Textarea
          rows={4}
          value={form.notes}
          onChange={(e) => set("notes", e.target.value)}
        />
      </Field>
      <Button
        type="submit"
        disabled={pending || lookingUp}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
      >
        {pending ? "Saving…" : contactId ? "Save changes" : "Create contact"}
      </Button>
    </form>
  );
}

function Field({
  label,
  children,
  required,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
}) {
  return (
    <div className="space-y-1.5">
      <Label>
        {label}
        {required ? " *" : ""}
      </Label>
      {children}
      {hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
