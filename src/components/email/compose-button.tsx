"use client";

import { Mail } from "lucide-react";
import { useHiddenSurfaces } from "@/components/layout/hidden-surfaces";
import { Button } from "@/components/ui/button";
import { openCompose } from "@/lib/compose-events";
import { COMPOSE_SURFACE_KEY } from "@/lib/surfaces";

/** "Email" on a contact's page. Renders nothing while Compose is hidden or unreleased. */
export function ComposeButton({ contactId }: { contactId: string }) {
  const hidden = useHiddenSurfaces();
  if (hidden.has(COMPOSE_SURFACE_KEY)) return null;
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => openCompose({ contactId })}>
      <Mail className="size-3.5" /> Email
    </Button>
  );
}
