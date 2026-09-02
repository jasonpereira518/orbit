"use client";

import { useState } from "react";
import { Copy, ExternalLink, KeyRound } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { mintSignInLinkAction } from "@/actions/admin";
import { toast } from "@/lib/toast";

/**
 * Mints a one-click sign-in link for this account and hands it to the operator to open.
 *
 * "Open it for me, in a genuinely private window" is not something a web page can do —
 * launching an incognito/private window is a browser-chrome action with no JS API, on
 * any browser. What this actually gives instead: the link itself, generated server-side
 * behind the admin gate, plus the one button a page CAN offer (`window.open`, a new tab
 * in the SAME browser context) and a clear steer toward the thing that's actually needed.
 *
 * That steer matters here specifically: this Clerk instance runs single-session-mode, so
 * opening the link in an ordinary new tab, while the operator's own session is active in
 * that same browser, contends with the session already there. A private window is a
 * separate cookie jar — the one thing that reliably avoids that.
 */
export function SignInLinkButton({
  targetUserId,
  email,
}: {
  targetUserId: string;
  email: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [link, setLink] = useState<{ url: string; expiresInSeconds: number } | null>(null);

  const mint = () => {
    setPending(true);
    setLink(null);
    mintSignInLinkAction({ targetUserId })
      .then((result) => setLink(result))
      .catch((err) => {
        toast.error(err instanceof Error ? err.message : "Could not create a sign-in link.");
        setOpen(false);
      })
      .finally(() => setPending(false));
  };

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => {
          setOpen(true);
          mint();
        }}
      >
        <KeyRound className="size-3.5" aria-hidden />
        Sign-in link
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign-in link</DialogTitle>
            <DialogDescription>
              {email ?? targetUserId} — no password, no emailed code.
            </DialogDescription>
          </DialogHeader>

          {pending && (
            <p className="text-sm text-muted-foreground">Minting a link…</p>
          )}

          {link && (
            <div className="space-y-3">
              <div className="flex gap-2">
                <Input readOnly value={link.url} className="font-mono text-xs" />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  aria-label="Copy link"
                  onClick={() => {
                    void navigator.clipboard.writeText(link.url);
                    toast.success("Copied.");
                  }}
                >
                  <Copy className="size-4" aria-hidden />
                </Button>
              </div>

              {/* This is a normal new tab in the same browser, not a private window — the
                  copy above and below is what actually carries that distinction, since
                  nothing here can be more honest than a label without overstating what
                  the button does. */}
              <Button
                type="button"
                variant="outline"
                className="w-full"
                onClick={() => window.open(link.url, "_blank", "noopener,noreferrer")}
              >
                <ExternalLink className="size-3.5" aria-hidden />
                Open in a new tab
              </Button>

              <p className="text-xs text-muted-foreground">
                <strong className="text-foreground">
                  For the actual demo, open it in a private/incognito window instead
                </strong>{" "}
                (Cmd/Ctrl+Shift+N, or Cmd+Shift+P in Firefox) and paste the link there. This
                Clerk project allows one signed-in session per browser — if you&apos;re
                already signed into your own account here, a plain new tab shares that
                session rather than switching accounts. A private window is a clean slate.
              </p>

              <p className="text-xs text-muted-foreground">
                Single-use — it stops working the instant it&apos;s opened once, whichever
                way you open it. Stays valid unused for{" "}
                {Math.round(link.expiresInSeconds / 86400)} days, so it&apos;s fine to mint
                ahead of time; mint a fresh one here anytime you need another.
              </p>
            </div>
          )}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Close
            </Button>
            {link && (
              <Button variant="outline" onClick={mint} disabled={pending}>
                New link
              </Button>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
