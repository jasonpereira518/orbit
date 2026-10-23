"use client";

import { useEffect, useRef, useState } from "react";
import { joinInterestList } from "@/actions/interest-list";
import { readPageviewSessionId } from "@/lib/pageview-session";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-3.5 text-[#e8f3f1] placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none focus-visible:ring-3 focus-visible:ring-[#f2c14e]/70";

const buttonClass =
  "w-full whitespace-nowrap rounded-xl bg-landing-button-surface px-4.5 py-3.5 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

/**
 * Talks to Orbit's own `joinInterestList` action, not Clerk's `joinWaitlist()`. That call
 * needs the whole instance's sign-up mode set to "Waitlist", which would block this app's
 * normal, already-live sign-up flow — so this owns its own table instead. No Clerk
 * dependency means demo mode can hit the real action against local PGlite like everything
 * else in demo mode does, rather than needing a separate no-op stub.
 */
export function WaitlistForm() {
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  // Set after mount, never during render: Date.now() on the server would not match the
  // client's and would trip hydration.
  const readyAt = useRef(0);
  useEffect(() => {
    readyAt.current = Date.now();
  }, []);

  // The form, and the button that had focus, are gone once this succeeds. Move focus to the
  // confirmation so it is read out and keyboard users aren't dropped back at the page top.
  const successRef = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (status === "success") successRef.current?.focus();
  }, [status]);

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
        // The per-tab analytics id (null when storage is blocked), so the sign-up can be tied to
        // the page it came from without a cookie. See joinSessionId on the waitlist row.
        sessionId: readPageviewSessionId(),
      });
      setStatus(result.ok ? "success" : "error");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <p
        ref={successRef}
        role="status"
        tabIndex={-1}
        className="text-sm text-[#e8f3f1] outline-none"
      >
        You&apos;re in — we&apos;ll email you when there&apos;s news.
      </p>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <label htmlFor="waitlist-email" className="sr-only">
        Email address
      </label>
      <input
        id="waitlist-email"
        type="email"
        required
        autoComplete="email"
        aria-invalid={status === "error" || undefined}
        aria-describedby={status === "error" ? "waitlist-error" : undefined}
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={inputClass}
      />
      {/* Honeypot. Off-screen rather than display:none — some bots skip hidden fields but
          happily fill one that is merely positioned away. */}
      <div aria-hidden="true" className="absolute left-[-9999px] top-auto h-px w-px overflow-hidden">
        <label htmlFor="waitlist-website">Website</label>
        <input id="waitlist-website" name="website" tabIndex={-1} autoComplete="off" />
      </div>
      <button type="submit" disabled={status === "loading"} className={buttonClass}>
        {status === "loading" ? "Signing up…" : "Get updates"}
      </button>
      {status === "error" && (
        <p id="waitlist-error" role="alert" className="text-sm text-[#e8a84e]">
          Something went wrong — please try again.
        </p>
      )}
    </form>
  );
}
