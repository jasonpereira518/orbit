import { listTodaySuggestions } from "@/actions/follow-ups";
import { SuggestionCard } from "@/components/reminders/suggestion-card";

/**
 * "Who should you talk to today" — the engine's picks, with their reasons.
 *
 * A separate question from `SuggestedRemindersPanel`, which reviews unconfirmed
 * commitments extracted from the user's own notes. The two stay apart on purpose.
 */
export async function TodaySection() {
  const suggestions = await listTodaySuggestions();
  if (!suggestions.length) return null;

  return (
    <div className="reveal-mount">
      <section className="space-y-3 rounded-2xl border border-border/60 bg-card/60 p-5">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium text-foreground">Today</h2>
          <span className="text-xs text-muted-foreground">
            {suggestions.length} to follow up with
          </span>
        </div>
        <div className="space-y-2">
          {suggestions.map((suggestion) => (
            <SuggestionCard key={suggestion.id} suggestion={suggestion} />
          ))}
        </div>
      </section>
    </div>
  );
}
