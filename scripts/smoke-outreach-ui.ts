import "./smoke/_env";
import { run } from "./smoke/_env";
import assert from "node:assert/strict";
import { getDb } from "../src/db";
import {
  outreachCampaigns,
  outreachProspects,
  outreachMessages,
  outreachConversations,
  outreachJobs,
} from "../src/db/schema";
import { outreachOverview } from "../src/lib/outreach-v2/overview";
import {
  appendNewPeople,
  draftIsDirty,
  draftValues,
} from "../src/components/outreach/outreach-workspace-types";

run(async () => {
  const db = await getDb();
  const [campaign, other, historical] = await db
    .insert(outreachCampaigns)
    .values([
      { userId: "ui-owner", name: "100-person review", version: 2 },
      { userId: "ui-other", name: "Private campaign", version: 2 },
      {
        userId: "ui-owner",
        name: "Historical SMS",
        version: 1,
        defaultChannel: "sms",
        status: "archived",
      },
    ])
    .returning();
  const people = await db
    .insert(outreachProspects)
    .values(
      Array.from({ length: 100 }, (_, i) => ({
        campaignId: campaign.id,
        externalId: `fixture-${i}`,
        fullName: `Person ${i}`,
        status: i === 8 ? "skipped" : "suggested",
      })),
    )
    .returning();
  const messages = await db
    .insert(outreachMessages)
    .values(
      people.map((p, i) => ({
        prospectId: p.id,
        channel: "email",
        body: `Hello ${i}`,
        signature: "Alex\nProduct designer",
        toAddress: `${i}@example.test`,
        revision: 2,
        approvedRevision: i === 2 ? 2 : null,
        executionStatus:
          [
            "confirmed",
            "accepted",
            "idle",
            "queued",
            "sending",
            "needs_verification",
            "failed",
            "cancelled",
          ][i] ?? "idle",
      })),
    )
    .returning();
  await db
    .insert(outreachConversations)
    .values([
      {
        userId: "ui-owner",
        campaignId: campaign.id,
        prospectId: people[0].id,
        unread: true,
        outcome: "positive_reply",
      },
    ]);
  await db.insert(outreachJobs).values([
    {
      userId: "ui-owner",
      campaignId: campaign.id,
      kind: "send",
      key: "ui-failed",
      status: "failed",
    },
    {
      userId: "ui-owner",
      campaignId: campaign.id,
      kind: "browser_send",
      key: "ui-uncertain",
      status: "needs_verification",
    },
    {
      userId: "ui-owner",
      campaignId: campaign.id,
      kind: "search",
      key: "ui-search",
      status: "failed",
    },
    {
      userId: "ui-other",
      campaignId: other.id,
      kind: "send",
      key: "ui-other-failed",
      status: "failed",
    },
  ]);
  const result = await outreachOverview("ui-owner");
  assert.equal(result.length, 2);
  assert(!result.some((c) => c.id === other.id));
  const summary = result.find((c) => c.id === campaign.id)!;
  assert.equal(summary.people, 99);
  assert.equal(
    summary.drafts,
    93,
    "only editable, unapproved messages for included people need review",
  );
  assert.equal(summary.ready, 1);
  assert.equal(summary.sent, 1, "provider acceptance is not a confirmed send");
  assert.equal(summary.unread, 1);
  assert.equal(summary.positive, 1);
  assert.equal(summary.issues, 2, "search failures are not sending issues");
  assert.equal(result.find((c) => c.id === historical.id)?.drafts, 0);
  assert.deepEqual(await outreachOverview("unknown-user"), []);

  const approved = messages[2];
  const edit = draftValues(approved);
  assert.equal(draftIsDirty(approved, edit), false);
  edit.signature += "\nNew signature";
  assert.equal(
    draftIsDirty(approved, edit),
    true,
    "signature changes invalidate visible approval",
  );
  const buffers = { [approved.id]: edit };
  assert.equal(
    buffers[approved.id].signature,
    edit.signature,
    "draft state is keyed independently of the mounted editor",
  );
  assert.equal(
    draftIsDirty({ ...approved, revision: 3 }, edit),
    true,
    "a remote revision preserves a local conflict",
  );
  assert.deepEqual(
    appendNewPeople(["a", "b"], ["b", "c", "a"]),
    ["a", "b", "c"],
    "arriving research cannot reorder existing rows",
  );
  assert.deepEqual(appendNewPeople(["a", "b"], ["b", "c"]), ["b", "c"]);
  console.log(
    "Outreach UI: 100-person summaries, tenant isolation, legacy history, approval state, and stable ranking passed.",
  );
});
