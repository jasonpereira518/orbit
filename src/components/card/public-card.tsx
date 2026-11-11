import { Download, Globe, Mail, Phone } from "lucide-react";
import type { PublicCard as PublicCardData } from "@/lib/cards/card-store";
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
      <section className="text-center" aria-labelledby="card-name">
        {card.photoUrl && (
          // eslint-disable-next-line @next/next/no-img-element -- a user's photo on any host; next/image would need every host allow-listed.
          <img
            src={card.photoUrl}
            alt=""
            width={112}
            height={112}
            className="mx-auto h-28 w-28 rounded-full border border-[#e8f3f1]/[0.14] object-cover"
          />
        )}
        <h1 id="card-name" className="mt-4 font-[family-name:var(--font-display)] text-3xl tracking-tight text-[#e8f3f1]">
          {card.fullName}
        </h1>
        {role && <p className="mt-1.5 text-[15px] text-[#e8f3f1]/85">{role}</p>}
        {card.headline && <p className="mt-1 text-sm text-[#9aada8]">{card.headline}</p>}
        {card.location && <p className="mt-1 text-sm text-[#9aada8]">{card.location}</p>}
        {card.tagline && <p className="mt-3 text-sm italic text-landing-accent">{card.tagline}</p>}
      </section>

      {links.length > 0 && (
        <ul className="grid gap-2.5">
          {links.map(({ href, label, icon: Icon, external }) => (
            <li key={href}>
              <a href={href} className={linkClass} {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}>
                <Icon className="h-4 w-4 shrink-0 text-landing-accent" aria-hidden="true" />
                <span className="truncate">{label}</span>
              </a>
            </li>
          ))}
        </ul>
      )}

      <a
        href={`/c/${card.slug}/vcard`}
        className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-full bg-[#f2c14e] px-5 text-[15px] font-medium text-[#03050c] transition-colors hover:bg-[#f5cd6b]"
      >
        <Download className="h-4 w-4" aria-hidden="true" />
        Save contact
      </a>

      <ShareBackForm slug={card.slug} firstName={card.firstName} />
    </div>
  );
}
