-- Bulk FAKE data for local reliability tests. Never run against production.
-- Sized at roughly 10x a plausible early-stage footprint so migration locks, dump/restore
-- time and HNSW rebuild cost are visible. Every user_id is prefixed 'rel-' and every name
-- is synthetic.
--
--   psql -h 127.0.0.1 -U orbit -d orbit_rel -v users=300 -v contacts_per=2000 -f reliability/seed-bulk.sql
\set ON_ERROR_STOP on
\if :{?users} \else \set users 300 \endif
\if :{?contacts_per} \else \set contacts_per 2000 \endif
\if :{?vectors} \else \set vectors 60000 \endif

BEGIN;
INSERT INTO user_settings (user_id, created_at)
SELECT 'rel-' || u, now() - (u || ' days')::interval
FROM generate_series(1, :users) u
ON CONFLICT (user_id) DO NOTHING;

INSERT INTO contacts (user_id, full_name, company, title, email, notes, created_at, updated_at)
SELECT 'rel-' || u,
       'Person ' || u || '-' || c,
       (ARRAY['Acme','Globex','Initech','Umbrella','Hooli','Stark','Wayne','Tyrell'])[1 + (c % 8)],
       (ARRAY['Engineer','PM','Designer','Founder','Recruiter','VP'])[1 + (c % 6)],
       'person' || u || '_' || c || '@example.com',
       repeat('Met at a conference and talked about distributed systems. ', 1 + (c % 6)),
       now() - ((c % 700) || ' days')::interval,
       now() - ((c % 90) || ' days')::interval
FROM generate_series(1, :users) u, generate_series(1, :contacts_per) c;
COMMIT;

BEGIN;
INSERT INTO interactions (user_id, contact_id, interaction_type, interaction_date, raw_notes, created_at)
SELECT c.user_id, c.id, (ARRAY['note','meeting','email','call'])[1 + (g % 4)],
       now() - ((g * 37 % 900) || ' days')::interval,
       'Followed up about the role; promised an intro next week. ' || g,
       now() - ((g * 37 % 900) || ' days')::interval
FROM contacts c, generate_series(1, 3) g;
COMMIT;

BEGIN;
INSERT INTO usage_events (user_id, operation, provider, model, kind, created_at)
SELECT 'rel-' || (1 + g % :users), 'chat', 'anthropic', 'claude-haiku', 'completion',
       now() - ((g % 120) || ' days')::interval
FROM generate_series(1, 1000000) g;

INSERT INTO error_events (source, kind, context, created_at)
SELECT 'rel.synthetic', 'kind-' || (g % 20), jsonb_build_object('n', g),
       now() - ((g % 60) || ' days')::interval
FROM generate_series(1, 200000) g;

INSERT INTO reminders (user_id, title, created_at)
SELECT 'rel-' || (1 + g % :users), 'Follow up ' || g, now() - ((g % 200) || ' days')::interval
FROM generate_series(1, 200000) g;
COMMIT;

-- Vectors: 1536 dims (OpenAI text-embedding-3-small), stored both as jsonb and vector, the
-- way the app stores them. Random values; only size and index cost matter here.
BEGIN;
INSERT INTO contact_embeddings (user_id, contact_id, source_type, embedding, content, embedding_vector)
SELECT c.user_id, c.id, 'profile', to_jsonb(v.arr), 'synthetic profile text', v.arr::vector
FROM (SELECT id, user_id FROM contacts ORDER BY id LIMIT :vectors) c
CROSS JOIN LATERAL (
  SELECT array_agg(random()::real) AS arr FROM generate_series(1, 1536) WHERE c.id IS NOT NULL
) v;
COMMIT;

ANALYZE;
