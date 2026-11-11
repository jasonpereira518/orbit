import { Download, Globe, Mail, Phone } from "lucide-react";
import type { PublicCard as PublicCardData } from "@/lib/cards/card-store";
import { OrbitCard } from "@/components/card/orbit-card";
import { ShareBackForm } from "@/components/card/share-back-form";
import { LinkedInMark } from "@/components/settings/provider-marks";

const linkClass =
  "flex min-h-12 items-center gap-3 rounded-2xl border border-[#e8f3f1]/[0.12] px-4 text-[15px] text-[#e8f3f1] transition-colors hover:border-[#e8f3f1]/30";

/**
 * The page a stranger sees after scanning someone's Orbit Card. Every field here was already
 * filtered by `loadPublicCard`: hidden fields are null and links are http(s) only.
 */
export function PublicCard({ card }: { card: PublicCardData }) {
  const role = [card.title, card.company].filter(Boolean).join(" @ ");
  const links = [
    card.email && { href: `mailto:${card.email}`, label: card.email, icon: Mail },
    card.phone && { href: `tel:${card.phone.replace(/[^\d+]/g, "")}`, label: card.phone, icon: Phone },
    card.linkedinUrl && { href: card.linkedinUrl, label: "LinkedIn", icon: LinkedInMark, external: true },
    card.websiteUrl && { href: card.websiteUrl, label: "Website", icon: Globe, external: true },
  ].filter((l) => !!l);

  return (
    <div className="flex flex-col gap-6">
      <section aria-label={`${card.fullName}’s card`}>
        <OrbitCard art={card.art} name={card.fullName} role={role || null} firstName={card.firstName} nameAs="h1" entrance />
        {(card.photoUrl || card.headline || card.location || card.tagline) && (
          <div className="mt-6 flex items-center gap-4">
            {card.photoUrl && (
              // eslint-disable-next-line @next/next/no-img-element -- a user's photo on any host; next/image would need every host allow-listed.
              <img
                src={card.photoUrl}
                alt=""
                width={56}
                height={56}
                className="size-14 shrink-0 rounded-full border border-[#e8f3f1]/[0.14] object-cover"
              />
            )}
            <div className="min-w-0">
              {card.headline && <p className="text-[15px] text-[#e8f3f1]/90">{card.headline}</p>}
              {card.location && <p className="mt-0.5 text-sm text-[#9aada8]">{card.location}</p>}
              {card.tagline && <p className="mt-1 text-sm italic text-[#d4b469]">{card.tagline}</p>}
            </div>
          </div>
        )}
      </section>

      <a
        href={`/c/${card.slug}/vcard`}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[linear-gradient(100deg,#f6e7b8,#d4b469_55%,#e9cf8a)] px-5 text-[15px] font-medium text-[#1a1408] shadow-[0_8px_24px_-12px_rgba(212,180,105,0.6)] transition-[filter] hover:brightness-105"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Save contact
      </a>

      {links.length > 0 && (
        <ul className="grid gap-2.5">
          {links.map(({ href, label, icon: Icon, external }) => (
            <li key={href}>
              <a href={href} className={linkClass} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                <Icon className="h-4 w-4 shrink-0 text-[#d4b469]" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <ShareBackForm slug={card.slug} firstName={card.firstName} />
    </div>
  );
}
