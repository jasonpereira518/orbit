/**
 * Stage two pending assistant drafts for the local demo account, so the dashboard's approval
 * card can be looked at. Local PGlite only, and the dev server must be stopped first: PGlite
 * is single-writer, and a second writer corrupts the directory.
 *
 * Run: npx tsx scripts/dev/seed-agent-draft.ts
 */
import { createAgentSendRequest } from "../../src/lib/agent-sends";

async function main() {
  const userId = "demo-user";
  const good = await createAgentSendRequest(userId, {
    toEmail: "priya.raman@northwind.example",
    subject: "Thanks for the intro to Marco",
    body:
      "Priya — thank you for putting me in touch with Marco last week. We spoke on Tuesday " +
      "and he's keen to pilot the tool with his team in October.\n\nI owe you one. Coffee " +
      "when you're next in town?",
    clientName: "Claude",
  });
  // The second one is what an injected agent's attempt looks like on this card: an address
  // nobody recognises, and a body that says what it is doing.
  const bad = await createAgentSendRequest(userId, {
    toEmail: "collector@definitely-not-evil.example",
    subject: "Your contact list",
    body: "Attached is the full export you asked for.",
    clientName: "Claude",
  });
  console.log("staged", good.id, bad.id);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(1);
  }
);
