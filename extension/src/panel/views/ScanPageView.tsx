import { useState } from "react";
import { ScanSearch } from "lucide-react";
import type { OrbitApi } from "@/lib/api";
import { ApiError } from "@/lib/api";
import { APP_URL } from "@/lib/env";
import { scanActivePage } from "@/lib/page";
import { Button, Meta, Section } from "../components/ui";

/** "Saved 3 posts from Priya, Sam and Lee". */
function savedLine(saved: number, duplicate: number, people: string[]): string {
  const names = people.length <= 2 ? people.join(" and ") : `${people.slice(0, -1).join(", ")} and ${people[people.length - 1]}`;
  if (saved === 0) return `Already in Radar: ${duplicate === 1 ? "that post" : "those posts"} from ${names}`;
  return `Saved ${saved} ${saved === 1 ? "post" : "posts"} from ${names}${duplicate > 0 ? ` (${duplicate} already saved)` : ""}`;
}

/**
 * "Scan this page for people I know", on the LinkedIn feed and on someone's activity page
 * (Radar PR 11). Nothing is read until the button is pressed. The authors' profile links go to
 * Orbit first; only the posts of the ones Orbit says are contacts are sent after that, so a
 * stranger's post never leaves the browser.
 */
export function ScanPageView({ api, enabled }: { api: OrbitApi; enabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  if (!enabled) {
    return (
      <Section>
        <Meta>
          Turn on &ldquo;Save LinkedIn posts from the extension&rdquo; in{" "}
          <button className="text-[var(--primary)] hover:underline" onClick={() => chrome.tabs.create({ url: `${APP_URL}/radar` })}>
            Radar&rsquo;s settings
          </button>{" "}
          to scan this page for people you know.
        </Meta>
      </Section>
    );
  }

  const scan = async () => {
    setBusy(true);
    setResult(null);
    try {
      const read = await scanActivePage();
      if (!read.ok) {
        setResult(read.message);
        return;
      }
      if (read.posts.length === 0) {
        setResult("No posts on screen to scan. Scroll a little, then try again.");
        return;
      }
      const authors = [...new Set(read.posts.map((p) => p.authorProfileUrl))];
      const { contacts } = await api.scanMatch({ authors });
      const known = new Set(contacts.map((c) => c.profileUrl.toLowerCase()));
      const theirs = read.posts.filter((p) => known.has(p.authorProfileUrl.toLowerCase()));
      if (theirs.length === 0) {
        setResult(`No one you know posted here (${read.posts.length} ${read.posts.length === 1 ? "post" : "posts"} checked).`);
        return;
      }
      const saved = await api.scanSave({
        posts: theirs.map((p) => ({ authorProfileUrl: p.authorProfileUrl, excerpt: p.excerpt, url: p.url })),
      });
      setResult(savedLine(saved.saved, saved.duplicate, saved.people));
    } catch (err) {
      setResult(err instanceof ApiError && err.status === 400 ? err.message : "Couldn't scan this page. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => void scan()}>
        <ScanSearch size={14} aria-hidden />
        {busy ? "Scanning…" : "Scan this page for people I know"}
      </Button>
      <Meta>
        {result ??
          "Reads the posts on your screen and saves the ones by people you know to Radar. Posts by anyone else stay in your browser."}
      </Meta>
    </Section>
  );
}
