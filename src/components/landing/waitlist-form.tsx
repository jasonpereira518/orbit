"use client";

import { useState } from "react";
import { useClerk } from "@clerk/nextjs";

const inputClass =
  "w-full rounded-xl border border-[#e8f3f1]/[0.14] bg-[#05070f]/50 px-4.5 py-3.5 text-[#e8f3f1] placeholder:text-[#6d807c] focus:border-[#f2c14e]/50 focus:outline-none";

const buttonClass =
  "w-full whitespace-nowrap rounded-xl bg-landing-button-surface px-4.5 py-3.5 font-medium text-landing-button-label transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60";

function ClerkWaitlistForm() {
  const clerk = useClerk();
  const [email, setEmail] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!email) return;
    setStatus("loading");
    try {
      await clerk.joinWaitlist({ emailAddress: email });
      setStatus("success");
    } catch {
      setStatus("error");
    }
  }

  if (status === "success") {
    return (
      <p className="text-sm text-[#e8f3f1]">
        You&apos;re on the list — we&apos;ll email you as spots open.
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
        placeholder="you@company.com"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        className={inputClass}
      />
      <button type="submit" disabled={status === "loading"} className={buttonClass}>
        {status === "loading" ? "Joining…" : "Join the waitlist"}
      </button>
      {status === "error" && (
        <p className="text-sm text-[#e8a84e]">
          Something went wrong — please try again.
        </p>
      )}
    </form>
  );
}

function DemoWaitlistForm() {
  const [submitted, setSubmitted] = useState(false);

  if (submitted) {
    return (
      <p className="text-sm text-[#e8f3f1]">
        Thanks! (Demo mode — no real waitlist entry was created.)
      </p>
    );
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        setSubmitted(true);
      }}
      className="space-y-3"
    >
      <label htmlFor="waitlist-email-demo" className="sr-only">
        Email address
      </label>
      <input
        id="waitlist-email-demo"
        type="email"
        required
        placeholder="you@company.com"
        className={inputClass}
      />
      <button type="submit" className={buttonClass}>
        Join the waitlist
      </button>
    </form>
  );
}

export function WaitlistForm({ clerkOn }: { clerkOn: boolean; demoMode?: boolean }) {
  return clerkOn ? <ClerkWaitlistForm /> : <DemoWaitlistForm />;
}
