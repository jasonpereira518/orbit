import { Plus } from "lucide-react";
import { CREDIT_PACK_CREDITS } from "@/lib/stripe-config";
import { FREE_CONTACT_LIMIT, PLAN_CONFIG, formatPlanPrice } from "@/lib/plans/plan-config";

const pro = PLAN_CONFIG.orbit;
const max = PLAN_CONFIG.max;
const h = (seconds: number) => `${seconds / 3600} hours`;

/**
 * Native <details> rather than a scripted accordion: it is keyboard-operable, works
 * before hydration, and is findable by in-page search when closed in supporting browsers.
 *
 * Numbers come from the plan table, never typed in here. Refund wording matches the Terms
 * as they stand; change it only together with them.
 */
const FAQ: Array<{ q: string; a: string }> = [
  {
    q: `What happens when I reach ${FREE_CONTACT_LIMIT} contacts?`,
    a: "You stop being able to add new people — and that is all. Every contact, note, reminder, and interaction you already have stays fully visible and editable, forever. Orbit never hides your own network behind a paywall.",
  },
  {
    q: "Do I need my own AI key?",
    a: `On the Free Plan, yes: capture, chat and summaries run on a key you add from Google, OpenAI, or Anthropic. Orbit Pro and Orbit Max include AI — ${pro.monthlyCredits} and ${max.monthlyCredits} credits a month — so there is nothing to set up. You can still add your own key on any plan and choose which one runs first; calls on your own key never use credits.`,
  },
  {
    q: "What is the difference between Orbit Pro and Orbit Max?",
    a: `Max includes more of everything that costs Orbit money to run: ${max.monthlyCredits} AI credits a month instead of ${pro.monthlyCredits}, ${h(max.speech.meetingSeconds)} of meeting transcription instead of ${h(pro.speech.meetingSeconds)}, ${h(max.speech.shortformSeconds)} of voice notes instead of ${h(pro.speech.shortformSeconds)}, and ${max.hostedEnrichmentsPerMonth} contact enrichments a month instead of ${pro.hostedEnrichmentsPerMonth}. Max also includes the REST API and webhooks. Everything else is the same.`,
  },
  {
    q: "What happens when my AI credits run out?",
    a: "AI pauses — Orbit never charges you automatically. Your monthly credits come back when your plan renews; to keep going before then, add a $5 pack, move to Max, or switch to your own key. Everything else in Orbit keeps working.",
  },
  {
    q: "How do credit packs work?",
    a: `A pack is ${CREDIT_PACK_CREDITS} credits for $5, bought whenever you choose, on Pro or Max. Pack credits are used only after your monthly credits run out, and they roll over from month to month while you're subscribed. If you move to the Free Plan they're kept, frozen, and come back when you subscribe again. If a pack's payment is refunded or disputed, its unused credits are removed.`,
  },
  {
    q: "Is there annual billing?",
    a: `Yes. Paying for a year up front is two months free: ${formatPlanPrice(pro.annualPriceCents ?? 0)} a year for Orbit Pro and ${formatPlanPrice(max.annualPriceCents ?? 0)} for Orbit Max. Your AI credits still arrive every month, and you can move between monthly and annual billing from Settings.`,
  },
  {
    q: "Can I switch plans or cancel?",
    a: "Any time. Moving from Pro to Max, or from monthly to annual, takes effect at once, and you pay only the difference for the rest of the period; moving from Max to Pro, or from annual to monthly, takes effect when the period you've paid for ends. If you cancel, you keep your plan until that period runs out, then your account returns to the Free Plan — still holding every contact you added while subscribed, even past the free limit. Canceling does not trigger a pro-rated refund.",
  },
  {
    q: "What happens to my data if I stop paying?",
    a: "Nothing is deleted and nothing is hidden. You can export everything you have put into Orbit at any point, on any plan, including Free.",
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
