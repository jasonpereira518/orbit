/**
 * Rewrite chat proposals stored in the legacy shape (`args.kind` other than "tool") into the
 * catalog shape every proposal now has, so `commitProposedAction` and the cards need only one
 * path. Task 4.4 of docs/superpowers/plans/2026-10-19-chat-agent.md (on claude/chat-agent-design).
 *
 * RUN THIS BEFORE DEPLOYING the release that drops the legacy commit path. Until it has run, a
 * legacy card that is still waiting for a click is refused when clicked ("That change can’t be
 * made any more") instead of committing, and a legacy done card loses its icon and "View" link.
 * Nothing is lost either way: the rows are only rewritten, never deleted.
 *
 * Idempotent and safe while the app is up: each row is replaced only if nothing changed it
 * since the read, and a converted row no longer matches. A row that lost that race is
 * reported as a conflict; run again to pick it up.
 *
 * TARGETS `DATABASE_URL`, and refuses to run without one (`requireRealDatabase`).
 *
 * Run: npx tsx scripts/migrate-legacy-chat-proposals.ts [--dry]
 */
import { requireRealDatabase } from "./lib/operational-db";
import { migrateLegacyChatProposals } from "./lib/legacy-chat-proposals";

async function main() {
  const dry = process.argv.includes("--dry");
  requireRealDatabase("migrate-legacy-chat-proposals");
  const stats = await migrateLegacyChatProposals({ dry });
  console.log(
    `${dry ? "[dry] " : ""}messages with legacy proposals: ${stats.messagesSeen}; ` +
      `${dry ? "would rewrite" : "rewritten"}: ${stats.messagesRewritten} (${stats.proposalsConverted} proposals); ` +
      `unknown kinds left as they were: ${stats.unknown}; conflicts (run again): ${stats.conflicts}`
  );
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
