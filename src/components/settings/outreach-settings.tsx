"use client";

import { useState, useTransition } from "react";
import { toast } from "sonner";
import { saveOutreachSettings } from "@/actions/settings";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

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
    <section className="space-y-4 rounded-2xl border border-border/70 bg-card p-6">
      <div>
        <h2 className="text-lg font-medium text-primary">Outreach integrations</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Apollo powers people search. Resend and Twilio are optional for automated
          sending — use with caution and follow CAN-SPAM, carrier, and LinkedIn
          terms of service.
        </p>
      </div>

      <div className="space-y-1.5">
        <Label htmlFor="apollo-key">Apollo API key</Label>
        <Input
          id="apollo-key"
          type="password"
          placeholder={state.apollo ? "Saved — paste to replace" : "Required for live search"}
          value={apolloKey}
          onChange={(e) => setApolloKey(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Status: {state.apollo ? "configured" : "not set (demo prospects used)"}
        </p>
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
        <p className="text-xs text-muted-foreground">
          SMS auto-send: {state.twilio ? "ready" : "not configured"}
        </p>
      </div>

      <Button
        disabled={pending}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
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
              toast.error(err instanceof Error ? err.message : "Failed to save");
            }
          })
        }
      >
        Save outreach settings
      </Button>
    </section>
  );
}
