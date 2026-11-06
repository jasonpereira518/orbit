import { StatPillExplainer } from "@/components/contacts/stat-pill-explainer";
import type { RelationshipHealth } from "@/lib/relationship-health";

const W = 56;
const H = 14;

function replyPhrase(hours: number): string {
  if (hours < 1) return "replies within the hour";
  if (hours < 36) return `replies in ~${Math.round(hours)}h`;
  return `replies in ~${Math.round(hours / 24)}d`;
}

function balancePhrase(
  inbound: number,
  outbound: number,
  reciprocity: number | null,
): string | null {
  if (reciprocity == null) return null;
  // Raw split, not the score: the score forgives up to 2:1, the label says what happened.
  if (Math.min(inbound, outbound) / Math.max(inbound, outbound) >= 0.5) return "balanced";
  return inbound > outbound ? "mostly them" : "mostly you";
}

/**
 * The contact's relationship health over the last six months, as a pill that explains
 * itself on tap.
 *
 * The house rule against sparklines (admin/primitives.tsx) is about autoscaling: 0,1,0,0,2
 * drawn as a cliff. So the y-domain here is fixed at 0–100 and never fits the data, and the
 * integer is always on screen beside the line.
 */
export function HealthSparkline({ health }: { health: RelationshipHealth }) {
  const { points, current, components: c } = health;
  const step = W / (points.length - 1);
  const line = points
    .map((p, i) => `${(i * step).toFixed(1)},${(H - (p / 100) * H).toFixed(1)}`)
    .join(" ");
  const first = points[0];
  const days = Math.round(c.daysSinceTouch);
  const reply =
    c.medianReplyHours != null ? replyPhrase(c.medianReplyHours) : null;
  const balance = balancePhrase(c.inbound, c.outbound, c.reciprocity);
  const touch = days === 0 ? "touched today" : `last touch ${days}d ago`;
  const touchLong =
    days === 0 ? "Today" : days === 1 ? "Yesterday" : `${days} days ago`;
  const detail = [reply, balance, touch].filter(Boolean).join(" · ");
  // Scored points floor at 1, so a leading 0 means no touch yet.
  const change =
    first === 0
      ? null
      : current === first
        ? "unchanged"
        : `${current > first ? "up" : "down"} from ${first}`;
  const trend = change
    ? `${change} six months ago`
    : "first touch within the last six months";

  return (
    <StatPillExplainer
      label={`Relationship health ${current} of 100, ${trend}. ${detail}. Show what this means.`}
      className="gap-2 border border-border bg-transparent"
      title={`Health ${current} · how it's going`}
      body={
        <>
          <p className="text-muted-foreground">
            Whether the relationship is two-way and active right now. Scored
            0–100 on its own, not against the rest of your network, and recency
            is measured against how often you keep in touch.
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted-foreground">Reply speed</dt>
            <dd>
              {reply
                ? reply[0].toUpperCase() + reply.slice(1)
                : "Not enough back-and-forth yet"}
            </dd>
            <dt className="text-muted-foreground">Who writes</dt>
            <dd>
              {balance
                ? balance[0].toUpperCase() + balance.slice(1)
                : "Not enough messages yet"}
            </dd>
            <dt className="text-muted-foreground">Last touch</dt>
            <dd>{touchLong}</dd>
          </dl>
          <p className="text-muted-foreground">
            The line shows the last six months
            {change ? `: ${change}.` : "."}
          </p>
          <p className="border-t pt-2 text-muted-foreground">
            Closeness is how much they matter; health is how the conversation is
            going. Someone close can still be going quiet.
          </p>
        </>
      }
    >
      Health {current}
      {/* Wrapped: the badge styles force any direct child svg to size-3. */}
      <span className="flex">
        <svg
          aria-hidden
          width={W}
          height={H}
          viewBox={`0 -1 ${W} ${H + 2}`}
          className="overflow-visible text-muted-foreground"
        >
          <line
            x1={0}
            x2={W}
            y1={H}
            y2={H}
            stroke="currentColor"
            strokeOpacity={0.25}
            strokeWidth={1}
          />
          <polyline
            points={line}
            fill="none"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
        </svg>
      </span>
    </StatPillExplainer>
  );
}
