import { Plus } from "lucide-react";
import {
  FREE_CONTACT_LIMIT,
  LIFETIME_INTRO_PRICE,
  LIFETIME_INTRO_SEATS,
  LIFETIME_STANDARD_PRICE,
} from "@/lib/plan-limits";

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
    a: "One thing: contact enrichment. Both are uncapped, both include recruiter tracking, mailbox and calendar sync, the extension, and outreach campaigns that send email and SMS on Orbit's own credits. Orbit Pro also enriches contacts on Orbit's Apollo credits; Lifetime connects your own Apollo key instead. Sending is capped at a fixed number per day on every plan, so a single payment can cover it. Enrichment has no such ceiling, which is the one thing a single payment cannot honestly cover forever.",
  },
  {
    q: `Why is Orbit Lifetime $${LIFETIME_INTRO_PRICE} instead of $${LIFETIME_STANDARD_PRICE}?`,
    a: `Because you are early. The first ${LIFETIME_INTRO_SEATS} people to buy Lifetime pay $${LIFETIME_INTRO_PRICE}; after that it is $${LIFETIME_STANDARD_PRICE}. To be clear about what that is and is not: Lifetime itself is not limited, does not run out, and will not stop being sold — the only thing that changes at ${LIFETIME_INTRO_SEATS} buyers is the price. If you buy at $${LIFETIME_INTRO_PRICE} you keep everything Lifetime ever includes, at the price you paid, permanently.`,
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
    q: "Why is Orbit Lifetime so much cheaper than subscribing?",
    a: "Because it asks you to pay before Orbit has proven itself, and that is worth a discount. It is not a trick: Lifetime is the full product, and the one thing it leaves out — enrichment on our Apollo credits — is the only cost that would grow without limit for as long as you keep the account.",
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
