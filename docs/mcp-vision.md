# The MCP server: Orbit inside the assistant

_Written Sep 19 2026, when the connector went from a Pro extra to the front door._

## Where this came from

The MCP server shipped in #137 as a side effect of the connector platform: six tools, gated
behind `canUseApi`, installed by pasting a secret URL into claude.ai because that UI had no
field for a header. It worked, and almost nobody could have found it — the only copy about it
in the entire product was one line in Settings.

That was backwards. Asking an assistant "who do I know at Stripe?" and getting a real answer
explains Orbit in one sentence, which no landing page has managed. The surface most likely to
sell the product was the one a new user could not reach.

## The vision

**Orbit is the memory; your assistant is the brain.**

Orbit exposes a person's network as clean structured data plus a small set of safe actions.
All the reasoning, summarising and drafting happens in the client's own model. Orbit runs no
LLM call on behalf of MCP — which costs it nothing in BYOK or managed-key budget, and means no
second model of ours ever reads a note an attacker may have written.

### Five principles

1. **It installs like a first-class connector.** Paste the URL, sign in with Orbit, done. OAuth
   through Clerk, no key to copy. The bearer-key path stays for Cursor, n8n and the command
   line, where a header is natural.

2. **Free on every plan.** `canUseMcp` is true everywhere. This is the acquisition hook, and a
   paywall in front of a demonstration is a paywall in front of the demonstration. The limits
   that cost real money still bind underneath: the free contact cap bounds `create_contact`,
   the free plan has its own rate bucket, and Orbit's own sending credits stay paid.

3. **Read broadly, write carefully, never delete.** Tools that read and write; none that
   deletes a contact, merges two people, removes a tag, or archives anything. Everything an
   agent writes as text carries `source: "mcp"`, so the timeline can always tell its words from
   the user's.

4. **An agent can compose. Only a human can send.** `request_send` writes a row and returns
   `pending_approval`. The send happens in a Clerk-authenticated server action, from a card
   that shows the recipient in full and the body as plain text. No tool, key or OAuth scope
   reaches that function.

5. **Data is fenced, text is sanitised.** Every returned record is wrapped in a note saying it
   is untrusted data. The free-text `notes` field never fans out through search. Agent-written
   text passes through `sanitizeAgentText` before it is stored.

## Why an arbitrary recipient is allowed

The obvious safe answer is to let an agent write only to addresses already on a contact. We
chose not to, and the reason is worth stating because it looks like the less careful choice.

A recipient allowlist protects against exfiltration only if the allowlist is smaller than the
attacker's ambition — and it isn't: a contact's own address is enough to leak to, if the
attacker is the contact. What actually bounds the damage is that a person reads the recipient
and the message before either goes anywhere. Given that, the allowlist buys very little and
costs the ordinary case a great deal ("email the recruiter back" fails because they were never
imported).

So the control is the approval card, and the card is designed for the job: the full address,
never hidden behind a display name; an explicit flag when the address is not in the network;
the body as plain text, editable, never rendered as markup.

The failure mode we are designing against is not a careless user. It is a capable model that
has been talked into something by text it read, confidently and with a good explanation. That
model can now produce exactly one artefact: a card in the user's own dashboard, addressed to
somewhere strange, saying what it is doing.

## The tools Orbit's chat brought with it

_Added Oct 20 2026, with the chat revamp (`docs/superpowers/plans/2026-10-19-chat-agent.md`)._

Orbit's own chat gained read tools for every feature — exact counts over contacts and
interactions, events and their rosters, opportunities, radar, outreach campaigns, recruiters,
the relationship dossier, sent email, captures and imports — and a catalog of writes. MCP has
them on the same terms as everything else here:

- **Each read declares its MCP fields** next to the tool (`fields.mcp` in
  `src/lib/tools/definitions-features.ts`). None returns raw note text; interaction rows carry
  the short AI summary; sent email is subjects only; a capture's title and excerpt — its raw
  text — never leave Orbit's own chat.
- **A read behind a page follows the page.** Events, radar, outreach, recruiters, knowledge,
  capture and imports can ship closed. Their tools are offered to an outside agent only once
  that page is released to the user (`releasedToolsFor`), exactly as in chat — so a
  coming-soon page cannot go live through an assistant first.
- **The writes are the catalog's own** (`MCP_CHAT_WRITE_TOOLS` in
  `src/lib/tools/chat-writes.ts`): add tags, reschedule a reminder, add an event, mark who the
  user spoke to at one. Same validation and ownership checks as a confirmed chat card; on MCP
  they run directly, as MCP writes always have. The catalog's deletes and `remove_tags` are
  not offered, and `create_event` has no link field — Orbit fetches no page an agent names.

## What is deliberately absent

- **No `send_email`, `fetch_url` or `create_webhook_endpoint`.** `hostedSending` exists in
  `entitlements.ts` and the plumbing is one import away. That distance is the control, and
  `smoke-agent-sends.ts` fails if the MCP server so much as imports a send path.
- **No `ask_network` tool.** Orbit's own chat pipeline feeds stored notes into a prompt. Wrapping
  it would mean a poisoned note reaching a second model whose answer then returns to the first.
  The client's model can reason over search results perfectly well.
- **No capture or drafting tools.** Same reason in reverse: they are LLM calls, and this surface
  spends none.
- **No delete, merge or remove.** Destructive and irreversible-feeling actions stay where a
  person can see the whole context — in Orbit's own chat they are cards a person confirms.

## The shape of the code

| Concern | Where |
| --- | --- |
| Tool definitions, fencing, the security contract | `src/lib/mcp/server.ts` |
| Transport, auth, rate limiting | `src/lib/mcp/handle.ts` |
| OAuth verification and discovery metadata | `src/lib/mcp/oauth.ts`, `src/app/.well-known/**` |
| Drafts an agent can write | `src/lib/agent-sends.ts` |
| The one function that sends | `src/lib/agent-send-approve.ts` |
| The approval card | `src/components/dashboard/agent-drafts-card.tsx` |
| Standing guarantees | `scripts/smoke-mcp-server.ts`, `scripts/smoke-agent-sends.ts` |

Every tool wraps a function in `src/lib` that takes a `userId`. None calls a server action:
those start with `requireUserId()`, which asks Clerk for a browser session a tool call does not
have. When a write only existed as an action, its body moved into `src/lib` and the action
became a wrapper — that is what `src/lib/reminder-writes.ts` is.

## Open questions

- **Scopes.** An OAuth caller currently gets read and write flat, because Clerk's dynamic
  clients arrive with whatever default scopes the instance publishes. If Clerk's custom scopes
  prove reliable, `orbit:read` / `orbit:write` would let a user connect a read-only assistant.
- **Retiring the path token.** `/api/mcp/[token]` and the `mcp_url` key kind exist only for
  connectors configured before OAuth. Remove them once none have been used for a while.
- **Where drafts live.** The approval card is on the dashboard. If assistant drafts become
  common, they may deserve a home of their own next to Reminders.
