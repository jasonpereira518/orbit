import { Plus } from "lucide-react";
import { FREE_CONTACT_LIMIT } from "@/lib/plan-limits";

/**
 * Native <details> rather than a scripted accordion: it is keyboard-operable, works
 * before hydration, and is findable by in-page search when closed in supporting browsers.
 */
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: `What happens when I reach ${FREE_CONTACT_LIMIT} contacts?`,
    a: "You stop being able to add new people — and that is all. Every contact, note, reminder, and interaction you already have stays fully visible and editable, forever. Orbit never hides your own network behind a paywall.",
  },
  {
    q: "Why do I need my own AI provider key?",
    a: "Capture, chat, and summaries run on a key you supply from Google, OpenAI, or Anthropic, on every plan including the paid ones. You pay your provider directly at cost, and Orbit never adds a margin to your tokens. It is also why the paid plans cost so little: you are paying for the parts that cost us money, not for AI resale.",
  },
  {
    q: "What is the difference between Orbit Pro and Orbit Lifetime?",
    a: "Everything except sending. Both are uncapped and both include recruiter tracking, mailbox and calendar sync, and the extension. Orbit Pro also sends outreach email and SMS on Orbit's own credits; Lifetime connects your own Apollo, Resend, and Twilio keys instead. Metered sending is the one thing a single payment cannot honestly cover forever.",
  },
  {
    q: "Can I cancel?",
    a: "Any time, and you keep Orbit Pro until the period you already paid for runs out. After that your account returns to the Free Plan — still holding every contact you added while subscribed, even if that is well past the free limit.",
  },
  {
    q: "What happens to my data if I stop paying?",
    a: "Nothing is deleted and nothing is hidden. You can export everything you have put into Orbit at any point, on any plan, including Free.",
  },
  {
    q: "Is Orbit Lifetime really limited?",
    a: "Yes — 100 people, then it retires. It exists because early users take a risk on an unfinished product, and everything it unlocks costs nothing per-user to run. That is what makes a one-time price something we can actually honour.",
  },
];

export function PricingFaq() {
  return (
    <div className="mx-auto max-w-3xl divide-y divide-[#e8f3f1]/[0.08] border-y border-[#e8f3f1]/[0.08]">
      {FAQ.map((item) => (
        <details key={item.q} className="group">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-6 py-5 text-left text-[#e8f3f1] transition-colors hover:text-[#f2c14e] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[#f2c14e] [&::-webkit-details-marker]:hidden">
            <span className="text-base">{item.q}</span>
            <Plus
              className="size-4 shrink-0 text-[#6d807c] transition-transform duration-300 ease-out group-open:rotate-45"
              aria-hidden="true"
            />
          </summary>
          <p className="max-w-[68ch] pb-5 text-sm leading-relaxed text-[#9aada8]">
            {item.a}
          </p>
        </details>
      ))}
    </div>
  );
}
