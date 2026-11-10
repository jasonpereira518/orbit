/**
 * Apple Contacts (iCloud CardDAV) sync.
 *
 * Auth kind: dav_password, stored in connector_connections.
 * The stored connection holds:
 *   - accountRef: Apple ID (email)
 *   - accessToken: decrypted app-specific password
 *   - cursor: { addressBookUrl, syncToken, ... }
 */
import {
  loadConnectorConnection,
  markConnectorNeedsReauth,
  markConnectorSyncResult,
} from "@/lib/connectors/connections";
import {
  CalDavAuthError,
  discoverAddressBook,
  fetchAddressBookChanges,
  type CalDavCredentials,
} from "@/lib/caldav/client";
import { parseContactsFile } from "@/lib/contacts-file";
import { ingestPeople, type PersonRecord } from "@/lib/ingest/people";
import { finalizeIngest, openIngestContext } from "@/lib/ingest/events";
import type { ConnectorSyncCursor } from "@/db/schema";

export async function syncAppleContacts(connectionId: string): Promise<void> {
  const conn = await loadConnectorConnection(connectionId);
  if (!conn) return;
  if (!conn.accessToken || !conn.accountRef) {
    await markConnectorNeedsReauth(conn.id, "Apple ID or app password missing");
    return;
  }

  const creds: CalDavCredentials = {
    username: conn.accountRef,
    password: conn.accessToken,
  };

  const cursor: ConnectorSyncCursor = { ...conn.cursor };
  let addressBookUrl = cursor.addressBookUrl;

  try {
    if (!addressBookUrl) {
      const discovery = await discoverAddressBook(creds);
      addressBookUrl = discovery.addressBookUrl;
      cursor.addressBookUrl = addressBookUrl;
    }

    const { vCards, nextSyncToken } = await fetchAddressBookChanges(
      creds,
      addressBookUrl,
      cursor.syncToken ?? null
    );

    if (vCards.length > 0) {
      const combinedVCard = vCards.join("\n\n");
      const parsed = parseContactsFile(combinedVCard, "icloud.vcf");
      const people: PersonRecord[] = parsed.rows
        .map((r) => ({
          fullName: r.fullName,
          email: r.email || null,
          phone: r.phone || null,
          company: r.company || null,
          title: r.title || null,
          linkedinUrl: r.linkedinUrl || null,
          notes: r.notes || null,
        }))
        .filter((p) => Boolean(p.fullName));

      if (people.length > 0) {
        const ctx = await openIngestContext(conn.userId, {
          source: "apple_contacts",
          createsContacts: true,
        });
        await ingestPeople(ctx, people);
        await finalizeIngest(ctx, { recalibrate: !conn.cursor?.syncedThrough });
      }
    }

    cursor.syncToken = nextSyncToken ?? cursor.syncToken;
    cursor.syncedThrough = new Date().toISOString();

    await markConnectorSyncResult(conn.id, {
      ok: true,
      cursor,
    });
  } catch (err) {
    if (err instanceof CalDavAuthError) {
      await markConnectorNeedsReauth(conn.id, "iCloud signed Orbit out — check app-specific password");
      return;
    }
    throw err;
  }
}
