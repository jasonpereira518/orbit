---
target: the /imports page
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 2
timestamp: 2026-09-22T02-55-56Z
slug: src-app-clerk-app-main-imports-page-tsx
---
Method: dual-agent (A: design review · B: detector + browser overlay)

## Design Health Score
| # | Heuristic | Score | Key issue |
|---|---|---|---|
| 1 | Visibility of system status | 3 | Queue phases + row status lines good; the finish is a toast + a count, nothing shows the network growing |
| 2 | Match system / real world | 3 | Plain language; but "updated" / "already here" / "Already in Orbit" overlap |
| 3 | User control & freedom | 2 | Can stop/skip before running; no undo after (import already knows who it added) |
| 4 | Consistency & standards | 2 | "Past imports" H2 directly over "Import history" H2; expanded card repeats its row's header; calendar links offered in two rows |
| 5 | Error prevention | 3 | Detection + review + repeats unselected by default; disabled "Import 0 selected" before any file |
| 6 | Recognition over recall | 2 | LinkedIn's ~24h wait buried 3 levels deep; every history row titled "Connections.csv" |
| 7 | Flexibility & efficiency | 3 | Drop anywhere, paste, folder, ZIP, deep links |
| 8 | Aesthetic & minimalist | 3 | Calm; duplicate heading + nested card + 7 permanent rows add weight |
| 9 | Error recovery | 3 | Cause + next step + fix link + reference; queue failures truncated to one line |
| 10 | Help & documentation | 3 | Excellent screenshot guide, hidden behind an expanded row |
| **Total** | | **27/40** | **Acceptable (upper edge)** |

## Design specificity
Structure is Orbit's (one drop target, People / Meetings); the look is generic shadcn (dashed box, identical accordion rows, card list). No liquid-glass, no orbit motif, Fraunces only on the H1, import accents indigo/terracotta/ochre instead of teal/gold. Detector: 4× border-accent-on-rounded (border-t-2 on rounded-2xl) in calendar-import-section.tsx:81, calendar-subscribe-panel.tsx:47, linkedin-connections-import.tsx:67, linkedin-messages-import.tsx:64 — confirmed live. Overlay also flagged app-shell issues out of scope (10px "Soon"/badge text, thin-border-wide-shadow, clipped overflow container, ~89ch line length).

## Priority issues
- [P0] Two hidden file inputs are focusable and unlabeled (import-dropzone.tsx:105-127, sr-only keeps tabIndex 0). Fix: tabIndex -1 + aria-hidden or `hidden`. /impeccable harden
- [P1] Import numbers don't reconcile: detail sheet shows "1 added · 2 updated · 2 already here" vs "Rows: 3 imported" vs "Added 1 / Already in Orbit 2" — updated and already-here double-count. Fix: one vocabulary, one reconciled breakdown. /impeccable clarify
- [P1] First-timer's real blocker hidden: most arrive with no export; LinkedIn takes ~24h, expires in 72h. Fix: "No export yet?" line under the hero opening the guide + "while you wait, connect Google". /impeccable onboard
- [P2] The finish doesn't reward: count + toast. Fix: done card with new people's photos in an orbit ring + "Meet your 19 new people". /impeccable delight
- [P2] Redundant IA + no identity/trust surface: 7 rows (3 mean "contacts"), duplicate history heading, nested card header, border-t-2 accents; no privacy line. Fix: 4 rows, single heading, liquid-glass hero, orbit mark, one-line privacy note. /impeccable distill, /impeccable colorize

## Persona red flags
Jordan: nothing to drop yet, no path; disabled buttons look broken; numbers don't add up after. Casey: "Drop anything" on a phone; "Choose a folder" unsupported on iOS Safari; truncated rows and history. Sam: two unlabeled tab stops; tablist without tabpanel/arrow keys in Details; no live region on queue completion; duplicate H2s.

## Minor
truncated copy rendered twice; Drive disabled reason only in a title tooltip; history helper text lists sources and omits Drive; summarizeImport called twice in detail sheet; no expand motion (deliberate).

## Questions
If detection works, why seven manual doors at equal weight? Should history be a timeline of people arriving, not files? What makes the first import the most memorable moment in Orbit?
