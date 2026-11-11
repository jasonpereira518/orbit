"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { SettingsRow } from "@/components/settings/settings-section";
import { setMyDiscoverable } from "@/actions/nearby";
import { friendlyError } from "@/lib/errors";
import { useGuardedTransition } from "@/lib/single-flight";
import { toast } from "@/lib/toast";

/** "Let people at the same event find me" — needs a live Orbit card, because that is what they see. */
export function DiscoverableSwitch({ initialOn, hasCard }: { initialOn: boolean; hasCard: boolean }) {
  const [on, setOn] = useState(initialOn);
  const [pending, start] = useGuardedTransition();

  const toggle = () =>
    start(async () => {
      const next = !on;
      try {
        const result = await setMyDiscoverable(next);
        if (!result.ok) {
          toast.error(result.message);
          return;
        }
        setOn(next);
        toast.success(next ? "People at the same event can find you" : "You’re no longer findable at events");
      } catch (err) {
        toast.error(friendlyError(err, "Couldn’t change that — try again?"));
      }
    });

  return (
    <SettingsRow
      title="Let people at the same event find me"
      description={
        <>
          They&rsquo;ll see your Orbit card. You can hide yourself at any event ·{" "}
          <span role="status">{on ? "On" : "Off"}</span>
        </>
      }
      action={
        hasCard || on ? (
          <Button type="button" size="sm" variant="outline" disabled={pending} onClick={toggle}>
            {on ? "Turn off" : "Turn on"}
          </Button>
        ) : (
          <Link href="/card" className="text-sm font-medium text-primary underline-offset-4 hover:underline">
            Create your card
          </Link>
        )
      }
    />
  );
}
