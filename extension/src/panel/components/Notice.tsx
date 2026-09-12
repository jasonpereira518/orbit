import type { ReactNode } from "react";
import { Meta } from "./ui";

/**
 * A prose block that sits under the identity zone rather than centring itself.
 *
 * Centred empty states were fine in a 600px popup; in a full-height panel they
 * strand a message in the middle of 900px of nothing. Top-aligning also keeps
 * the identity strip doing its job — proving the extension already read the
 * page, so that whatever is missing is the *only* thing missing.
 *
 * Lives apart from App so the design harness can render it without dragging in
 * usePanel and, through it, a Clerk SDK that refuses to load outside an
 * extension.
 */
export function Notice({
  title,
  body,
  action,
  icon,
}: {
  title: string;
  body?: string;
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex-1 space-y-2 px-3 py-4">
      {icon ? <div className="text-[var(--muted-foreground)]">{icon}</div> : null}
      <p className="text-[14px] font-medium leading-snug">{title}</p>
      {body ? <Meta className="max-w-[38ch]">{body}</Meta> : null}
      {action}
    </div>
  );
}
