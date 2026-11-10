/**
 * HubSpot outbox write delivery.
 */
import { getConnectorConnection, loadConnectorConnection } from "@/lib/connectors/connections";
import type { DeliverResult, OutboxItem } from "@/lib/connectors/outbox";
import { freshHubSpotToken, hubspotRequest, HubSpotReauthError } from "@/lib/connectors/hubspot";

export async function deliverHubSpot(item: OutboxItem): Promise<DeliverResult> {
  const summary = await getConnectorConnection(item.userId, "hubspot");
  if (!summary) {
    return { ok: false, error: "HubSpot is not connected", retryable: false };
  }

  const conn = await loadConnectorConnection(summary.id);
  if (!conn) {
    return { ok: false, error: "HubSpot connection could not be loaded", retryable: false };
  }

  if (!conn.capabilities.includes(item.action)) {
    return {
      ok: false,
      error: `HubSpot write capability ${item.action} is not enabled`,
      retryable: false,
    };
  }

  let token: string;
  try {
    token = await freshHubSpotToken(conn);
  } catch (err) {
    if (err instanceof HubSpotReauthError) {
      return { ok: false, error: err.message, retryable: false };
    }
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  try {
    if (item.action === "writeContact") {
      const payload = item.payload as {
        fullName?: string;
        firstName?: string;
        lastName?: string;
        email?: string;
        phone?: string;
        company?: string;
        title?: string;
      };

      let firstName = payload.firstName;
      let lastName = payload.lastName;
      if (!firstName && payload.fullName) {
        const parts = payload.fullName.trim().split(" ");
        firstName = parts[0];
        lastName = parts.slice(1).join(" ");
      }

      const res = await hubspotRequest<{ id: string }>(token, "/crm/v3/objects/contacts", {
        method: "POST",
        body: {
          properties: {
            firstname: firstName ?? "",
            lastname: lastName ?? "",
            email: payload.email ?? "",
            phone: payload.phone ?? "",
            company: payload.company ?? "",
            jobtitle: payload.title ?? "",
          },
        },
      });

      return { ok: true, remoteId: res.id };
    }

    if (item.action === "logActivity") {
      const payload = item.payload as {
        body?: string;
        notes?: string;
        timestamp?: string;
      };

      const res = await hubspotRequest<{ id: string }>(token, "/crm/v3/objects/notes", {
        method: "POST",
        body: {
          properties: {
            hs_timestamp: payload.timestamp ?? new Date().toISOString(),
            hs_note_body: payload.body || payload.notes || "Interaction logged from Orbit",
          },
        },
      });

      return { ok: true, remoteId: res.id };
    }

    if (item.action === "writeTask") {
      const payload = item.payload as {
        title?: string;
        body?: string;
      };

      const res = await hubspotRequest<{ id: string }>(token, "/crm/v3/objects/tasks", {
        method: "POST",
        body: {
          properties: {
            hs_task_subject: payload.title ?? "Follow-up",
            hs_task_body: payload.body ?? "",
            hs_task_status: "NOT_STARTED",
          },
        },
      });

      return { ok: true, remoteId: res.id };
    }

    return { ok: false, error: `Unsupported HubSpot action ${item.action}`, retryable: false };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      retryable: !(err instanceof HubSpotReauthError),
    };
  }
}
