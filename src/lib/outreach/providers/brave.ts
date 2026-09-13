import { fetchWithRetry } from "@/lib/outreach/providers/http";
import {
  isProviderError,
  type FetchLike,
  type KeyCheck,
  type SearchPage,
  type SearchProvider,
} from "@/lib/outreach/providers/types";

const BRAVE_WEB_SEARCH = "https://api.search.brave.com/res/v1/web/search";

type BraveResponse = {
  query?: { more_results_available?: boolean };
  web?: { results?: Array<{ url?: string; title?: string; description?: string; extra_snippets?: string[] }> };
};

type Deps = { fetch?: FetchLike; sleep?: (ms: number) => Promise<void> };

/** Brave Web Search (`count` ≤ 20, `offset` ≤ 9 per the API docs). */
export function createBraveSearch(apiKey: string, deps: Deps = {}): SearchProvider {
  const fetchImpl = deps.fetch ?? ((url, init) => fetch(url, init));
  return {
    name: "brave",
    async search(q, { count, offset, signal }): Promise<SearchPage> {
      const url = new URL(BRAVE_WEB_SEARCH);
      url.searchParams.set("q", q);
      url.searchParams.set("count", String(Math.min(20, Math.max(1, Math.floor(count)))));
      url.searchParams.set("offset", String(Math.min(9, Math.max(0, Math.floor(offset)))));
      url.searchParams.set("extra_snippets", "true");
      url.searchParams.set("result_filter", "web");
      const response = await fetchWithRetry(
        fetchImpl,
        url.toString(),
        { method: "GET", headers: { Accept: "application/json", "X-Subscription-Token": apiKey }, signal },
        { provider: "brave", sleep: deps.sleep }
      );
      const body = (await response.json()) as BraveResponse;
      return {
        results: (body.web?.results ?? [])
          .filter((r) => typeof r.url === "string")
          .map((r) => ({
            url: r.url!,
            title: r.title ?? "",
            description: r.description ?? "",
            extraSnippets: Array.isArray(r.extra_snippets) ? r.extra_snippets.slice(0, 5) : [],
          })),
        moreAvailable: Boolean(body.query?.more_results_available),
      };
    },
  };
}

export async function verifyBraveKey(apiKey: string, deps: Deps = {}): Promise<KeyCheck> {
  try {
    await createBraveSearch(apiKey, deps).search("linkedin", { count: 1, offset: 0 });
    return "valid";
  } catch (err) {
    return isProviderError(err) && err.kind === "auth" ? "invalid" : "unverified";
  }
}
