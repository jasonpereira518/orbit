# Archive

Point-in-time documents kept for history. They describe the code as it was on their date and
are **not maintained**; for how things work now, read [ARCHITECTURE](../ARCHITECTURE.md),
[ENVIRONMENT](../ENVIRONMENT.md), [DEPLOYMENT](../DEPLOYMENT.md) and the [decision records](../adr/).

| Folder / file | What it is |
|---|---|
| `superpowers/plans/`, `superpowers/specs/` | Agent execution plans and design specs (Aug–Oct 2026). The checkboxes were never ticked, so they don't show what shipped, and some of the `src/` paths they cite no longer exist. Plans and specs that code or live docs still reference were left in `docs/superpowers/`. |
| `production-readiness-audit-2026-09-15.md`, `error-reporting-2026-09-15.md`, `launch-changelog-2026-09-17.md` | Pre-launch audits and changelog. |
| `audits/` | Dated app and e2e audit snapshots. |
| `cleanup/` | The 2026-10-09 cleanup log. |
| `orbit_networking_tracker_spec.md` | The original product spec. Its stack options ("Prisma or Drizzle", bring-your-own OpenAI key) were decided differently. |

Moved with `git mv`, so `git log --follow <file>` still works. Relative links inside an archived
document that point at a document that was *not* moved may be broken.
