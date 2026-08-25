"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { Check, Loader2, Send } from "lucide-react";
import { submitContactMessage } from "@/actions/contact";
import {
  CONTACT_TOPICS,
  MESSAGE_MAX,
  type ContactTopic,
} from "@/lib/contact-message";
import { cn } from "@/lib/utils";

const fieldClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#03050c]/60 px-4 py-3 text-[15px] text-[#e8f3f1] transition-colors placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";
const labelClass = "block text-[13px] text-[#9aada8]";
const errorClass = "mt-1.5 text-[13px] text-[#e8a84e]";

type Errors = Partial<Record<string, string>>;

export function ContactForm() {
  const [topic, setTopic] = useState<ContactTopic>("bug");
  const [message, setMessage] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, startTransition] = useTransition();

  // Set after mount, never during render: Date.now() on the server would not
  // match the client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, [sent]);

  if (sent) {
    return (
      <div className="landing-glass rounded-3xl p-8 text-center sm:p-10">
        <span className="mx-auto flex h-11 w-11 items-center justify-center rounded-full border border-[#f2c14e]/30 bg-[#f2c14e]/[0.1]">
          <Check className="h-5 w-5 text-landing-accent" aria-hidden="true" />
        </span>
        <p
          role="status"
          className="mt-5 font-[family-name:var(--font-display)] text-xl tracking-tight text-[#e8f3f1]"
        >
          Message sent.
        </p>
        <p className="mx-auto mt-2 max-w-[36ch] text-sm leading-[1.65] text-[#9aada8]">
          It lands in a real inbox, not a queue. Expect a reply from Jason
          within a few days.
        </p>
        <button
          type="button"
          onClick={() => {
            setSent(false);
            setMessage("");
            setErrors({});
            setFormError(null);
          }}
          className="mt-6 text-sm text-landing-accent underline decoration-[#f2c14e]/35 underline-offset-4 transition-colors hover:decoration-[#f2c14e]/90"
        >
          Send another
        </button>
      </div>
    );
  }

  return (
    <form
      noValidate
      className="landing-glass rounded-3xl p-6 sm:p-8"
      onSubmit={(event) => {
        event.preventDefault();
        const data = new FormData(event.currentTarget);
        setErrors({});
        setFormError(null);

        startTransition(async () => {
          const result = await submitContactMessage({
            name: String(data.get("name") ?? ""),
            email: String(data.get("email") ?? ""),
            topic,
            message: String(data.get("message") ?? ""),
            website: String(data.get("website") ?? ""),
            elapsedMs: readyAt.current ? Date.now() - readyAt.current : 0,
          });

          if (result.ok) {
            setSent(true);
            return;
          }
          setErrors(result.fieldErrors ?? {});
          setFormError(result.message);
        });
      }}
    >
      <p className="text-xs uppercase tracking-[0.16em] text-landing-accent">
        Send a message
      </p>

      <div className="mt-5 grid gap-4 sm:grid-cols-2">
        <div>
          <label className={labelClass} htmlFor="contact-name">
            Your name
          </label>
          <input
            id="contact-name"
            name="name"
            autoComplete="name"
            maxLength={80}
            placeholder="Priya Raman"
            aria-invalid={Boolean(errors.name)}
            aria-describedby={errors.name ? "contact-name-error" : undefined}
            className={cn("mt-1.5", fieldClass, errors.name && "border-[#e8a84e]/60")}
          />
          {errors.name && (
            <p id="contact-name-error" className={errorClass}>
              {errors.name}
            </p>
          )}
        </div>

        <div>
          <label className={labelClass} htmlFor="contact-email">
            Email to reply to
          </label>
          <input
            id="contact-email"
            name="email"
            type="email"
            autoComplete="email"
            maxLength={160}
            placeholder="you@company.com"
            aria-invalid={Boolean(errors.email)}
            aria-describedby={errors.email ? "contact-email-error" : undefined}
            className={cn("mt-1.5", fieldClass, errors.email && "border-[#e8a84e]/60")}
          />
          {errors.email && (
            <p id="contact-email-error" className={errorClass}>
              {errors.email}
            </p>
          )}
        </div>
      </div>

      <fieldset className="mt-5">
        <legend className={labelClass}>What is this about?</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {CONTACT_TOPICS.map((option) => {
            const active = option.value === topic;
            return (
              <button
                key={option.value}
                type="button"
                aria-pressed={active}
                onClick={() => setTopic(option.value)}
                className={cn(
                  "rounded-full border px-3.5 py-1.5 text-[13px] transition-colors",
                  active
                    ? "border-[#f2c14e]/45 bg-[#f2c14e]/[0.1] text-[#e8f3f1]"
                    : "border-[#e8f3f1]/[0.14] text-[#9aada8] hover:border-[#e8f3f1]/30 hover:text-[#e8f3f1]"
                )}
              >
                {option.label}
              </button>
            );
          })}
        </div>
      </fieldset>

      <div className="mt-5">
        <div className="flex items-baseline justify-between gap-3">
          <label className={labelClass} htmlFor="contact-message">
            Your message
          </label>
          <span
            className={cn(
              "text-[12px] tabular-nums",
              message.length > MESSAGE_MAX ? "text-[#e8a84e]" : "text-[#6d807c]"
            )}
          >
            {message.length}/{MESSAGE_MAX}
          </span>
        </div>
        <textarea
          id="contact-message"
          name="message"
          rows={5}
          maxLength={MESSAGE_MAX}
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          placeholder="What happened, what you expected, and roughly when — or just the question."
          aria-invalid={Boolean(errors.message)}
          aria-describedby={errors.message ? "contact-message-error" : undefined}
          className={cn(
            "mt-1.5 resize-y",
            fieldClass,
            errors.message && "border-[#e8a84e]/60"
          )}
        />
        {errors.message && (
          <p id="contact-message-error" className={errorClass}>
            {errors.message}
          </p>
        )}
      </div>

      {/* Honeypot. Off-screen rather than display:none — some bots skip hidden
          fields but happily fill one that is merely positioned away. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="contact-website">Website</label>
        <input id="contact-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending}
          className="inline-flex items-center justify-center gap-2 rounded-full bg-[#e8f3f1] px-5 py-3 text-sm font-medium text-[#0f3d3e] transition-colors hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
        >
          {pending ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Sending…
            </>
          ) : (
            <>
              <Send className="h-4 w-4" aria-hidden="true" />
              Send message
            </>
          )}
        </button>
        <p className="text-xs leading-[1.6] text-[#6d807c]">
          Goes to a personal inbox. Your address is used to reply, nothing else.
        </p>
      </div>

      {formError && (
        <p role="alert" className="mt-4 text-sm text-[#e8a84e]">
          {formError}
        </p>
      )}
    </form>
  );
}
