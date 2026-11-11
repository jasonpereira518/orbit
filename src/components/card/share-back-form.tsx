"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Download, Loader2 } from "lucide-react";
import { shareBackToCard } from "@/actions/card-public";
import { cn } from "@/lib/utils";

const fieldClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#03050c]/60 px-4 py-3 text-base text-[#e8f3f1] transition-colors placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none focus-visible:ring-3 focus-visible:ring-[#f2c14e]/70";
const labelClass = "block text-[13px] text-[#9aada8]";
const errorClass = "mt-1.5 text-[13px] text-[#e8a84e]";

type FieldName = "name" | "email" | "phone" | "company" | "title" | "linkedinUrl" | "message";

const FIELDS: {
  name: Exclude<FieldName, "message">;
  label: string;
  type?: string;
  autoComplete: string;
  maxLength: number;
}[] = [
  { name: "name", label: "Your name (required)", autoComplete: "name", maxLength: 120 },
  { name: "email", label: "Email", type: "email", autoComplete: "email", maxLength: 320 },
  { name: "phone", label: "Phone", type: "tel", autoComplete: "tel", maxLength: 50 },
  { name: "company", label: "Company", autoComplete: "organization", maxLength: 200 },
  { name: "title", label: "Role", autoComplete: "organization-title", maxLength: 200 },
  { name: "linkedinUrl", label: "LinkedIn", type: "url", autoComplete: "url", maxLength: 500 },
];

export function ShareBackForm({ slug, firstName }: { slug: string; firstName: string }) {
  const [errors, setErrors] = useState<Partial<Record<string, string>>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  // Set after mount, never during render: a server value would not match the client's.
  const readyAt = useRef(0);
  const nonce = useRef("");
  useEffect(() => {
    readyAt.current = Date.now();
    nonce.current = crypto.randomUUID();
  }, []);

  if (done) {
    return (
      <div className="landing-glass rounded-3xl p-6 text-center">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#f2c14e]/30 bg-[#f2c14e]/[0.1]">
          <Check className="h-5 w-5 text-landing-accent" aria-hidden="true" />
        </span>
        <p role="status" className="mt-4 font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
          {firstName} has your details.
        </p>
        <a
          href={`/c/${slug}/vcard`}
          className="mt-5 inline-flex min-h-12 items-center justify-center gap-2 rounded-full border border-[#e8f3f1]/[0.18] px-5 text-sm text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/40"
        >
          <Download className="h-4 w-4" aria-hidden="true" />
          Save contact again
        </a>
      </div>
    );
  }

  return (
    <form
      noValidate
      aria-labelledby="share-back-heading"
      className="landing-glass rounded-3xl p-5"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        const text = (key: string) => String(data.get(key) ?? "");
        setErrors({});
        setFormError(null);
        startTransition(async () => {
          const result = await shareBackToCard({
            slug,
            nonce: nonce.current,
            name: text("name"),
            email: text("email"),
            phone: text("phone"),
            company: text("company"),
            title: text("title"),
            linkedinUrl: text("linkedinUrl"),
            message: text("message"),
            website: text("website"),
            elapsedMs: readyAt.current ? Date.now() - readyAt.current : 0,
          });
          if (result.ok) {
            setDone(true);
            return;
          }
          setErrors(result.fieldErrors ?? {});
          setFormError(result.message);
        });
      }}
    >
      <h2 id="share-back-heading" className="font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]">
        Share your details with {firstName}
      </h2>
      <p className="mt-1 text-[13px] text-[#9aada8]">An email or phone number lets {firstName} reach you.</p>

      <div className="mt-5 grid gap-4">
        {FIELDS.map((f) => (
          <div key={f.name}>
            <label className={labelClass} htmlFor={`share-${f.name}`}>
              {f.label}
            </label>
            <input
              id={`share-${f.name}`}
              name={f.name}
              type={f.type ?? "text"}
              autoComplete={f.autoComplete}
              maxLength={f.maxLength}
              required={f.name === "name"}
              aria-invalid={Boolean(errors[f.name])}
              aria-describedby={errors[f.name] ? `share-${f.name}-error` : undefined}
              className={cn("mt-1.5", fieldClass, errors[f.name] && "border-[#e8a84e]/60")}
            />
            {errors[f.name] && (
              <p id={`share-${f.name}-error`} className={errorClass}>
                {errors[f.name]}
              </p>
            )}
          </div>
        ))}
        <div>
          <label className={labelClass} htmlFor="share-message">
            Anything to remember?
          </label>
          <textarea
            id="share-message"
            name="message"
            rows={3}
            maxLength={500}
            aria-invalid={Boolean(errors.message)}
            aria-describedby={errors.message ? "share-message-error" : undefined}
            className={cn("mt-1.5 resize-y", fieldClass, errors.message && "border-[#e8a84e]/60")}
          />
          {errors.message && (
            <p id="share-message-error" className={errorClass}>
              {errors.message}
            </p>
          )}
        </div>
      </div>

      {/* Honeypot. Off-screen rather than display:none — some bots skip hidden fields. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="share-website">Website</label>
        <input id="share-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <button
        type="submit"
        disabled={pending}
        className="mt-6 inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#e8f3f1] px-5 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
        {pending ? "Sending…" : `Send to ${firstName}`}
      </button>

      {formError && (
        <p role="alert" className="mt-4 text-sm text-[#e8a84e]">
          {formError}
        </p>
      )}
    </form>
  );
}
