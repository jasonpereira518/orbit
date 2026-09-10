"use client";

import { useEffect, useRef, useState } from "react";
import { joinInterestList } from "@/actions/interest-list";
import { cn } from "@/lib/utils";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-3.5 text-[#e8f3f1] placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "w-full whitespace-nowrap rounded-xl bg-landing-button-surface px-4.5 py-3.5 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * The finale's button. Outlined, in the page's secondary-button language — the same
 * treatment as the "Sign in" pill beside the CTA — because a solid fill made the mailing
 * list the second-brightest thing in a section whose job is one ask. The standalone
 * /interest page keeps the solid button: there, signing up IS the ask.
 */
const inlineButtonClass =
  "w-full whitespace-nowrap rounded-xl border border-[#e8f3f1]/20 bg-[#e8f3f1]/5 px-4.5 py-2.5 text-sm font-medium text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/35 hover:bg-[#e8f3f1]/10 disabled:cursor-not-allowed disabled:opacity-60 sm:w-auto sm:shrink-0";

/**
 * Talks to Orbit's own `joinInterestList` action, not Clerk's `joinWaitlist()`. That call
 * needs the whole instance's sign-up mode set to "Waitlist", which would block this app's
 * normal, already-live sign-up flow — so this owns its own table instead. No Clerk
 * dependency means demo mode can hit the real action against local PGlite like everything
 * else in demo mode does, rather than needing a separate no-op stub.
 */
export function WaitlistForm({
  variant = "stacked",
}: {
  /** "inline" puts the field and button on one row — for the finale, where the
   * interest list is a footnote under the CTA rather than a card beside it. */
  variant?: "stacked" | "inline";
} = {}) {
  const inline = variant === "inline";
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  // Set after mount, never during render: Date.now() on the server would not match the
  // client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, []);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!email) return;
    setStatus("loading");
    const data = new FormData(e.currentTarget);
    try {
      const result = await joinInterestList({
        email,
        website: String(data.get("website") ?? ""),
        elapsedMs: readyAt.current ? Date.now() - readyAt.current : 0,
      });
      setStatus(result.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <p className="text-sm text-[#e8f3f1]">
        You&apos;re in — we&apos;ll email you when there&apos;s news.
      </p>
    );
  }

  return (
    <form
      onSubmit={handleSubmit}
      className={inline ? "flex flex-col gap-2 sm:flex-row" : "space-y-3"}
    >
      <label htmlFor="waitlist-email" className="sr-only">
        Email address
      </label>
      <input
        id="waitlist-email"
        type="email"
        required
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={cn(inputClass, inline && "py-2.5 text-sm sm:flex-1")}
      />
      {/* Honeypot. Off-screen rather than display:none — some bots skip hidden fields but
          happily fill one that is merely positioned away. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="waitlist-website">Website</label>
        <input id="waitlist-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button
        type="submit"
        disabled={status === "loading"}
        className={inline ? inlineButtonClass : buttonClass}
      >
        {status === "loading" ? "Signing up…" : "Get updates"}
      </button>
      {status === "error" && (
        <p className="text-sm text-[#e8a84e]">
          Something went wrong — please try again.
        </p>
      )}
    </form>
  );
}
