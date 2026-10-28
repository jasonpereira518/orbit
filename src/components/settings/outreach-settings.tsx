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

type OutreachSettingsState = {
  apollo: boolean;
};

export function OutreachSettings({
  initial,
}: {
  initial: OutreachSettingsState;
}) {
  const [state, setState] = useState(initial);
  const [apolloKey, setApolloKey] = useState("");
  const [pending, start] = useTransition();

  return (
    <SettingsSection
      title="Outreach"
      description="Apollo refreshes your contacts’ LinkedIn profiles. Campaign email sends from your own connected mailbox."
    >

      <div className="space-y-1.5">
        <Label htmlFor="apollo-key">Apollo API key</Label>
        <Input
          id="apollo-key"
          type="password"
          placeholder={state.apollo ? "Saved — paste to replace" : "Paste your Apollo key"}
          value={apolloKey}
          onChange={(e) => setApolloKey(e.target.value)}
        />
        <p className="text-xs text-muted-foreground">
          Status: {state.apollo ? "configured" : "not set"}
        </p>
      </div>

      <Button
        disabled={pending}
        className="bg-primary text-primary-foreground hover:bg-primary/90"
        onClick={() =>
          start(async () => {
            try {
              await saveOutreachSettings({ apolloApiKey: apolloKey || undefined });
              setApolloKey("");
              setState({ apollo: state.apollo || Boolean(apolloKey) });
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
