"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { formatDistanceToNow } from "date-fns";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { getExtensionStatus } from "@/actions/extension";
import { buttonVariants } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { SettingsSection } from "@/components/settings/settings-section";
import { useExtensionPresence } from "@/components/extension/use-extension-presence";
import {
  EXTENSION_ID,
  EXTENSION_STORE_URL,
  EXTENSION_WELCOME_PATH,
} from "@/lib/extension/links";
import { isDesktopChromium } from "@/lib/extension/presence";
import { cn } from "@/lib/utils";

type ServerStatus = Awaited<ReturnType<typeof getExtensionStatus>>;

const subscribeNever = () => () => {};

const FREE = "Spot the people you know, save new ones, log notes and follow-ups, and right-click a profile link or selected text.";
const PRO = "AI opening lines, smart search, work history from LinkedIn, and who you know at any company.";

function listSites(sites: string[]): string {
  if (sites.length <= 1) return sites.join("");
  return `${sites.slice(0, -1).join(", ")} and ${sites[sites.length - 1]}`;
}

/**
 * The browser extension, as a tab of Settings → Integrations.
 *
 * Two different questions, answered by the two parties that know: whether it is
 * installed in THIS browser is asked of the extension itself; when it was last
 * used — from any browser — is the server's. Neither is a setting; the only
 * thing to change is on the extension's side (which sites it follows), so this
 * tab reports and points rather than configures.
 */
export function ExtensionSettings({ active }: { active: boolean }) {
  const presence = useExtensionPresence();
  const [server, setServer] = useState<ServerStatus | null>(null);
  const [failed, setFailed] = useState(false);
  // null on the server render: the browser is only knowable in the browser.
  const chromium = useSyncExternalStore(subscribeNever, isDesktopChromium, () => null);

  useEffect(() => {
    if (!active || server) return;
    let cancelled = false;
    getExtensionStatus().then(
      (next) => {
        if (!cancelled) setServer(next);
      },
      () => {
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [active, server]);

  const installed = presence !== "checking" && presence !== null ? presence : null;
  const addButton = (
    <a
      href={EXTENSION_STORE_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(buttonVariants({ size: "sm" }), "gap-1.5")}
    >
      Add to Chrome
      <ExternalLink className="h-3.5 w-3.5" />
    </a>
  );

  return (
    <SettingsSection
      title="Browser extension"
      description="Orbit beside the pages you already read — LinkedIn, GitHub, Gmail, anyone's site. It reads a page only when you click its icon."
    >
      <div className="space-y-4">
        <div className="rounded-xl border border-border/70 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            This browser
          </p>
          {presence === "checking" || chromium === null ? (
            <Skeleton className="mt-2 h-5 w-2/3" />
          ) : installed ? (
            <div className="mt-1.5 space-y-1">
              <p className="flex items-center gap-1.5 text-sm font-medium text-ink">
                <CheckCircle2 className="h-4 w-4 text-primary" />
                Installed · version {installed.version}
              </p>
              <p className="text-sm text-muted-foreground">
                {installed.sites.length
                  ? `Follows you on ${listSites(installed.sites)} without a click. Everywhere else, it reads a page when you click its icon or press its shortcut.`
                  : "Reads a page when you click its icon or press its shortcut. You can let it follow you on LinkedIn, X, Gmail or GitHub from its settings."}
              </p>
            </div>
          ) : !chromium ? (
            <p className="mt-1.5 text-sm text-muted-foreground">
              The extension runs in Chrome, Edge, Brave and Arc on a computer. Open Orbit in one of
              those to add it.
            </p>
          ) : (
            <div className="mt-1.5 space-y-2.5">
              <p className="text-sm text-muted-foreground">
                {/* Without the ID the app can't ask, so it never claims the extension is missing. */}
                {EXTENSION_ID
                  ? "Not installed in this browser."
                  : "Add it from the Chrome Web Store, then sign in once — it picks up this session."}
              </p>
              {addButton}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-border/70 p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Your account
          </p>
          {failed ? (
            <p className="mt-1.5 text-sm text-muted-foreground">Couldn&apos;t load this just now.</p>
          ) : !server ? (
            <Skeleton className="mt-2 h-5 w-1/2" />
          ) : (
            <div className="mt-1.5 space-y-2 text-sm">
              <p className="text-ink">
                {server.lastSeenAt
                  ? `Last used ${formatDistanceToNow(new Date(server.lastSeenAt), { addSuffix: true })}`
                  : "Not used with this account yet"}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-ink">Every plan: </span>
                {FREE}
              </p>
              <p className="text-muted-foreground">
                <span className="font-medium text-ink">
                  {server.hasExtensionPro ? "Included with your plan: " : "With Pro: "}
                </span>
                {PRO}
                {!server.hasExtensionPro ? (
                  <>
                    {" "}
                    <Link href="/pricing" className="font-medium text-primary underline-offset-2 hover:underline">
                      See plans
                    </Link>
                  </>
                ) : null}
              </p>
            </div>
          )}
        </div>

        <p className="text-sm text-muted-foreground">
          <Link
            href={EXTENSION_WELCOME_PATH}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            How it works, and what it reads
          </Link>
        </p>
      </div>
    </SettingsSection>
  );
}
