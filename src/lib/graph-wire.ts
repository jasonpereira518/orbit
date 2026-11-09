/**
 * The constellation payload's wire form.
 *
 * `loadGraphData` returns objects: one per contact, each repeating twenty keys, every cluster
 * repeating the contact ids it contains, each date as an ISO-ish epoch value and each flag as
 * a key. At 10,000 contacts that is 5.2 MB of JSON (518 B a head), of which most is structure
 * the receiver reconstructs anyway. This module rewrites the same data column by column before
 * it crosses the server-action boundary and restores it on the other side, so:
 *
 *   - each field name is written once, not once per contact;
 *   - the low-cardinality strings (company, school, title, tier, industry, tags) become integer
 *     indexes into a dictionary;
 *   - the three contact flags become one bitfield;
 *   - a cluster's members are indexes into the contact column rather than repeated ids.
 *
 * Measured on the 10,000-contact fixture (`scripts/lib/scale-fixture.ts`): 5.18 MB → 1.75 MB of
 * JSON, a 66% cut. Brotli already compresses the raw payload ~12x, so the transfer saving is
 * smaller than the raw one — but the server does less stringifying, the client parses and
 * allocates a third of the text, and the payload budget stops being an exercise in luck.
 *
 * The decoded value is byte-for-byte the object `loadGraphData` built (same keys in the same
 * order, same `Date` objects), so no caller knows this exists. `smoke-graph-wire` proves that
 * with a round-trip stringify comparison. Bump `GRAPH_WIRE_VERSION` on any shape change: the
 * encoder and decoder ship together, and a mismatch is a bug rather than a migration, so the
 * decoder refuses instead of guessing.
 */
import type { loadGraphData } from "@/lib/graph-data";

export type GraphPayload = Awaited<ReturnType<typeof loadGraphData>>;
export type GraphContact = GraphPayload["contacts"][number];
export type GraphCluster = GraphPayload["clusters"][number];

export const GRAPH_WIRE_VERSION = 1;

type Ms = number | null;

/** One column per contact field, plus dictionaries for the repetitive string columns. */
export type GraphWire = {
  v: typeof GRAPH_WIRE_VERSION;
  /** `userId` */
  u: string;
  c: {
    /** `id` */
    id: string[];
    /** `fullName` */
    n: string[];
    /** `preferredName` */
    pn: (string | null)[];
    /** `company` — index into `d.co`, -1 when null */
    co: number[];
    /** `school` — index into `d.sc` */
    sc: number[];
    /** `title` — index into `d.ti` */
    ti: number[];
    /** `industry` — index into `d.ind`, -1 when the field is absent */
    ind: number[];
    /** `relationshipScore` */
    rs: number[];
    /** `closeness` */
    cl: number[];
    /** `closenessTier` — index into `d.ct` */
    ct: number[];
    /** `orbitScore` */
    os: number[];
    /** `lastInteractionAt`, epoch milliseconds; null when unset */
    li: Ms[];
    /** `nextFollowUpAt`, epoch milliseconds; null when unset */
    fol: Ms[];
    /** `hasLoggedInteraction` (1) | `dormant` (2) | `substantive` (4) */
    fl: number[];
    /** `tags` — indexes into `d.tg` */
    tg: number[][];
    /** `aiSummary` */
    ai: (string | null)[];
    /** `keyFacts` */
    kf: (string[] | null)[];
    /** `profileImageUrl` */
    av: (string | null)[];
  };
  /** Clusters, with members as indexes into `c.id`. */
  cl: {
    id: string[];
    n: string[];
    k: GraphCluster["kind"][];
    c: number[];
    m: number[][];
  };
  /** Contact-field dictionaries. */
  d: {
    co: string[];
    sc: string[];
    ti: string[];
    ind: string[];
    ct: string[];
    tg: string[];
  };
  /** `companies`, `schools`, `tags` — the filter lists, already small. */
  co: string[];
  sc: string[];
  tg: string[];
  /** `summary` — small enough to carry as-is. */
  s: GraphPayload["summary"];
};

