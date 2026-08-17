/** Stable, non-class-name signals: meta tags, JSON-LD, and the document title. */

export function metaContent(...names: string[]): string | null {
  for (const name of names) {
    const el =
      document.querySelector(`meta[property="${name}"]`) ??
      document.querySelector(`meta[name="${name}"]`);
    const value = el?.getAttribute("content")?.trim();
    if (value) return value;
  }
  return null;
}

export function canonicalUrl(): string | null {
  const href = document
    .querySelector('link[rel="canonical"]')
    ?.getAttribute("href")
    ?.trim();
  return href || null;
}

export type JsonLdPerson = {
  name?: string;
  jobTitle?: string;
  worksFor?: string;
  alumniOf?: string;
  address?: string;
  image?: string;
  email?: string;
  url?: string;
};

function asText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (Array.isArray(value)) return asText(value[0]);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return asText(obj.name ?? obj.legalName ?? obj.addressLocality ?? obj.url);
  }
  return undefined;
}

/** Walk every ld+json block looking for a Person. Absent in most SPA renders. */
export function jsonLdPerson(): JsonLdPerson | null {
  const blocks = Array.from(
    document.querySelectorAll('script[type="application/ld+json"]')
  );

  const visit = (node: unknown, depth = 0): JsonLdPerson | null => {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
      for (const item of node) {
        const found = visit(item, depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node !== "object") return null;
    const obj = node as Record<string, unknown>;

    const type = obj["@type"];
    const types = Array.isArray(type) ? type : [type];
    if (types.includes("Person")) {
      return {
        name: asText(obj.name),
        jobTitle: asText(obj.jobTitle),
        worksFor: asText(obj.worksFor),
        alumniOf: asText(obj.alumniOf),
        address: asText(obj.address),
        image: asText(obj.image),
        email: asText(obj.email),
        url: asText(obj.url),
      };
    }

    for (const value of Object.values(obj)) {
      const found = visit(value, depth + 1);
      if (found) return found;
    }
    return null;
  };

  for (const block of blocks) {
    try {
      const found = visit(JSON.parse(block.textContent ?? ""));
      if (found?.name) return found;
    } catch {
      // A malformed block is not worth failing the whole extraction over.
    }
  }
  return null;
}

/**
 * LinkedIn's title has been "Name - Headline | LinkedIn" for many years, which
 * makes it a more durable source than any selector on the page.
 */
export function parseTitle(
  raw: string,
  suffixes: string[]
): { name: string | null; rest: string | null } {
  let text = raw.trim();
  for (const suffix of suffixes) {
    const idx = text.toLowerCase().lastIndexOf(suffix.toLowerCase());
    if (idx > 0) text = text.slice(0, idx).trim();
  }
  text = text.replace(/[|·–—-]\s*$/, "").trim();
  if (!text) return { name: null, rest: null };

  const match = text.match(/^(.+?)\s+[-–—|]\s+(.+)$/);
  if (match) return { name: match[1].trim(), rest: match[2].trim() };
  return { name: text, rest: null };
}
