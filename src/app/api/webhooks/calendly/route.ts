import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { contacts, interactions, connectorConnections } from "@/db/schema";
import { and, eq } from "drizzle-orm";
import { createHmac, timingSafeEqual } from "crypto";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const secret = process.env.CALENDLY_WEBHOOK_SIGNING_KEY;
  const rawBody = await request.text();

  if (secret) {
    const signature = request.headers.get("calendly-webhook-signature");
    if (!signature) {
      return NextResponse.json({ error: "Missing signature" }, { status: 401 });
    }

    // Signature format: t=timestamp,v1=signature
    const parts = Object.fromEntries(
      signature.split(",").map((p) => {
        const [k, v] = p.split("=");
        return [k.trim(), v?.trim()];
      })
    );

    if (!parts.t || !parts.v1) {
      return NextResponse.json({ error: "Invalid signature format" }, { status: 401 });
    }

    const payloadToSign = `${parts.t}.${rawBody}`;
    const expected = createHmac("sha256", secret).update(payloadToSign).digest("hex");
    const expectedBuf = Buffer.from(expected, "hex");
    const actualBuf = Buffer.from(parts.v1, "hex");

    if (expectedBuf.length !== actualBuf.length || !timingSafeEqual(expectedBuf, actualBuf)) {
      return NextResponse.json({ error: "Invalid signature" }, { status: 401 });
    }
  }

  let event: {
    event?: string;
    payload?: {
      email?: string;
      name?: string;
      event?: string;
      uri?: string;
      scheduled_event?: {
        name?: string;
        start_time?: string;
        end_time?: string;
      };
    };
  };

  try {
    event = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  if (event.event !== "invitee.created" || !event.payload?.email) {
    return NextResponse.json({ received: true });
  }

  const email = event.payload.email.toLowerCase().trim();
  const name = event.payload.name?.trim() || email.split("@")[0];
  const scheduledTime = event.payload.scheduled_event?.start_time
    ? new Date(event.payload.scheduled_event.start_time)
    : new Date();
  const eventTitle = event.payload.scheduled_event?.name || "Calendly Meeting";
  const externalId = `calendly:${event.payload.uri ?? event.payload.event ?? Date.now()}`;

  const db = await getDb();

  // Find users who have an active Calendly connection
  const connections = await db
    .select({ userId: connectorConnections.userId })
    .from(connectorConnections)
    .where(and(eq(connectorConnections.connectorId, "calendly"), eq(connectorConnections.status, "active")));

  for (const conn of connections) {
    // Find or create contact
    let [contact] = await db
      .select({ id: contacts.id })
      .from(contacts)
      .where(and(eq(contacts.userId, conn.userId), eq(contacts.email, email)))
      .limit(1);

    if (!contact) {
      const parts = name.split(" ");
      const [newContact] = await db
        .insert(contacts)
        .values({
          userId: conn.userId,
          fullName: name,
          firstName: parts[0] || null,
          lastName: parts.slice(1).join(" ") || null,
          email,
        })
        .returning();
      if (newContact) {
        contact = { id: newContact.id };
      }
    }

    if (contact) {
      const [existing] = await db
        .select({ id: interactions.id })
        .from(interactions)
        .where(and(eq(interactions.userId, conn.userId), eq(interactions.externalId, externalId)))
        .limit(1);

      if (!existing) {
        await db.insert(interactions).values({
          userId: conn.userId,
          contactId: contact.id,
          source: "calendly",
          externalId,
          interactionDate: scheduledTime,
          interactionType: "meeting",
          rawNotes: eventTitle,
        });
      }
    }
  }

  return NextResponse.json({ ok: true });
}