/** A `Date`, an ISO string or a nullish value → epoch milliseconds (null when unusable). */
function toMs(value: Date | string | null | undefined): Ms {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function fromMs(value: Ms): Date | null {
  return value == null ? null : new Date(value);
}

/** Values → integer indexes, with -1 for null. `values` keeps distinct strings only. */
function dictionary(values: (string | null)[]): { index: number[]; values: string[] } {
  const seen = new Map<string, number>();
  const unique: string[] = [];
  const index = values.map((value) => {
    if (value == null) return -1;
    let at = seen.get(value);
    if (at === undefined) {
      at = unique.length;
      seen.set(value, at);
      unique.push(value);
    }
    return at;
  });
  return { index, values: unique };
}

export function encodeGraphPayload(payload: GraphPayload): GraphWire {
  const { contacts, clusters } = payload;

  const company = dictionary(contacts.map((c) => c.company));
  const school = dictionary(contacts.map((c) => c.school));
  const title = dictionary(contacts.map((c) => c.title));
  const industry = dictionary(contacts.map((c) => c.industry ?? null));
  const tier = dictionary(contacts.map((c) => c.closenessTier));

  // The tag dictionary starts from the payload's own list, so that list round-trips untouched;
  // anything a contact carries that the list somehow missed is appended rather than dropped.
  const tagAt = new Map(payload.tags.map((tag, at) => [tag, at]));
  const tagValues = [...payload.tags];

  const contactAt = new Map(contacts.map((c, at) => [c.id, at]));

  return {
    v: GRAPH_WIRE_VERSION,
    u: payload.userId,
    c: {
      id: contacts.map((c) => c.id),
      n: contacts.map((c) => c.fullName),
      pn: contacts.map((c) => c.preferredName),
      co: company.index,
      sc: school.index,
      ti: title.index,
      ind: industry.index,
      rs: contacts.map((c) => c.relationshipScore),
      cl: contacts.map((c) => c.closeness),
      ct: tier.index,
      os: contacts.map((c) => c.orbitScore),
      li: contacts.map((c) => toMs(c.lastInteractionAt)),
      fol: contacts.map((c) => toMs(c.nextFollowUpAt)),
      fl: contacts.map(
        (c) =>
          (c.hasLoggedInteraction ? 1 : 0) | (c.dormant ? 2 : 0) | (c.substantive ? 4 : 0)
      ),
      tg: contacts.map((c) =>
        c.tags.map((tag) => {
          let at = tagAt.get(tag);
          if (at === undefined) {
            at = tagValues.length;
            tagAt.set(tag, at);
            tagValues.push(tag);
          }
          return at;
        })
      ),
      ai: contacts.map((c) => c.aiSummary),
      kf: contacts.map((c) => c.keyFacts),
      av: contacts.map((c) => c.profileImageUrl),
    },
    cl: {
      id: clusters.map((c) => c.id),
      n: clusters.map((c) => c.name),
      k: clusters.map((c) => c.kind),
      c: clusters.map((c) => c.count),
      m: clusters.map((c) =>
        c.contactIds.map((id) => {
          const at = contactAt.get(id);
          // Clusters are built from the same contacts this payload carries; a miss means the
          // two sets drifted, and silently dropping a member would hide that.
          if (at === undefined) {
            throw new Error(`graph wire: cluster ${c.id} references unknown contact ${id}`);
          }
          return at;
        })
      ),
    },
    d: {
      co: company.values,
      sc: school.values,
      ti: title.values,
      ind: industry.values,
      ct: tier.values,
      tg: tagValues,
    },
    co: payload.companies,
    sc: payload.schools,
    tg: payload.tags,
    s: payload.summary,
  };
}

/** The inverse of `encodeGraphPayload`; returns exactly the object `loadGraphData` built. */
export function decodeGraphPayload(wire: GraphWire): GraphPayload {
  if (wire?.v !== GRAPH_WIRE_VERSION) {
    throw new Error(
      `graph wire: expected version ${GRAPH_WIRE_VERSION}, got ${String(wire?.v)}`
    );
  }

  const { c, d } = wire;
  const contacts: GraphContact[] = new Array(c.id.length);
  for (let i = 0; i < c.id.length; i++) {
    const industry = c.ind[i] === -1 ? undefined : d.ind[c.ind[i]];
    const flags = c.fl[i];
    contacts[i] = {
      id: c.id[i],
      fullName: c.n[i],
      preferredName: c.pn[i],
      company: c.co[i] === -1 ? null : d.co[c.co[i]],
      school: c.sc[i] === -1 ? null : d.sc[c.sc[i]],
      ...(industry !== undefined ? { industry } : {}),
      title: c.ti[i] === -1 ? null : d.ti[c.ti[i]],
      relationshipScore: c.rs[i],
      closeness: c.cl[i],
      closenessTier: d.ct[c.ct[i]] as GraphContact["closenessTier"],
      orbitScore: c.os[i],
      lastInteractionAt: fromMs(c.li[i]),
      hasLoggedInteraction: (flags & 1) !== 0,
      nextFollowUpAt: fromMs(c.fol[i]),
      tags: c.tg[i].map((at) => d.tg[at]),
      aiSummary: c.ai[i],
      keyFacts: c.kf[i],
      profileImageUrl: c.av[i],
      dormant: (flags & 2) !== 0,
      substantive: (flags & 4) !== 0,
    };
  }

  const clusters: GraphCluster[] = wire.cl.id.map((id, i) => ({
    id,
    name: wire.cl.n[i],
    // `company` is the deprecated alias of `name`, and `toNamedGraphClusters` — the only
    // producer of a payload's clusters — sets them to the same string. Carrying it twice would
    // add a second copy of every cluster name for nothing.
    company: wire.cl.n[i],
    kind: wire.cl.k[i],
    count: wire.cl.c[i],
    contactIds: wire.cl.m[i].map((at) => c.id[at]),
  }));

  return {
    contacts,
    companies: wire.co,
    schools: wire.sc,
    tags: wire.tg,
    clusters,
    userId: wire.u,
    summary: wire.s,
  };
}
