"use client";

import { useState, useTransition } from "react";
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
  const [resendKey, setResendKey] = useState("");
  const [twilioSid, setTwilioSid] = useState("");
  const [twilioToken, setTwilioToken] = useState("");
  const [twilioFrom, setTwilioFrom] = useState(initial.twilioFromNumber || "");
  const [pending, start] = useTransition();

  return (
    <SettingsSection
      title="Outreach"
      description="Apollo powers people search. Resend and Twilio are optional for automated sending — use with caution and follow CAN-SPAM, carrier, and LinkedIn terms of service."
    >

      <div className="space-y-1.5">
        <Label htmlFor="apollo-key">Apollo API key</Label>
        <Input
          id="apollo-key"
          type="password"
          placeholder={state.apollo ? "Saved — paste to replace" : "Required for live search"}
          value={apolloKey}
          onChange={(e) => setApolloKey(e.target.value)}
        />
        <KeyStatus on={state.apollo} onText="Connected" offText="Not set up — Outreach shows sample prospects until you add a key" />
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
                resendApiKey: resendKey || undefined,
                twilioAccountSid: twilioSid || undefined,
                twilioAuthToken: twilioToken || undefined,
                twilioFromNumber: twilioFrom || undefined,
              });
              setApolloKey("");
              setResendKey("");
              setTwilioSid("");
              setTwilioToken("");
              setState({
                apollo: state.apollo || Boolean(apolloKey),
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
