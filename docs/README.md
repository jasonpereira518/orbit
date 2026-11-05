# Orbit docs

The product overview is the [root README](../README.md).

## Living docs

Kept in step with the code. When you change what one of them describes, update it in the same change.

| Doc | What it covers |
|---|---|
| [DEVELOPMENT.md](DEVELOPMENT.md) | Running Orbit locally: stack, quick start, database commands, env vars, routes |
| [TESTING.md](TESTING.md) | The smoke suite, e2e, CI jobs |
| [RUNBOOK.md](RUNBOOK.md) | Deploy, roll back, alerts, and what to do when something breaks |
| [performance.md](performance.md) | Function budgets, `maxDuration` policy, where to measure |
| [mcp-vision.md](mcp-vision.md) | The Claude/ChatGPT connector: what it is for and how the code is shaped |
| [ai-evals/](ai-evals/README.md) | AI eval harness and baselines |
| [../analytics/events/](../analytics/events/README.md) | Product event definitions |

Tool READMEs live beside their tools: [extension](../extension/README.md), [latency](../latency/README.md), [scripts/bench](../scripts/bench/README.md), [scripts/dev/perf](../scripts/dev/perf/README.md), [cost model](../cost/unit-economics/README.md).

## Audits

Point-in-time audits and the plans that followed them, in [audits/](audits/). Each one says the commit it was measured at. Code comments cite their finding ids (e.g. `LATENCY_PLAN SRV-5`).

| Audit | Date |
|---|---|
| [App end-to-end audit](audits/2026-10-08-app-e2e-audit.md) | Oct 8 |
| [Efficiency audit](audits/2026-10-13-efficiency-audit.md) | Oct 13 |
| [Accessibility and responsive](audits/A11Y_RESPONSIVE_AUDIT.md) | Oct 17 |
| [Performance audit](audits/PERFORMANCE_AUDIT.md) and [plan](audits/PERFORMANCE_PLAN.md) | Oct 17 |
| [Latency baseline](audits/LATENCY_BASELINE.md), [plan](audits/LATENCY_PLAN.md), and [report](audits/LATENCY_REPORT.md) | Oct 17 |
| [Web search efficiency plan](audits/2026-10-18-web-search-efficiency-plan.md) | Oct 18 |
| [Analytics audit](audits/ANALYTICS_AUDIT.md), [plan](audits/ANALYTICS_PLAN.md), and [tracking plan](audits/TRACKING_PLAN.md) | Oct 17–19 |

The tracking plan is still the reference for metric definitions; the others record the state at the time.

## Archive

[archive/](archive/) holds finished work, kept for its reasoning, not as a description of today's code:

- `archive/superpowers/specs/` and `archive/superpowers/plans/`: design specs and implementation plans, Aug–Oct 2026, named by date.
- The original July product spec, the Sep 17 launch changelog, the Sep 15 error-reporting note, and the Oct 9 cleanup log.
