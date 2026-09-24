/**
 * Settings — the panel's back of house.
 *
 * Before this the panel had no way to say who it was signed in as, whether AI
 * was on, or which sites it could read once you'd said yes. `/me` returned all
 * of it on every open and the panel used one boolean. The gear icon had a prop
 * waiting for it since the chassis was written.
 *
 * It replaces the body as a view rather than floating as a sheet: the panel's
 * design rules allow three elevated surfaces and none of them is a modal. The
 * view underneath stays mounted while this is open, so a half-written capture
 * is exactly where it was when the user comes back.
 */
import type { ReactNode } from "react";
import { ArrowLeft, ExternalLink } from "lucide-react";
import type { MeResponse } from "@contract";
import { browser } from "@/lib/browser";
import { APP_URL } from "@/lib/env";
import { SiteAccessList } from "../components/SiteAccess";
import { Avatar, Button, Meta, Section } from "../components/ui";

export function SettingsView({
  me,
  signedIn,
  outdated,
  onClose,
  onSignIn,
  devTools,
}: {
  me: MeResponse | null;
  signedIn: boolean;
  outdated: boolean;
  onClose: () => void;
  onSignIn: () => void;
  /** Dev builds only. Production passes nothing and the section never renders. */
  devTools?: ReactNode;
}) {
  const open = (path: string) => browser().openTab(`${APP_URL}${path}`);
  const count = (n: number, one: string, many: string) =>
    `${n.toLocaleString()} ${n === 1 ? one : many}`;

  return (
    <>
      <div className="flex h-[34px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3">
        <button
          onClick={onClose}
          className="inline-flex items-center gap-1 text-[12px] text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
        >
          <ArrowLeft size={12} />
          Back
        </button>
      </div>

      <div className="scroll-area flex-1">
        <Section title="Account" hairline={false}>
          {signedIn && me ? (
            <>
              <div className="flex items-center gap-2.5">
                <Avatar src={me.user.imageUrl} name={me.user.name} size={32} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {me.user.name ?? "Signed in"}
                  </p>
                  {me.user.email ? (
                    <Meta className="truncate">{me.user.email}</Meta>
                  ) : null}
                </div>
              </div>
              <Meta className="mt-2">
                {count(me.stats.contactCount, "person", "people")} in your orbit
                {me.stats.dueFollowUpCount > 0
                  ? ` · ${count(me.stats.dueFollowUpCount, "follow-up", "follow-ups")} due`
                  : ""}
              </Meta>
              <div className="mt-2.5 flex flex-wrap items-center gap-x-3 gap-y-1">
                <button
                  onClick={() => open("/settings")}
                  className="inline-flex items-center gap-1 text-[12px] text-[var(--primary)] hover:underline"
                >
                  Manage account
                  <ExternalLink size={11} />
                </button>
                {/* Signing out lives in the app on purpose. The panel shares the
                    app's session, so "sign out" here would silently sign the
                    user out of every Orbit tab too — better that they do it
                    where that is obvious. */}
                <Meta>Sign out from Orbit&apos;s settings.</Meta>
              </div>
            </>
          ) : (
            <>
              <Meta className="mb-2">
                Not signed in. The extension uses your Orbit session.
              </Meta>
              <Button size="sm" onClick={onSignIn}>
                Sign in to Orbit
              </Button>
            </>
          )}
        </Section>

        {signedIn && me ? (
          <Section title="AI">
            {me.capabilities.hasAiKey ? (
              <Meta>
                On, using your{" "}
                {me.capabilities.aiProviderLabel ?? me.capabilities.aiProvider} key. Page text is
                read by your provider only when the panel is open.
              </Meta>
            ) : (
              <>
                <Meta>
                  Off. Orbit still recognizes and saves people; opening lines
                  and page reading need your own AI key.
                </Meta>
                <button
                  onClick={() => open("/settings?integration=ai")}
                  className="mt-1.5 inline-flex items-center gap-1 text-[12px] text-[var(--primary)] hover:underline"
                >
                  Add an AI key
                  <ExternalLink size={11} />
                </button>
              </>
            )}
          </Section>
        ) : null}

        <Section>
          <SiteAccessList title="Read these sites without asking" />
          <Meta className="mt-2">
            On these sites the open panel reads each page as you arrive, no
            click needed. Anywhere else, click the Orbit icon. Turning a site
            off takes effect immediately.
          </Meta>
        </Section>

        <Section title="About">
          <Meta>
            Orbit extension {browser().extensionVersion()}
            {outdated ? " · a newer version is ready" : ""}
          </Meta>
        </Section>

        {devTools ? <Section title="Developer">{devTools}</Section> : null}
      </div>
    </>
  );
}

