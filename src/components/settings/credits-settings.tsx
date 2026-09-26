import { SettingsRow } from "@/components/settings/settings-section";

/**
 * Third-party artwork Orbit ships, credited as its licences ask. A new asset from Flaticon (or
 * anywhere that asks for credit) adds an entry here rather than a footnote in the main UI.
 *
 * Not tied to a surface key on purpose: an operator hiding Help must not strip a licence
 * requirement off the page.
 *
 * What each entry covers — keep these lists current when an asset is copied or resized:
 *
 * - Constellation (Flaticon 3049592, by Magnific) is the Orbit mark: `public/orbit-logo.png`
 *   (drawn by `OrbitLogo`, traced by the celebration coin), `public/favicon.png`, the
 *   file-based `src/app/icon.png`, `apple-icon.png` and `favicon.ico`, and the extension's
 *   `extension/public/icons/*.png`.
 * - The planets (graphicmall's "Planets solar system" pack) are `public/landing/planets/`
 *   — Mercury through Neptune, each as .png/.webp/.avif — drawn by the landing hero, the
 *   capture review's planet badge, the waitlist's planet art, pass image and email; plus
 *   `public/waitlist/icon.png`, a 256px copy of the Saturn.
 * - The sun (Flaticon, by Magnific) is `public/landing/planets/sun.{png,webp,avif}`, drawn
 *   only by the landing hero. It sits beside the planets but is not from their pack.
 */
const CREDITS = [
  {
    subject: "Constellation icon",
    author: { name: "Magnific", href: "https://www.flaticon.com/authors/magnific" },
    detail: null,
  },
  {
    subject: "Planet icons",
    author: { name: "graphicmall", href: "https://www.flaticon.com/authors/graphicmall" },
    detail: "Planets solar system icon pack",
  },
  {
    subject: "Sun icons",
    author: { name: "Magnific", href: "https://www.flaticon.com/authors/magnific" },
    detail: null,
  },
] as const;

const LINK = "underline underline-offset-2 hover:text-foreground";

export function CreditsSettings() {
  return (
    <SettingsRow id="settings-credits" title="Credits">
      <ul className="space-y-2 text-sm text-muted-foreground">
        {CREDITS.map((credit) => (
          <li key={credit.subject}>
            <p>
              {credit.subject} created by{" "}
              <a
                href={credit.author.href}
                target="_blank"
                rel="noopener noreferrer"
                className={LINK}
              >
                {credit.author.name}
              </a>{" "}
              -{" "}
              <a
                href="https://www.flaticon.com/"
                target="_blank"
                rel="noopener noreferrer"
                className={LINK}
              >
                Flaticon
              </a>
            </p>
            {credit.detail ? (
              <p className="text-xs text-muted-foreground/80">{credit.detail}</p>
            ) : null}
          </li>
        ))}
      </ul>
    </SettingsRow>
  );
}
