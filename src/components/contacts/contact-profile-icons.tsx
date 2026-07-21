"use client";

import { useState, type ReactNode } from "react";
import {
  Building2,
  Globe,
  GraduationCap,
  Mail,
  Phone,
} from "lucide-react";
import {
  orgLogoUrl,
  resolveCompanyDomain,
  resolveSchoolDomain,
} from "@/lib/org-logos";
import { buildLinkedInUrl } from "@/lib/outreach-channels";
import { cn } from "@/lib/utils";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

function LinkedInIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden
      className={className}
    >
      <path d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z" />
    </svg>
  );
}

function ChannelIcon({
  href,
  label,
  children,
}: {
  href: string;
  label: string;
  children: ReactNode;
}) {
  const external = href.startsWith("http");
  const classes = cn(
    "inline-flex size-9 items-center justify-center rounded-full border border-border/70 bg-card text-muted-foreground transition-colors",
    "hover:border-border hover:bg-muted/60 hover:text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <a
            href={href}
            target={external ? "_blank" : undefined}
            rel={external ? "noopener noreferrer" : undefined}
            aria-label={label}
            className={classes}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
}

/** Square company / school logo that links to the org website. */
function OrgLogoTile({
  domain,
  label,
  href,
  fallback,
}: {
  domain: string | null;
  label: string;
  href: string | null;
  fallback: ReactNode;
}) {
  const [failed, setFailed] = useState(false);
  const showImg = Boolean(domain) && !failed;
  const classes = cn(
    "inline-flex size-11 items-center justify-center rounded-md border border-border/70 bg-card p-1.5 text-muted-foreground shadow-none transition-colors",
    "hover:border-border hover:bg-muted/50 hover:text-foreground",
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
    !href && "cursor-default"
  );

  const content = showImg ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={orgLogoUrl(domain!)}
      alt=""
      width={32}
      height={32}
      className="size-8 rounded-sm object-contain"
      onError={() => setFailed(true)}
    />
  ) : (
    fallback
  );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          href ? (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              aria-label={`Open ${label} website`}
              title={label}
              className={classes}
            />
          ) : (
            <span aria-label={label} title={label} className={classes} />
          )
        }
      >
        {content}
      </TooltipTrigger>
      <TooltipContent side="bottom">
        {href ? `Open ${label}` : label}
      </TooltipContent>
    </Tooltip>
  );
}

/** Square company / school logos — place beside the profile name row. */
export function ContactOrgLogos({
  company,
  school,
  email,
  website,
  className,
}: {
  company?: string | null;
  school?: string | null;
  email?: string | null;
  website?: string | null;
  className?: string;
}) {
  const companyDomain = resolveCompanyDomain({ company, email, website });
  const schoolDomain = resolveSchoolDomain(school);

  const companyHref = companyDomain
    ? `https://${companyDomain}`
    : website?.trim()
      ? website.startsWith("http")
        ? website
        : `https://${website}`
      : null;
  const schoolHref = schoolDomain ? `https://${schoolDomain}` : null;

  if (!company && !school) return null;

  return (
    <TooltipProvider>
      <div
        className={cn("flex shrink-0 flex-wrap items-center gap-2", className)}
      >
        {company ? (
          <OrgLogoTile
            domain={companyDomain}
            label={company}
            href={companyHref}
            fallback={<Building2 className="size-5" />}
          />
        ) : null}
        {school ? (
          <OrgLogoTile
            domain={schoolDomain}
            label={school}
            href={schoolHref}
            fallback={<GraduationCap className="size-5" />}
          />
        ) : null}
      </div>
    </TooltipProvider>
  );
}

/** Circular channel icons (LinkedIn, email, phone, website). */
export function ContactChannelIcons({
  email,
  phone,
  linkedinUrl,
  website,
  className,
}: {
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  website?: string | null;
  className?: string;
}) {
  const hasAny = email || phone || linkedinUrl || website;
  if (!hasAny) return null;

  return (
    <TooltipProvider>
      <div
        className={cn(
          "flex flex-wrap items-center justify-end gap-1.5",
          className
        )}
      >
        {linkedinUrl ? (
          <ChannelIcon href={buildLinkedInUrl(linkedinUrl)} label="LinkedIn">
            <LinkedInIcon className="size-4" />
          </ChannelIcon>
        ) : null}
        {email ? (
          <ChannelIcon href={`mailto:${email}`} label={email}>
            <Mail className="size-4" />
          </ChannelIcon>
        ) : null}
        {phone ? (
          <ChannelIcon href={`tel:${phone}`} label={phone}>
            <Phone className="size-4" />
          </ChannelIcon>
        ) : null}
        {website ? (
          <ChannelIcon
            href={website.startsWith("http") ? website : `https://${website}`}
            label="Website"
          >
            <Globe className="size-4" />
          </ChannelIcon>
        ) : null}
      </div>
    </TooltipProvider>
  );
}
