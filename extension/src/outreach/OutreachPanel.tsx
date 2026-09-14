import { useEffect, useRef, useState } from "react";
import type { OrbitApi } from "../lib/api";
import { BrowserRunner } from "./runner";
type Campaign = {
  id: string;
  name: string;
  sender: { address: string; transport: string };
};
export function OutreachPanel({ api }: { api: OrbitApi }) {
  const [campaigns, setCampaigns] = useState<Campaign[]>([]),
    [campaignId, setCampaignId] = useState(""),
    [status, setStatus] = useState(""),
    [active, setActive] = useState(false),
    [ack, setAck] = useState(false);
  const runner = useRef<BrowserRunner | null>(null),
    session = useRef<string | null>(null);
  useEffect(() => {
    api
      .outreach<Campaign[]>({ op: "campaigns" })
      .then(setCampaigns)
      .catch((e) => setStatus(e.message));
    return () => {
      runner.current?.stop();
    };
  }, [api]);
  const campaign = campaigns.find((c) => c.id === campaignId);
  async function start() {
    if (!campaign) return;
    try {
      setActive(true);
      const origins =
        campaign.sender.transport === "linkedin"
          ? ["https://*.linkedin.com/*"]
          : campaign.sender.transport === "gmail_web"
            ? ["https://mail.google.com/*"]
            : [
                "https://outlook.live.com/*",
                "https://outlook.office.com/*",
                "https://outlook.office365.com/*",
              ];
      if (!(await chrome.permissions.request({ origins })))
        throw new Error("Allow access to the selected site to run outreach.");
      const s = await api.outreach<{ id: string }>({
        op: "start",
        campaignId,
        account: campaign.sender.address,
      });
      session.current = s.id;
      runner.current = new BrowserRunner(api, s.id, setStatus);
      await runner.current.run(campaign.sender.address);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : "Execution interrupted");
    } finally {
      setActive(false);
      if (session.current)
        await api
          .outreach({ op: "stop", sessionId: session.current })
          .catch(() => {});
    }
  }
  return (
    <section className="space-y-3 p-4 text-sm">
      <h2 className="text-lg font-semibold">Outreach session</h2>
      <p>
        Keep this panel open. Orbit uses a dedicated tab to send approved
        messages and check replies.
      </p>
      <label className="block">
        Campaign
        <select
          className="mt-1 w-full rounded border p-2"
          value={campaignId}
          disabled={active}
          onChange={(e) => setCampaignId(e.target.value)}
        >
          <option value="">Choose a campaign</option>
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </label>
      {campaign && <p>Sending as {campaign.sender.address}</p>}
      {campaign?.sender.transport === "linkedin" && (
        <label className="flex gap-2">
          <input
            type="checkbox"
            checked={ack}
            onChange={(e) => setAck(e.target.checked)}
          />
          I understand LinkedIn prohibits automation and may restrict my
          account.
        </label>
      )}
      <button
        className="rounded bg-[var(--primary)] px-3 py-2 text-[var(--primary-foreground)] disabled:opacity-50"
        disabled={
          !campaign || (!ack && campaign.sender.transport === "linkedin")
        }
        onClick={() => (active ? runner.current?.stop() : void start())}
      >
        {active ? "Pause session" : "Start / resume"}
      </button>
      <p role="status" aria-live="polite">
        {status}
      </p>
      <p className="text-xs">
        A send with an uncertain result needs verification in Orbit before it
        can be retried.
      </p>
    </section>
  );
}
