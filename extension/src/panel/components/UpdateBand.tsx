/**
 * "A newer build exists" — one fixed line, only when true.
 *
 * It sits below the verdict rather than in it: the verdict is the answer to
 * "do I know this person", and an update notice is never more important than
 * that answer.
 */
import { useState } from "react";
import { ArrowUpCircle } from "lucide-react";
import { browser } from "@/lib/browser";
import { updateOutcomeCopy } from "../state/update-status";

export function UpdateBand() {
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const update = async () => {
    setBusy(true);
    const outcome = updateOutcomeCopy(await browser().requestUpdateCheck());
    setMessage(outcome.message);
    setBusy(false);
    if (outcome.reload) browser().reloadExtension();
  };

  return (
    <div className="flex h-[28px] shrink-0 items-center gap-2 border-b border-[var(--border)] px-3 text-[11px]">
      <ArrowUpCircle size={11} className="shrink-0 text-[var(--primary)]" />
      <span className="min-w-0 flex-1 truncate text-[var(--muted-foreground)]">
        {message ?? "A newer Orbit extension is ready"}
      </span>
      {message ? null : (
        <button
          onClick={() => void update()}
          disabled={busy}
          className="shrink-0 text-[var(--primary)] hover:underline disabled:opacity-50"
        >
          Update
        </button>
      )}
    </div>
  );
}
