"use client";

import { useState } from "react";
import { useGuardedTransition } from "@/lib/single-flight";
import { toast } from "@/lib/toast";
import { saveOutreachSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { friendlyError } from "@/lib/errors";
import { TOAST_COPY } from "@/lib/toast-copy";
import { SettingsSection } from "@/components/settings/settings-section";
import { StatusDot } from "@/components/settings/integration-ui";

type OutreachSettingsState = {
  apollo: boolean;
  brightdata?: boolean;
  brightDataZone?: string | null;
  resend: boolean;
  twilio: boolean;
  twilioFromNumber: string | null;
};

export function OutreachSettings({
  initial,
}: {
  initial: OutreachSettingsState;
}) {
  const [state, setState] = useState(initial);
  const [apolloKey, setApolloKey] = useState("");
  const [brightDataKey, setBrightDataKey] = useState("");
  const [brightDataZone, setBrightDataZone] = useState(initial.brightDataZone || "web_unlocker1");
  const [resendKey, setResendKey] = useState("");
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [twilioFrom, setTwilioFrom] = useState(initial.twilioFromNumber || "");
  const [pending, start] = useGuardedTransition();

  return (
    <SettingsSection
      title="Outreach"
      description="Bright Data and Apollo power people search and web scraping. Resend and Twilio are optional for automated sending — use with caution and follow CAN-SPAM, carrier, and LinkedIn terms of service."
    >

      <div className="space-y-1.5">
        <Label htmlFor="brightdata-key">Bright Data API key</Label>
        <Input
          id="brightdata-key"
          type="password"
          placeholder={state.brightdata ? "Saved — paste to replace" : "Required for live LinkedIn and web scraping"}
          value={brightDataKey}
          onChange={(e) => setBrightDataKey(e.target.value)}
        />
        <KeyStatus on={Boolean(state.brightdata)} onText="Connected — live web & LinkedIn scraping enabled" offText="Not set up — falls back to AI web discovery" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="brightdata-zone">Bright Data Web Unlocker Zone</Label>
        <Input
          id="brightdata-zone"
          placeholder="web_unlocker1"
          value={brightDataZone}
          onChange={(e) => setBrightDataZone(e.target.value)}
        />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="apollo-key">Apollo API key</Label>
        <Input
          id="apollo-key"
          type="password"
          placeholder={state.apollo ? "Saved — paste to replace" : "Optional secondary search provider"}
          value={apolloKey}
          onChange={(e) => setApolloKey(e.target.value)}
        />
        <KeyStatus on={state.apollo} onText="Connected" offText="Not set up" />
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="resend-key">Resend API key (optional)</Label>
        <Input
          id="resend-key"
          type="password"
          placeholder={state.resend ? "Saved — paste to replace" : "For automated email send"}
          value={resendKey}
          onChange={(e) => setResendKey(e.target.value)}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="twilio-sid">Twilio Account SID (optional)</Label>
          <Input
            id="twilio-sid"
            type="password"
            value={twilioSid}
            onChange={(e) => setTwilioSid(e.target.value)}
          />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="twilio-token">Twilio Auth Token (optional)</Label>
          <Input
            id="twilio-token"
            type="password"
            value={twilioToken}
            onChange={(e) => setTwilioToken(e.target.value)}
          />
        </div>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="twilio-from">Twilio from number</Label>
        <Input
          id="twilio-from"
          placeholder="+14155551234"
          value={twilioFrom}
          onChange={(e) => setTwilioFrom(e.target.value)}
        />
        <KeyStatus on={state.twilio} onText="Text messages ready to send" offText="Not set up" />
      </div>

      <Button
        disabled={pending}
        onClick={() =>
          start(async () => {
            try {
              await saveOutreachSettings({
                apolloApiKey: apolloKey || undefined,
                brightDataApiKey: brightDataKey || undefined,
                brightDataZone: brightDataZone || undefined,
                resendApiKey: resendKey || undefined,
                twilioAccountSid: twilioSid || undefined,
                twilioAuthToken: twilioToken || undefined,
                twilioFromNumber: twilioFrom || undefined,
              });
              setApolloKey("");
              setBrightDataKey("");
              setResendKey("");
              setTwilioSid("");
              setTwilioToken("");
              setState({
                apollo: state.apollo || Boolean(apolloKey),
                brightdata: state.brightdata || Boolean(brightDataKey),
                brightDataZone: brightDataZone || state.brightDataZone,
                resend: state.resend || Boolean(resendKey),
                twilio:
                  (state.twilio || Boolean(twilioSid)) &&
                  (state.twilio || Boolean(twilioToken)) &&
                  Boolean(twilioFrom),
                twilioFromNumber: twilioFrom || state.twilioFromNumber,
              });
              toast.success("Outreach settings saved");
            } catch (err) {
              toast.error(friendlyError(err, TOAST_COPY.saveFailed));
            }
          })
        }
      >
        Save outreach settings
      </Button>
    </SettingsSection>
  );
}

/** The same dot-and-words status line the account pages use. */
function KeyStatus({ on, onText, offText }: { on: boolean; onText: string; offText: string }) {
  return (
    <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <StatusDot status={{ state: on ? "on" : "off", detail: on ? onText : offText }} />
      {on ? onText : offText}
    </p>
  );
}
