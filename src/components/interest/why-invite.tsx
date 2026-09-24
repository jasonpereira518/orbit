import { Award, Waves } from "lucide-react";
import { Reveal } from "@/components/motion/reveal";
import { REFERRAL_TIERS } from "@/lib/interest-list";
import { cn } from "@/lib/utils";

const HEADING =
  "font-[family-name:var(--font-display)] font-normal leading-[1.12] tracking-[-0.025em] text-[#e8f3f1]";

/** One per entry of `REFERRAL_TIERS`, in order. */
const ICONS = [Waves, Award] as const;

/**
 * The incentive to refer, spelled out: what each tier earns and how many friends it takes
 * (`REFERRAL_TIERS`, the same wording the pass and the emails use).
 *
 * `referrals` is the viewer's live count when the page was rendered for a pass (`?me=`):
 * a tier they have reached is marked, and the next one says how far off it is. Without a
 * pass — the form, or a pass just made in the page, which starts at zero anyway — both
 * tiers read as goals.
 */
export function WhyInvite({ referrals }: { referrals: number | null }) {
  const next =
    referrals === null ? null : (REFERRAL_TIERS.find((t) => referrals < t.friends) ?? null);

  return (
    <section className="mt-24 md:mt-32" aria-labelledby="waitlist-why-invite">
      <Reveal className="reveal-celestial">
        <h2 id="waitlist-why-invite" className={`${HEADING} text-center text-[clamp(26px,3.4vw,38px)]`}>
          Why invite friends?
        </h2>
      </Reveal>
      <Reveal className="reveal-celestial" delay={60}>
        <p className="mx-auto mt-4 max-w-[52ch] text-center text-base leading-relaxed text-[#9aada8]">
          Every friend who joins with your link moves you closer to the front. Bring enough of
          them and you earn a place that can&apos;t be bought.
        </p>
      </Reveal>
      <Reveal className="reveal-celestial mt-10 block" delay={120}>
        <ol className="grid gap-4 sm:grid-cols-2">
          {REFERRAL_TIERS.map((tier, i) => {
            const Icon = ICONS[i] ?? Waves;
            const reached = referrals !== null && referrals >= tier.friends;
            const toGo = next === tier && referrals !== null ? tier.friends - referrals : null;
            return (
              <li
                key={tier.name}
                className={cn(
                  "landing-glass rounded-2xl p-5 sm:p-6",
                  reached && "shadow-[0_0_0_1px_rgba(242,193,78,0.45)]"
                )}
              >
                <div className="flex items-center justify-between gap-3">
                  <p className="font-[family-name:var(--font-display)] text-2xl text-landing-accent">
                    {tier.friends} friends
                  </p>
                  <Icon className="size-5 shrink-0 text-[#f2c14e]" aria-hidden="true" />
                </div>
                <h3 className="mt-2 text-sm font-medium text-[#e8f3f1]">{tier.name}</h3>
                <p className="mt-1.5 text-sm leading-relaxed text-[#9aada8]">{tier.perk}</p>
                {reached ? (
                  <p className="mt-3 text-xs uppercase tracking-[0.14em] text-landing-accent">
                    You&apos;re here
                  </p>
                ) : toGo !== null ? (
                  <p className="mt-3 text-xs uppercase tracking-[0.14em] text-[#9aada8]">
                    {toGo} to go
                  </p>
                ) : null}
              </li>
            );
          })}
        </ol>
      </Reveal>
      <Reveal className="reveal-celestial" delay={180}>
        <p className="mx-auto mt-5 max-w-[60ch] text-center text-xs leading-[1.6] text-[#6d807c]">
          Friends count while they&apos;re on the waitlist. Each friend gets a link of their own
          the moment they join, so they can move up too.
        </p>
      </Reveal>
    </section>
  );
}
