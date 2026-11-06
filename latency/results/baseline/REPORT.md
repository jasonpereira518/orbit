# Latency results: latency/results/baseline


## Client JS per route (first load, from the production build)

| route | js raw KB | js gz KB | fonts KB | server KB |
| --- | --- | --- | --- | --- |
| /contacts/[id] | 1169 | 382 | 112 | 12680 |
| /dashboard | 1156 | 380 | 112 | 16254 |
| /settings | 1125 | 365 | 112 | 12860 |
| /reminders | 1115 | 364 | 112 | 12433 |
| /imports | 1059 | 347 | 112 | 12697 |
| /contacts | 1034 | 341 | 112 | 12432 |
| /capture/[batchId] | 1038 | 340 | 112 | 12365 |
| /events/[id] | 1040 | 340 | 112 | 12440 |
| /radar | 1009 | 331 | 112 | 12464 |
| /recruiters | 951 | 311 | 112 | 12377 |
| /outreach/[id] | 952 | 310 | 112 | 15965 |
| /knowledge | 940 | 308 | 112 | 12399 |
| /events | 928 | 303 | 112 | 12391 |
| /recruiters/compose | 926 | 303 | 112 | 12347 |
| /recruiters/[id] | 923 | 302 | 112 | 12348 |
| /contacts/new | 922 | 301 | 112 | 12331 |
| /find | 923 | 301 | 112 | 12324 |
| /outreach/new | 918 | 300 | 112 | 15924 |
| /outreach | 915 | 299 | 112 | 15925 |
| /meetings | 911 | 298 | 112 | 12319 |
| /recruiters/new | 912 | 298 | 112 | 12319 |
| /capture | 909 | 297 | 112 | 12329 |
| /contacts/duplicates | 901 | 294 | 112 | 12331 |
| /graph | 898 | 294 | 112 | 12688 |
| /chat | 890 | 291 | 112 | 12307 |
| /meetings/[id] | 889 | 291 | 112 | 12304 |
| /settings/plan-activation-preview | 890 | 291 | 112 | 12279 |
| /onboarding | 887 | 289 | 112 | 12276 |
| /onboarding/wizard | 886 | 289 | 112 | 12266 |
| /contact | 681 | 201 | 112 | 6748 |
| /pricing | 558 | 181 | 112 | 7015 |
| /upgrade | 558 | 181 | 112 | 7006 |
| /sign-up/[[...sign-up]] | 547 | 176 | 112 | 6715 |
| /sign-in/[[...sign-in]] | 520 | 166 | 112 | 6704 |
| /interest | 454 | 153 | 112 | 6834 |
| /suspended | 475 | 150 | 112 | 6654 |
| / | 432 | 146 | 112 | 6549 |
| /privacy | 391 | 133 | 112 | 6376 |
| /terms | 391 | 133 | 112 | 6360 |
| /connect | 369 | 125 | 112 | 6461 |
| /scan/[token] | 348 | 116 | 112 | 5043 |
| /interest/privacy | 340 | 114 | 112 | 2644 |
| /_not-found | 102 | 32 | 112 | 2338 |
| /_global-error | 15 | 4 | 0 | 2047 |

Note: excludes the ~439 KB raw / ~130 KB gz framework root chunks every page also loads, lazy chunks, clerk-js from Clerk's CDN (~775 KB), and CSS.

## Server cold start: module evaluation per route (fresh Node process, no I/O)

| route | total ms | require | tree | ssr | eager KB |
| --- | --- | --- | --- | --- | --- |
| (clerk)/(app)/(main)/events/page.js | 780 | 351 | 218 | 201 | 3639 |
| (clerk)/(app)/(main)/imports/page.js | 732 | 341 | 203 | 173 | 3607 |
| (clerk)/(app)/onboarding/page.js | 718 | 284 | 241 | 190 | 3569 |
| (clerk)/(app)/(main)/dashboard/page.js | 713 | 286 | 256 | 171 | 3772 |
| (clerk)/(app)/(main)/radar/page.js | 709 | 328 | 244 | 177 | 3666 |
| (clerk)/(app)/settings/page.js | 702 | 321 | 198 | 201 | 3708 |
| (clerk)/(app)/(main)/knowledge/page.js | 682 | 292 | 186 | 153 | 3631 |
| (clerk)/(app)/(main)/chat/page.js | 678 | 316 | 220 | 128 | 3582 |
| (clerk)/(app)/(main)/reminders/page.js | 671 | 283 | 157 | 202 | 3592 |
| (clerk)/(app)/(main)/contacts/new/page.js | 669 | 330 | 188 | 150 | 3585 |
| (clerk)/(app)/(main)/graph/page.js | 660 | 335 | 154 | 201 | 3588 |
| (clerk)/(app)/(main)/contacts/page.js | 659 | 289 | 183 | 189 | 3596 |
| (clerk)/(app)/(main)/recruiters/compose/page.js | 658 | 310 | 189 | 150 | 3597 |
| (clerk)/(app)/(main)/contacts/[id]/page.js | 648 | 278 | 187 | 173 | 3710 |
| (clerk)/(app)/(main)/meetings/[id]/page.js | 640 | 309 | 141 | 173 | 3585 |
| (clerk)/(app)/(main)/events/[id]/page.js | 636 | 295 | 167 | 165 | 3640 |
| (clerk)/(app)/(main)/capture/page.js | 631 | 277 | 214 | 131 | 3597 |
| (clerk)/(app)/(main)/outreach/page.js | 626 | 286 | 171 | 158 | 3626 |
| (clerk)/(app)/settings/plan-activation-preview/page.js | 616 | 306 | 110 | 182 | 3565 |
| (clerk)/(app)/(main)/find/page.js | 606 | 262 | 159 | 160 | 3580 |
| (clerk)/(app)/(main)/recruiters/page.js | 594 | 267 | 180 | 154 | 3588 |
| (clerk)/(app)/(main)/outreach/[id]/page.js | 589 | 256 | 157 | 150 | 3631 |
| (clerk)/(app)/(main)/capture/[batchId]/page.js | 585 | 284 | 137 | 163 | 3587 |
| (clerk)/(admin)/admin/growth/page.js | 582 | 321 | 142 | 106 | 2562 |
| (clerk)/(admin)/admin/users/[userId]/page.js | 570 | 252 | 204 | 114 | 2592 |

84 route handlers could not be timed by scripts/dev/cold-start-report.mjs (Next 16.3 lazy route modules); their eager KB is in the JSON.

## Server ops, tier 500 (in-process; depth = sequential round trips at 25 ms/statement)

| op | group | stmts | depth | cpu ms | KB | est ms @8ms RTT | est ms @40ms RTT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard bundle (getDashboardData) | page | 15 | 3.6 | 175.1 | 372.7 | 204 | 319 |
| dashboard network stats | page | 1 | 1.1 | 2.7 | 0.1 | 12 | 47 |
| graph (default scope) | page | 8 | 0.7 | 109.1 | 365.7 | 115 | 137 |
| graph action (getGraphData) | page | 10 | 3.5 | 165 | 365.7 | 193 | 305 |
| contacts first page | page | 3 | 2.2 | 13.1 | 26.7 | 31 | 101 |
| contacts page 2 (cursor) | page | 5 | 4.3 | 27.8 | 26.4 | 62 | 200 |
| contacts sort=recent | page | 3 | 1.9 | 19.4 | 26.5 | 35 | 95 |
| contacts filter company | page | 3 | 2.2 | 16.1 | 15.7 | 34 | 104 |
| contacts filter due | page | 3 | 2.2 | 10.9 | 18.1 | 29 | 99 |
| contacts letters | page | 2 | 2.1 | 7.3 | 0.1 | 24 | 91 |
| contacts plan overview | page | 4 | 2.9 | 19.5 | 0.4 | 43 | 136 |
| contacts duplicates count | page | 3 | 2.2 | 12.7 | 0 | 30 | 101 |
| profile: getContactForProfile | page | 2 | 2.2 | 9.6 | 5.5 | 27 | 98 |
| profile: timeline | page | 2 | 2.3 | 6.8 | 1.7 | 25 | 99 |
| profile: related contacts | page | 8 | 5.1 | 182.5 | 1.1 | 223 | 387 |
| profile: tail contact (no demo data) | page | 2 | 2.2 | 9.4 | 2 | 27 | 97 |
| reminders rail counts | page | 3 | 1.1 | 3 | 0.2 | 12 | 47 |
| reminders page today | page | 2 | 1 | 5.6 | 4.8 | 14 | 46 |
| reminders page upcoming | page | 2 | 1.1 | 4.4 | 5.8 | 13 | 48 |
| knowledge base | page | 5 | 3 | 55.5 | 156.1 | 80 | 176 |
| knowledge people | page | 2 | 1 | 19 | 75.3 | 27 | 59 |
| chat threads list | page | 3 | 3.4 | 12.2 | 0.4 | 39 | 148 |
| chat suggestions | page | 12 | 4.4 | 26.9 | 1.7 | 62 | 203 |
| notification panel | poll | 11 | 4.2 | 30.3 | 22 | 64 | 198 |
| app pulse (90s/tab) | poll | 13 | 5.6 | 35 | 24.5 | 80 | 259 |
| contacts search 'hop' (prefix, no embedding) | search | 3 | 2.5 | 16.5 | 15.4 | 37 | 117 |
| contacts search 'hopper' (hybrid) | search | 7 | 4.5 | 39.5 | 9.1 | 76 | 220 |
| contacts search 'engineer at acme' (hybrid) | search | 12 | 8 | 244.1 | 26.8 | 308 | 564 |
| hybrid keyword only | search | 4 | 2 | 29 | 17 | 45 | 109 |
| hybrid keyword+semantic | search | 5 | 2.4 | 164.5 | 17 | 184 | 261 |
| hybrid semantic-heavy (nonsense keyword) | search | 5 | 2.7 | 160 | 2.3 | 182 | 268 |
| hybrid filtered (recall guard) | search | 10 | 6.6 | 326.5 | 18.1 | 379 | 591 |
| memory search lexical | search | 2 | 2.3 | 16.4 | 4.7 | 35 | 108 |
| memory search hybrid | search | 3 | 2.1 | 191.4 | 4.7 | 208 | 275 |
| picker search | search | 2 | 2.2 | 9.4 | 0 | 27 | 97 |
| mcp search_contacts | mcp | 8 | 5.9 | 37.1 | 4.5 | 84 | 273 |
| mcp get_contact | mcp | 6 | 4.5 | 17.4 | 3.5 | 53 | 197 |
| mcp who_do_i_know_at | mcp | 7 | 5.6 | 19.4 | 2.4 | 64 | 243 |
| mcp due_followups | mcp | 11 | 6.5 | 41.3 | 3.9 | 93 | 301 |
| mcp get_network_overview | mcp | 14 | 5 | 60.1 | 1.9 | 100 | 260 |
| mcp get_timeline | mcp | 7 | 4.6 | 18.3 | 1.6 | 55 | 202 |
| mcp find_path_to | mcp | 12 | 7.1 | 39.5 | 3.4 | 96 | 324 |
| ext me | ext | 5 | 2.9 | 22.2 | 0.4 | 45 | 138 |
| ext search | ext | 3 | 3.1 | 13.5 | 1.5 | 38 | 138 |
| ext resolve | ext | 5 | 4.4 | 19.6 | 4 | 55 | 196 |

## Server ops, tier 5000 (in-process; depth = sequential round trips at 25 ms/statement)

| op | group | stmts | depth | cpu ms | KB | est ms @8ms RTT | est ms @40ms RTT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard bundle (getDashboardData) | page | 15 | 2.4 | 763.1 | 1186.7 | 782 | 859 |
| dashboard network stats | page | 1 | 1.1 | 6.3 | 0.1 | 15 | 50 |
| graph (default scope) | page | 8 | 0 | 856.8 | 3486 | 857 | 857 |
| graph action (getGraphData) | page | 10 | 0 | 956 | 3486 | 956 | 956 |
| contacts first page | page | 3 | 2.1 | 14.3 | 26.2 | 31 | 98 |
| contacts page 2 (cursor) | page | 5 | 4.5 | 23.3 | 26.1 | 59 | 203 |
| contacts sort=recent | page | 3 | 1.9 | 20.2 | 26.9 | 35 | 96 |
| contacts filter company | page | 3 | 2.1 | 14 | 26.5 | 31 | 98 |
| contacts filter due | page | 3 | 2.4 | 14.1 | 27.6 | 33 | 110 |
| contacts letters | page | 2 | 2.1 | 11.4 | 0.1 | 28 | 95 |
| contacts plan overview | page | 4 | 3.5 | 16.2 | 0.4 | 44 | 156 |
| contacts duplicates count | page | 3 | 0 | 28367.2 | 0 | 28367 | 28367 |
| profile: getContactForProfile | page | 2 | 1.8 | 16.8 | 5.5 | 31 | 89 |
| profile: timeline | page | 2 | 2 | 10.9 | 1.7 | 27 | 91 |
| profile: related contacts | page | 8 | 0 | 1743.5 | 1.1 | 1744 | 1744 |
| profile: tail contact (no demo data) | page | 2 | 2.1 | 9.9 | 3.6 | 27 | 94 |
| reminders rail counts | page | 3 | 1 | 3 | 0.2 | 11 | 43 |
| reminders page today | page | 2 | 1.1 | 5.4 | 28.4 | 14 | 49 |
| reminders page upcoming | page | 2 | 1 | 5.1 | 28.3 | 13 | 45 |
| knowledge base | page | 5 | 2 | 115 | 151.9 | 131 | 195 |
| knowledge people | page | 2 | 0.7 | 21.9 | 76.8 | 28 | 50 |
| chat threads list | page | 3 | 3.1 | 12.3 | 0.4 | 37 | 136 |
| chat suggestions | page | 12 | 4 | 29.4 | 1.7 | 61 | 189 |
| notification panel | poll | 11 | 3.7 | 48.1 | 63.9 | 78 | 196 |
| app pulse (90s/tab) | poll | 13 | 4.9 | 37.7 | 66.3 | 77 | 234 |
| contacts search 'hop' (prefix, no embedding) | search | 3 | 2.3 | 47.5 | 26.5 | 66 | 140 |
| contacts search 'hopper' (hybrid) | search | 7 | 5.5 | 168.5 | 26.5 | 213 | 389 |
| contacts search 'engineer at acme' (hybrid) | search | 12 | 3.6 | 909.2 | 26.5 | 938 | 1053 |
| hybrid keyword only | search | 4 | 1.8 | 68.3 | 19 | 83 | 140 |
| hybrid keyword+semantic | search | 5 | 1.1 | 662.4 | 18.9 | 671 | 706 |
| hybrid semantic-heavy (nonsense keyword) | search | 5 | 2.7 | 700.1 | 2.3 | 722 | 808 |
| hybrid filtered (recall guard) | search | 10 | 2.1 | 1378.2 | 19.3 | 1395 | 1462 |
| memory search lexical | search | 2 | 1.9 | 84.5 | 4.7 | 100 | 161 |
| memory search hybrid | search | 3 | 0.3 | 667.8 | 4.7 | 670 | 680 |
| picker search | search | 2 | 2.1 | 25.1 | 0 | 42 | 109 |
| mcp search_contacts | mcp | 8 | 4.8 | 92.1 | 4.5 | 131 | 284 |
| mcp get_contact | mcp | 6 | 4.4 | 17.7 | 3.5 | 53 | 194 |
| mcp who_do_i_know_at | mcp | 7 | 5.2 | 26.5 | 2.4 | 68 | 235 |
| mcp due_followups | mcp | 11 | 8 | 171.8 | 3.9 | 236 | 492 |
| mcp get_network_overview | mcp | 14 | 4.5 | 182.1 | 1.9 | 218 | 362 |
| mcp get_timeline | mcp | 7 | 4 | 18.3 | 1.6 | 50 | 178 |
| mcp find_path_to | mcp | 12 | 5.8 | 87.9 | 3.5 | 134 | 320 |
| ext me | ext | 5 | 3 | 16.7 | 0.4 | 41 | 137 |
| ext search | ext | 3 | 3.4 | 11.2 | 1.5 | 38 | 147 |
| ext resolve | ext | 5 | 4.1 | 36.7 | 4 | 70 | 201 |

## Server ops, tier 50000 (in-process; depth = sequential round trips at 25 ms/statement)

| op | group | stmts | depth | cpu ms | KB | est ms @8ms RTT | est ms @40ms RTT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard bundle (getDashboardData) | page | 15 | 0 | 4706 | 8593.7 | 4706 | 4706 |
| dashboard network stats | page | 1 | 2 | 52.2 | 0.1 | 68 | 132 |
| graph (default scope) | page | 9 | 0 | 8807.2 | 34685.6 | 8807 | 8807 |
| graph action (getGraphData) | page | 10 | 0 | 9082.6 | 34685.6 | 9083 | 9083 |
| contacts first page | page | 3 | 3.4 | 38.8 | 26.4 | 66 | 175 |
| contacts page 2 (cursor) | page | 5 | 5.2 | 43.8 | 26.2 | 85 | 252 |
| contacts sort=recent | page | 3 | 3.2 | 28.3 | 26.7 | 54 | 156 |
| contacts filter company | page | 3 | 2.5 | 15.6 | 26.1 | 36 | 116 |
| contacts filter due | page | 3 | 2.6 | 20.6 | 27.3 | 41 | 125 |
| contacts letters | page | 2 | 3.1 | 61.5 | 0.1 | 86 | 186 |
| contacts plan overview | page | 4 | 4.4 | 37.6 | 0.4 | 73 | 214 |
| profile: getContactForProfile | page | 2 | 2.2 | 8.9 | 5.5 | 27 | 97 |
| profile: timeline | page | 2 | 2.1 | 6.4 | 1.7 | 23 | 90 |
| profile: related contacts | page | 8 | 0 | 15789.1 | 1.1 | 15789 | 15789 |
| profile: tail contact (no demo data) | page | 2 | 1.8 | 17.7 | 5.7 | 32 | 90 |
| reminders rail counts | page | 3 | 1 | 4.7 | 0.2 | 13 | 45 |
| reminders page today | page | 2 | 1.1 | 12.3 | 28.2 | 21 | 56 |
| reminders page upcoming | page | 2 | 0.7 | 16.1 | 28.4 | 22 | 44 |
| knowledge base | page | 5 | 4 | 689.4 | 155.3 | 721 | 849 |
| knowledge people | page | 2 | 2 | 28.2 | 77.2 | 44 | 108 |
| chat threads list | page | 3 | 3.2 | 9.1 | 0.4 | 35 | 137 |
| chat suggestions | page | 12 | 4.5 | 50.5 | 1.7 | 87 | 231 |
| notification panel | poll | 11 | 4.1 | 32.4 | 63.5 | 65 | 196 |
| app pulse (90s/tab) | poll | 13 | 5.1 | 35 | 65.9 | 76 | 239 |
| contacts search 'hop' (prefix, no embedding) | search | 3 | 2.3 | 382.6 | 26.4 | 401 | 475 |
| contacts search 'hopper' (hybrid) | search | 7 | 14.3 | 927.1 | 26.8 | 1042 | 1499 |
| contacts search 'engineer at acme' (hybrid) | search | 12 | 3.5 | 2271.7 | 26.1 | 2300 | 2412 |
| hybrid keyword only | search | 4 | 2.6 | 91.1 | 19 | 112 | 195 |
| hybrid keyword+semantic | search | 5 | 4.6 | 618.2 | 19 | 655 | 802 |
| hybrid semantic-heavy (nonsense keyword) | search | 4 | 6.5 | 547.5 | 0 | 600 | 808 |
| hybrid filtered (recall guard) | search | 9 | 3 | 1394.2 | 16 | 1418 | 1514 |
| memory search lexical | search | 2 | 1.9 | 691.5 | 4.7 | 707 | 768 |
| memory search hybrid | search | 3 | 8.6 | 1281.1 | 4.7 | 1350 | 1625 |
| picker search | search | 2 | 3 | 218.5 | 0 | 243 | 339 |
| mcp search_contacts | mcp | 8 | 6 | 116.1 | 4.5 | 164 | 356 |
| mcp get_contact | mcp | 6 | 4.2 | 17.9 | 3.5 | 52 | 186 |
| mcp who_do_i_know_at | mcp | 7 | 7 | 110.5 | 2.4 | 167 | 391 |
| mcp due_followups | mcp | 11 | 12 | 1558.9 | 3.9 | 1655 | 2039 |
| mcp get_network_overview | mcp | 14 | 7.7 | 1769.6 | 1.9 | 1831 | 2078 |
| mcp get_timeline | mcp | 7 | 3.7 | 29.2 | 1.6 | 59 | 177 |
| mcp find_path_to | mcp | 12 | 5.9 | 253.4 | 3.5 | 301 | 489 |
| ext me | ext | 5 | 4 | 38.7 | 0.4 | 71 | 199 |
| ext search | ext | 3 | 3.5 | 10.1 | 1.5 | 38 | 150 |
| ext resolve | ext | 5 | 2.9 | 196 | 4 | 219 | 312 |

## Server ops, tier new (in-process; depth = sequential round trips at 25 ms/statement)

| op | group | stmts | depth | cpu ms | KB | est ms @8ms RTT | est ms @40ms RTT |
| --- | --- | --- | --- | --- | --- | --- | --- |
| dashboard bundle (getDashboardData) | page | 20 | 3.6 | 48.1 | 0.9 | 77 | 192 |
| dashboard network stats | page | 1 | 1 | 3.4 | 0.1 | 11 | 43 |
| graph (default scope) | page | 13 | 2.9 | 27.4 | 0.4 | 51 | 143 |
| graph action (getGraphData) | page | 15 | 5.1 | 33 | 0.4 | 74 | 237 |
| contacts first page | page | 2 | 2.2 | 5 | 0 | 23 | 93 |
| contacts page 2 (cursor) | page | 2 | 2.1 | 4.8 | 0 | 22 | 89 |
| contacts sort=recent | page | 2 | 2.1 | 4.9 | 0 | 22 | 89 |
| contacts filter company | page | 2 | 2.2 | 5 | 0 | 23 | 93 |
| contacts filter due | page | 2 | 2.1 | 5.5 | 0 | 22 | 90 |
| contacts letters | page | 2 | 2.1 | 6.3 | 0 | 23 | 90 |
| contacts plan overview | page | 4 | 3 | 16.1 | 0.4 | 40 | 136 |
| contacts duplicates count | page | 3 | 2.1 | 9.2 | 0 | 26 | 93 |
| profile: getContactForProfile | page | 2 | 2.1 | 9.2 | 0 | 26 | 93 |
| profile: timeline | page | 2 | 2.1 | 7.5 | 0 | 24 | 92 |
| profile: related contacts | page | 6 | 2 | 12.1 | 0 | 28 | 92 |
| profile: tail contact (no demo data) | page | 2 | 2.2 | 9.4 | 0 | 27 | 97 |
| reminders rail counts | page | 3 | 1 | 3 | 0.1 | 11 | 43 |
| reminders page today | page | 2 | 1.1 | 3.6 | 0.1 | 12 | 48 |
| reminders page upcoming | page | 2 | 1 | 3.2 | 0.1 | 11 | 43 |
| knowledge base | page | 4 | 2 | 7.4 | 0.1 | 23 | 87 |
| knowledge people | page | 2 | 1 | 3.6 | 0 | 12 | 44 |
| chat threads list | page | 3 | 3.1 | 9.5 | 0 | 34 | 134 |
| chat suggestions | page | 11 | 2.7 | 27.3 | 0.3 | 49 | 135 |
| notification panel | poll | 11 | 3.5 | 37.1 | 0.1 | 65 | 177 |
| app pulse (90s/tab) | poll | 13 | 5.1 | 29.7 | 0.2 | 71 | 234 |
| contacts search 'hop' (prefix, no embedding) | search | 2 | 2.1 | 6.7 | 0 | 24 | 91 |
| contacts search 'hopper' (hybrid) | search | 5 | 3.1 | 14.7 | 0 | 40 | 139 |
| contacts search 'engineer at acme' (hybrid) | search | 10 | 4.1 | 19.8 | 0 | 53 | 184 |
| hybrid keyword only | search | 3 | 1.1 | 7 | 0 | 16 | 51 |
| hybrid keyword+semantic | search | 4 | 1.1 | 8.6 | 0 | 17 | 53 |
| hybrid semantic-heavy (nonsense keyword) | search | 4 | 1.1 | 10.8 | 0 | 20 | 55 |
| hybrid filtered (recall guard) | search | 8 | 2.1 | 19.9 | 0 | 37 | 104 |
| memory search lexical | search | 1 | 1.1 | 2.7 | 0 | 12 | 47 |
| memory search hybrid | search | 2 | 1 | 5 | 0 | 13 | 45 |
| picker search | search | 2 | 2.1 | 6.7 | 0 | 24 | 91 |
| mcp search_contacts | mcp | 7 | 4.2 | 20.8 | 0.3 | 54 | 189 |
| mcp get_contact | mcp | 6 | 4.3 | 15.1 | 0.1 | 50 | 187 |
| mcp who_do_i_know_at | mcp | 6 | 4 | 22.9 | 0.3 | 55 | 183 |
| mcp due_followups | mcp | 16 | 5.6 | 50.2 | 0.3 | 95 | 274 |
| mcp get_network_overview | mcp | 19 | 6.3 | 37.6 | 0.9 | 88 | 290 |
| mcp get_timeline | mcp | 7 | 4.2 | 17.2 | 0.1 | 51 | 185 |
| mcp find_path_to | mcp | 9 | 4.3 | 21.1 | 0.4 | 56 | 193 |
| ext me | ext | 5 | 3.2 | 15.1 | 0.4 | 41 | 143 |
| ext search | ext | 3 | 3.3 | 9 | 0 | 35 | 141 |
| ext resolve | ext | 4 | 3.2 | 10.8 | 0.6 | 36 | 139 |

## Pages, tier 500, desktop (unthrottled; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 949 | 1260 | 1420 | 1541 | 80 | 0 | 203 | 1724 | 49 | 889 | 1438 | 11 |
| /contacts | 984 | 1200 | 1200 | 1584 | 584 | 0 | 179 | 1637 | 52 | 1415 | 1985 | 11 |
| /contacts/[id] | 832 | 1204 | 1404 | 1453 | – | 0 | 169 | 1740 | 53 | 884 | 1385 | 11 |
| /capture | 280 | 612 | 612 | 927 | – | 0 | 226 | 1965 | 59 | 300 | 775 | 13 |
| /chat | 210 | 496 | 2504 | 2475 | 32 | 0 | 220 | 1983 | 70 | 264 | 2535 | 13 |
| /graph | 377 | 660 | 732 | 984 | – | 0 | 124 | 1534 | 54 | 497 | 1016 | 11 |
| /knowledge | 418 | 696 | 1052 | 1119 | – | 0 | 160 | 1560 | 58 | 690 | 1224 | 12 |
| /reminders | 297 | 624 | 704 | 876 | – | 0 | 152 | 1685 | 49 | – | – | – |
| /imports | 220 | 524 | 524 | 820 | – | 0 | 185 | 1665 | 53 | 380 | 862 | 17 |
| /events | 215 | 524 | 688 | 747 | – | 0 | 160 | 1523 | 55 | 302 | 743 | 10 |
| /meetings | 202 | 488 | 488 | 739 | – | 0 | 161 | 1535 | 51 | 303 | 752 | 11 |
| /outreach | 260 | 600 | 816 | 807 | – | 0 | 141 | 1516 | 50 | 376 | 788 | 9 |
| /recruiters | 263 | 556 | 732 | 773 | – | 0 | 157 | 1564 | 49 | 335 | 769 | 11 |
| /radar | 244 | 648 | 760 | 745 | – | 0 | 136 | 1511 | 46 | 595 | 1047 | 9 |
| /settings | 312 | 648 | 648 | 979 | – | 0 | 193 | 1708 | 53 | 298 | 908 | 12 |
| / | 171 | 408 | 560 | 591 | – | 0 | 144 | 1317 | 57 | 222 | 638 | 9 |
| /pricing | 196 | 540 | 540 | 764 | – | 0 | 173 | 1385 | 44 | 299 | 810 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), desktop:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 1525 | – |
| /reminders | 2701 | 1448 |
| /dashboard | 1081 | – |
| /graph | 617 | – |
| /chat | 609 | – |
| /capture | 761 | 445 |
| /contacts | 832 | – |
| /dashboard | 1082 | – |

History: back 1100 ms, forward 483 ms.

## Pages, tier 500, mobile4g (4G 150 ms RTT, 4x CPU slowdown; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 833 | 2612 | 9148 | 12276 | – | 0 | 1057 | 1731 | 48 | 823 | 3803 | 10 |
| /contacts | 937 | 2700 | 3116 | 11100 | 2520 | 0 | 681 | 1637 | 49 | 986 | 3176 | 11 |
| /contacts/[id] | 810 | 2588 | 8704 | 11824 | 64 | 0 | 844 | 1740 | 46 | 1037 | 3377 | 12 |
| /capture | 218 | 1880 | 2196 | 10880 | 1024 | 0 | 621 | 1769 | 52 | 617 | 2508 | 12 |
| /chat | 188 | 1972 | 2232 | 15949 | 120 | 0 | 2135 | 2026 | 74 | 328 | 6302 | 14 |
| /graph | 422 | 2120 | 2344 | 10144 | – | 0 | 752 | 1528 | 43 | 443 | 2515 | 10 |
| /knowledge | 846 | 2572 | 3308 | 11139 | 1808 | 0 | 1094 | 1553 | 46 | 470 | 2823 | 11 |
| /reminders | 308 | 2040 | 2408 | 10871 | 48 | 0 | 706 | 1685 | 44 | 879 | 2985 | 10 |
| /imports | 239 | 2028 | 2252 | 9945 | – | 0 | 857 | 1659 | 45 | 444 | 2476 | 10 |
| /events | 278 | 2040 | 8300 | 10062 | – | 0 | 693 | 1511 | 42 | 551 | 2713 | 9 |
| /meetings | 266 | 2056 | 2300 | 9708 | – | 0 | 558 | 1535 | 44 | 354 | 2001 | 10 |
| /outreach | 207 | 2000 | 8108 | 9946 | – | 0 | 605 | 1511 | 42 | 905 | 3003 | 9 |
| /recruiters | 253 | 2016 | 2236 | 10205 | – | 0 | 770 | 1564 | 44 | 820 | 2714 | 10 |
| /radar | 360 | 2080 | 8208 | 10161 | – | 0 | 708 | 1511 | 41 | 640 | 3052 | 9 |
| /settings | 457 | 2272 | 2524 | 11968 | 64 | 0 | 1012 | 1702 | 44 | 1323 | 4727 | 11 |
| / | 169 | 1412 | 7836 | 8707 | – | 0 | 659 | 1282 | 44 | 195 | 2248 | 8 |
| /pricing | 220 | 2440 | 2440 | 9968 | – | 0 | 744 | 1354 | 43 | 322 | 3367 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), mobile4g:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 7344 | – |
| /reminders | no link | – |
| /dashboard | 4832 | – |
| /graph | 1837 | – |
| /chat | 4865 | 2423 |
| /capture | no link | – |
| /contacts | 3008 | 1048 |
| /dashboard | 3072 | – |

History: back 3765 ms, forward 1947 ms.

## Pages, tier 5000, desktop (unthrottled; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 1923 | 2236 | 2452 | 2568 | 48 | 0 | 164 | 1724 | 45 | 2338 | 2828 | 10 |
| /contacts | 33217 | 33468 | 33468 | 33851 | 536 | 0 | 188 | 1637 | 48 | 35406 | 35924 | 11 |
| /contacts/[id] | 2099 | 2432 | 2688 | 2694 | – | 0 | 216 | 1740 | 47 | 2109 | 2638 | 11 |
| /capture | 353 | 732 | 732 | 921 | – | 0 | 203 | 1965 | 55 | 260 | 718 | 12 |
| /chat | 210 | 516 | 4356 | 4323 | 32 | 0 | 210 | 1983 | 71 | 276 | 4108 | 13 |
| /graph | 1722 | 2036 | 2072 | 2419 | – | 0 | 224 | 1528 | 44 | 2368 | 3064 | 10 |
| /knowledge | 624 | 880 | 1252 | 1315 | – | 0 | 125 | 1553 | 47 | 585 | 1204 | 10 |
| /reminders | 573 | 848 | 848 | 1238 | – | 0 | 181 | 1685 | 44 | – | – | – |
| /imports | 439 | 792 | 792 | 1047 | – | 0 | 212 | 1659 | 45 | 1041 | 1473 | 10 |
| /events | 631 | 944 | 1124 | 1124 | – | 0 | 147 | 1511 | 42 | 888 | 1359 | 9 |
| /meetings | 355 | 712 | 712 | 947 | – | 0 | 197 | 1535 | 44 | 954 | 1414 | 10 |
| /outreach | 394 | 724 | 924 | 986 | – | 0 | 135 | 1511 | 42 | 929 | 1348 | 9 |
| /recruiters | 331 | 592 | 784 | 822 | – | 0 | 115 | 1564 | 45 | 786 | 1285 | 10 |
| /radar | 347 | 640 | 832 | 855 | – | 0 | 129 | 1511 | 42 | 1049 | 1511 | 9 |
| /settings | 290 | 620 | 620 | 872 | – | 0 | 156 | 1702 | 44 | 302 | 1302 | 10 |
| / | 128 | 560 | 1036 | 605 | – | 0 | 146 | 1317 | 57 | 250 | 1054 | 9 |
| /pricing | 190 | 520 | 520 | 726 | – | 0 | 121 | 1385 | 44 | 224 | 717 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), desktop:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 33717 | – |
| /reminders | 5347 | 2670 |
| /dashboard | 1875 | – |
| /graph | 1675 | – |
| /chat | 507 | – |
| /capture | 824 | 420 |
| /contacts | 33974 | – |
| /dashboard | 33640 | – |

History: back 500 ms, forward 22 ms.

## Pages, tier 5000, mobile4g (4G 150 ms RTT, 4x CPU slowdown; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 1493 | 3228 | 9608 | 12948 | – | 0 | 904 | 1724 | 45 | 1731 | 4463 | 10 |
| /contacts | 33140 | 34888 | 35268 | 43168 | 2112 | 0 | 757 | 1637 | 47 | 33039 | 34985 | 11 |
| /contacts/[id] | 3485 | 5228 | 11072 | 14514 | 80 | 0 | 783 | 1740 | 47 | 2797 | 5375 | 11 |
| /capture | 1171 | 2856 | 3164 | 11923 | 48 | 0 | 630 | 1965 | 55 | 1845 | 3882 | 12 |
| /chat | 221 | 1952 | 2256 | 16676 | 120 | 0 | 2118 | 2026 | 73 | 218 | 7431 | 14 |
| /graph | 1942 | 3712 | 3992 | 14835 | – | 0 | 1550 | 1528 | 44 | 2930 | 7403 | 10 |
| /knowledge | 711 | 2512 | 3196 | 10824 | 64 | 0 | 1028 | 1553 | 47 | 1663 | 3871 | 10 |
| /reminders | 975 | 2928 | 2928 | 11539 | 64 | 0 | 772 | 1685 | 44 | 1292 | 3685 | 10 |
| /imports | 426 | 2228 | 2364 | 10019 | – | 0 | 659 | 1659 | 44 | 186 | 2136 | 10 |
| /events | 211 | 1996 | 8144 | 10133 | – | 0 | 658 | 1511 | 42 | 1340 | 3474 | 9 |
| /meetings | 203 | 1944 | 2228 | 9852 | – | 0 | 743 | 1535 | 44 | 1373 | 3505 | 10 |
| /outreach | 296 | 2028 | 8216 | 10052 | – | 0 | 710 | 1511 | 41 | – | – | – |
| /recruiters | 507 | 2308 | 2308 | 10603 | – | 0 | 756 | 1564 | 45 | 1531 | 3525 | 10 |
| /radar | 573 | 2348 | 8628 | 10358 | – | 0 | 702 | 1511 | 42 | 220 | 2359 | 9 |
| /settings | 920 | 2664 | 3156 | 12425 | 48 | 0 | 904 | 1702 | 44 | 1022 | 3872 | 10 |
| / | 265 | 1488 | 7992 | 8736 | – | 0 | 723 | 1282 | 44 | 175 | 2333 | 8 |
| /pricing | 210 | 2332 | 2332 | 9940 | – | 0 | 762 | 1354 | 43 | 240 | 3200 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), mobile4g:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 41480 | – |
| /reminders | no link | – |
| /dashboard | 6195 | 3719 |
| /graph | 2261 | – |
| /chat | 5171 | 1552 |
| /capture | no link | – |
| /contacts | 36045 | – |
| /dashboard | 36479 | 34870 |

History: back 2545 ms, forward 55 ms.

## Pages, tier 50000, desktop (unthrottled; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 13896 | 14252 | 14452 | 14498 | 48 | 0 | 181 | 1724 | 45 | 15475 | 16099 | 10 |
| /contacts/[id] | 21284 | 21756 | 21984 | 21990 | – | 0 | 155 | 1740 | 47 | – | – | – |
| /capture | 4088 | 4360 | 4360 | 4593 | – | 0 | 204 | 1965 | 55 | – | – | – |
| /chat | 188 | 480 | 20220 | 20181 | 48 | 0 | 173 | 1983 | 71 | 263 | 21005 | 13 |
| /graph | 22862 | 23200 | 23200 | 27713 | – | 0 | 2844 | 1528 | 44 | – | – | – |
| /knowledge | 4339 | 4580 | 4896 | 4939 | – | 0 | 179 | 1553 | 47 | 4349 | 5267 | 10 |
| /reminders | 6535 | 6856 | 6856 | 7128 | – | 0 | 194 | 1685 | 44 | 5450 | 6038 | 10 |
| /imports | 9546 | 9840 | 9840 | 10020 | – | 0 | 141 | 1659 | 45 | 10292 | 11274 | 10 |
| /events | 9308 | 9588 | 9756 | 9793 | – | 0 | 131 | 1511 | 42 | – | – | – |
| /meetings | 7969 | 8204 | 8204 | 8409 | – | 0 | 101 | 1535 | 44 | 9620 | 10457 | 10 |
| /outreach | 8835 | 9084 | 9284 | 9364 | – | 0 | 145 | 1511 | 42 | – | – | – |
| /recruiters | 8640 | 8948 | 8948 | 9176 | – | 0 | 173 | 1564 | 45 | 9546 | 10261 | 10 |
| /radar | 8905 | 9088 | 9360 | 9377 | – | 0 | 111 | 1511 | 42 | – | – | – |
| /settings | 3613 | 3836 | 4120 | 4131 | – | 0 | 156 | 1702 | 44 | – | – | – |
| / | 133 | 380 | 608 | 639 | – | 0 | 142 | 1317 | 57 | 192 | 697 | 9 |
| /pricing | 213 | 564 | 564 | 718 | – | 0 | 121 | 1385 | 44 | 214 | 624 | 8 |

## Pages, tier 50000, mobile4g (4G 150 ms RTT, 4x CPU slowdown; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 10502 | 12268 | 18620 | 21973 | – | 0 | 947 | 1724 | 45 | 11917 | 14703 | 10 |
| /contacts/[id] | 25868 | 27544 | 33652 | 36742 | 64 | 0 | 652 | 1740 | 47 | – | – | – |
| /capture | 8171 | 9812 | 10124 | 18955 | 40 | 0 | 581 | 1965 | 55 | – | – | – |
| /chat | 859 | 2612 | 2888 | 33698 | 96 | 0 | 1982 | 2026 | 73 | 894 | 24062 | 14 |
| /graph | 14048 | 15976 | 15976 | 60160 | – | 0 | 13376 | 1528 | 44 | 23627 | 61890 | 10 |
| /knowledge | 7853 | 9648 | 10536 | 17880 | 56 | 0 | 1032 | 1553 | 47 | 8260 | 10552 | 10 |
| /reminders | 9110 | 10828 | 10828 | 19658 | 40 | 0 | 748 | 1685 | 44 | 8297 | 10736 | 10 |
| /imports | 227 | 1992 | 2272 | 9794 | – | 0 | 582 | 1659 | 44 | 215 | 1933 | 10 |
| /events | 9301 | 11020 | 17156 | 18973 | – | 0 | 558 | 1511 | 42 | – | – | – |
| /meetings | 217 | 1960 | 2232 | 9696 | – | 0 | 708 | 1535 | 44 | 9468 | 11222 | 10 |
| /outreach | 9561 | 11320 | 17404 | 19237 | – | 0 | 575 | 1511 | 42 | – | – | – |
| /recruiters | 9328 | 11024 | 11340 | 19305 | – | 0 | 664 | 1564 | 45 | 9493 | 11434 | 10 |
| /radar | 8740 | 10488 | 16612 | 18403 | – | 0 | 699 | 1511 | 42 | – | – | – |
| /settings | 8505 | 10244 | 10604 | 20007 | 56 | 0 | 966 | 1702 | 44 | 9475 | 12342 | 10 |
| / | 154 | 1468 | 8236 | 8838 | – | 0 | 697 | 1282 | 44 | 187 | 2144 | 8 |
| /pricing | 199 | 2336 | 2336 | 9929 | – | 0 | 710 | 1354 | 43 | 909 | 3879 | 8 |

## Pages, tier new, desktop (unthrottled; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 393 | 712 | 912 | 977 | 56 | 0 | 147 | 1841 | 65 | 407 | 972 | 13 |
| /contacts | 300 | 516 | 516 | – | 16 | 0 | 258 | 1754 | 71 | 324 | – | 13 |
| /capture | 229 | 528 | 776 | 829 | – | 0 | 152 | 2082 | 72 | 269 | 734 | 15 |
| /chat | 178 | 468 | 1680 | 1657 | 32 | 0 | 189 | 1983 | 69 | 236 | 1683 | 13 |
| /graph | 209 | 496 | 504 | 697 | – | 0 | 153 | 1978 | 69 | 299 | 818 | 14 |
| /knowledge | 177 | 488 | 520 | 730 | – | 0 | 166 | 1612 | 61 | 220 | 641 | 12 |
| /reminders | 245 | 548 | 548 | 797 | – | 0 | 177 | 1744 | 61 | 352 | 755 | 12 |
| /imports | 166 | 436 | 520 | 628 | – | 0 | 145 | 1776 | 65 | 226 | 664 | 13 |
| /events | 214 | 504 | 676 | 700 | – | 0 | 155 | 1627 | 62 | 272 | 644 | 12 |
| /meetings | 159 | 396 | 456 | 586 | – | 0 | 124 | 1652 | 64 | 268 | 648 | 13 |
| /outreach | 204 | 500 | 632 | 655 | – | 0 | 106 | 1627 | 62 | 268 | 640 | 12 |
| /recruiters | 222 | 512 | 512 | 742 | – | 0 | 116 | 1680 | 65 | 295 | 754 | 13 |
| /radar | 177 | 472 | 604 | 661 | – | 0 | 129 | 1627 | 62 | – | – | – |
| /settings | 253 | 560 | 676 | 778 | – | 0 | 135 | 1760 | 63 | 303 | 831 | 12 |
| / | 139 | 416 | 608 | 593 | – | 0 | 109 | 1317 | 57 | 135 | 590 | 9 |
| /pricing | 175 | 488 | 488 | 700 | – | 0 | 125 | 1385 | 44 | 303 | 782 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), desktop:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 374 | – |
| /reminders | 550 | 247 |
| /dashboard | 502 | – |
| /graph | 306 | – |
| /chat | 386 | – |
| /capture | 647 | 357 |
| /contacts | 261 | – |
| /dashboard | 440 | – |

History: back 331 ms, forward 176 ms.

## Pages, tier new, mobile4g (4G 150 ms RTT, 4x CPU slowdown; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 493 | 2248 | 8412 | 11712 | – | 0 | 855 | 1731 | 47 | 528 | 2943 | 10 |
| /contacts | 316 | 2104 | 2384 | – | 96 | 0 | 2334 | 1797 | 73 | 287 | – | 14 |
| /capture | 275 | 2000 | 2312 | 10212 | 80 | 0 | 641 | 1662 | 46 | 287 | 2199 | 13 |
| /chat | 177 | 1944 | 1988 | 15803 | 120 | 0 | 2176 | 2026 | 73 | 319 | 5925 | 14 |
| /graph | 250 | 2000 | 2276 | 9745 | – | 0 | 606 | 1528 | 44 | 445 | 2373 | 10 |
| /knowledge | 250 | 2064 | 2276 | 9914 | 56 | 0 | 678 | 1553 | 43 | 254 | 2198 | 10 |
| /reminders | 351 | 2068 | 2360 | 10912 | 48 | 0 | 662 | 1691 | 45 | 349 | 2561 | 10 |
| /imports | 210 | 1964 | 2264 | 9756 | – | 0 | 621 | 1665 | 46 | 575 | 2353 | 11 |
| /events | 271 | 2044 | 8240 | 10061 | – | 0 | 627 | 1516 | 44 | 741 | 2749 | 10 |
| /meetings | 176 | 1924 | 2160 | 9588 | – | 0 | 564 | 1541 | 45 | 398 | 2191 | 10 |
| /outreach | 246 | 2008 | 8148 | 9918 | – | 0 | 578 | 1511 | 43 | 690 | 2707 | 10 |
| /recruiters | 201 | 1948 | 2228 | 10125 | – | 0 | 654 | 1570 | 47 | – | – | – |
| /radar | 234 | 2016 | 8172 | 9959 | – | 0 | 611 | 1517 | 43 | – | – | – |
| /settings | 406 | 2096 | 2428 | 11840 | 56 | 0 | 895 | 1707 | 45 | 744 | 3474 | 10 |
| / | 138 | 1388 | 7772 | 8590 | – | 0 | 621 | 1282 | 44 | 153 | 2230 | 8 |
| /pricing | 183 | 2352 | 2352 | 9963 | – | 0 | 834 | 1354 | 43 | 362 | 3354 | 8 |

Client-side navigation (sidebar click → URL changed and no skeleton), mobile4g:

| to | ms | skeleton shown at |
| --- | --- | --- |
| /contacts | 2149 | – |
| /reminders | no link | – |
| /dashboard | 2137 | – |
| /graph | 895 | – |
| /chat | 4907 | 1882 |
| /capture | no link | – |
| /contacts | 1817 | – |
| /dashboard | 2291 | – |

History: back 2713 ms, forward 975 ms.

## HTTP routes and documents, tier 500 (n=30 sequential, then 5 concurrent; next dev)

| target | status | KB | single p50 | p95 | p99 | ttfb p50 | conc p50 | conc p95 | conc p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc /dashboard | 200 | 495 | 725 | 920 | 994 | 719 | 3815 | 4155 | 4167 |
| doc /contacts | 200 | 509 | 726 | 850 | 965 | 719 | 3112 | 3781 | 3782 |
| doc /contacts?q=hopper | 200 | 283 | 692 | 877 | 898 | 688 | 3654 | 4791 | 4793 |
| doc /contacts/[id] | 200 | 303 | 705 | 914 | 937 | 695 | 3158 | 3389 | 3391 |
| doc /reminders | 200 | 195 | 290 | 350 | 378 | 285 | 1477 | 3050 | 3052 |
| doc /capture | 200 | 160 | 269 | 373 | 389 | 266 | 1229 | 1403 | 1404 |
| doc /chat | 200 | 127 | 200 | 257 | 265 | 196 | 903 | 1010 | 1010 |
| doc /graph | 200 | 516 | 368 | 466 | 479 | 356 | 1989 | 3124 | 3124 |
| doc /knowledge | 200 | 527 | 333 | 465 | 542 | 327 | 1401 | 1721 | 1728 |
| doc /imports | 200 | 135 | 235 | 309 | 325 | 231 | 948 | 1103 | 1108 |
| doc /settings | 200 | 231 | 301 | 378 | 397 | 296 | 1472 | 1721 | 1722 |
| api /api/health | 200 | 0 | 48 | 75 | 913 | 48 | 183 | 1216 | 1241 |
| api mcp search_contacts | 200 | 4 | 132 | 206 | 206 | 132 | 401 | 774 | 774 |
| api mcp who_do_i_know_at | 200 | 2 | 136 | 154 | 154 | 136 | 290 | 493 | 493 |
| api mcp due_followups | 200 | 3 | 118 | 130 | 130 | 118 | 341 | 698 | 698 |
| api mcp get_network_overview | 200 | 2 | 138 | 191 | 191 | 138 | 356 | 665 | 665 |
| api mcp get_contact | 200 | 6 | 70 | 88 | 88 | 70 | 217 | 367 | 367 |
| api v1 contacts?q= | 200 | 4 | 90 | 114 | 114 | 89 | 266 | 433 | 433 |
| api v1 followups | 200 | 3 | 149 | 193 | 193 | 149 | 455 | 809 | 809 |
| api ext me | 200 | 0 | 90 | 107 | 107 | 89 | 301 | 1997 | 1997 |
| api ext contacts?q= | 200 | 1 | 88 | 104 | 104 | 87 | 257 | 447 | 447 |
| api avatar | 200 | 0 | 70 | 161 | 162 | 70 | 230 | 429 | 450 |
| api meetings candidates | 200 | 0 | 100 | 152 | 352 | 100 | 301 | 406 | 455 |

## HTTP routes and documents, tier 5000 (n=30 sequential, then 5 concurrent; next dev)

| target | status | KB | single p50 | p95 | p99 | ttfb p50 | conc p50 | conc p95 | conc p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc /dashboard | 200 | 495 | 1463 | 1915 | 1985 | 1457 | 6954 | 7540 | 7557 |
| doc /contacts | 200 | 510 | 36849 | 36855 | 36855 | 36831 | skipped (warm request took 35 s) | – | – |
| doc /contacts?q=hopper | 200 | 514 | 34775 | 34914 | 34914 | 34769 | skipped (warm request took 33 s) | – | – |
| doc /contacts/[id] | 200 | 299 | 1898 | 2400 | 2932 | 1892 | 9380 | 9861 | 9862 |
| doc /reminders | 200 | 446 | 409 | 495 | 962 | 402 | 1857 | 2371 | 2372 |
| doc /capture | 200 | 160 | 213 | 287 | 291 | 209 | 955 | 1065 | 1066 |
| doc /chat | 200 | 127 | 154 | 224 | 256 | 150 | 714 | 798 | 798 |
| doc /graph | 200 | 3994 | 1623 | 2323 | 2475 | 1562 | 8108 | 9258 | 9272 |
| doc /knowledge | 200 | 530 | 248 | 415 | 468 | 241 | 1253 | 2407 | 2407 |
| doc /imports | 200 | 135 | 183 | 226 | 237 | 180 | 853 | 949 | 954 |
| doc /settings | 200 | 231 | 287 | 361 | 362 | 282 | 1283 | 1432 | 1432 |
| api /api/health | 200 | 0 | 40 | 49 | 53 | 39 | 129 | 205 | 233 |
| api mcp search_contacts | 200 | 4 | 90 | 132 | 132 | 90 | 318 | 552 | 552 |
| api mcp who_do_i_know_at | 200 | 2 | 114 | 131 | 131 | 113 | 352 | 575 | 575 |
| api mcp due_followups | 200 | 3 | 252 | 284 | 284 | 252 | 778 | 2992 | 2992 |
| api mcp get_network_overview | 200 | 2 | 327 | 438 | 438 | 326 | 983 | 1737 | 1737 |
| api mcp get_contact | 200 | 5 | 61 | 99 | 99 | 61 | 180 | 307 | 307 |
| api v1 contacts?q= | 200 | 4 | 91 | 113 | 113 | 91 | 256 | 423 | 423 |
| api v1 followups | 200 | 3 | 285 | 346 | 346 | 284 | 977 | 1650 | 1650 |
| api ext me | 200 | 0 | 71 | 96 | 96 | 71 | 238 | 379 | 379 |
| api ext contacts?q= | 200 | 1 | 53 | 76 | 76 | 53 | 170 | 251 | 251 |
| api avatar | 429 | 0 | 66 | 140 | 178 | 66 | 259 | 387 | 446 |
| api meetings candidates | 200 | 0 | 65 | 97 | 233 | 65 | 271 | 407 | 447 |

## HTTP routes and documents, tier 50000 (n=30 sequential, then 5 concurrent; next dev)

| target | status | KB | single p50 | p95 | p99 | ttfb p50 | conc p50 | conc p95 | conc p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc /dashboard | 200 | 495 | 6613 | 7343 | 8697 | 6606 | 33135 | 38124 | 38135 |
| doc /contacts/[id] | 200 | 287 | 15060 | 16295 | 16295 | 15055 | skipped (warm request took 15 s) | – | – |
| doc /reminders | 200 | 446 | 357 | 482 | 485 | 352 | 1526 | 2007 | 2007 |
| doc /capture | 200 | 160 | 296 | 388 | 399 | 292 | 1411 | 1664 | 1664 |
| doc /chat | 200 | 127 | 138 | 177 | 187 | 135 | 605 | 648 | 649 |
| doc /graph | 200 | 38761 | 16485 | 16767 | 16767 | 15241 | skipped (warm request took 17 s) | – | – |
| doc /knowledge | 200 | 531 | 400 | 529 | 564 | 393 | 1704 | 2104 | 2104 |
| doc /imports | 200 | 135 | 167 | 220 | 226 | 164 | 758 | 883 | 889 |
| doc /settings | 200 | 231 | 426 | 536 | 585 | 421 | 2266 | 3930 | 3932 |
| api /api/health | 200 | 0 | 44 | 52 | 55 | 44 | 111 | 182 | 202 |
| api mcp search_contacts | 200 | 4 | 157 | 230 | 230 | 157 | 469 | 837 | 837 |
| api mcp who_do_i_know_at | 200 | 2 | 345 | 473 | 473 | 345 | 1129 | 1875 | 1875 |
| api mcp due_followups | 200 | 3 | 2413 | 2553 | 2553 | 2412 | 7187 | 14118 | 14118 |
| api mcp get_network_overview | 200 | 2 | 2497 | 2971 | 2971 | 2497 | 7404 | 13122 | 13122 |
| api mcp get_contact | 200 | 4 | 54 | 62 | 62 | 54 | 166 | 277 | 277 |
| api v1 contacts?q= | 200 | 4 | 119 | 165 | 165 | 117 | 340 | 610 | 610 |
| api v1 followups | 200 | 3 | 2123 | 2326 | 2326 | 2123 | 6919 | 13216 | 13216 |
| api ext me | 200 | 0 | 176 | 204 | 204 | 176 | 658 | 1082 | 1082 |
| api ext contacts?q= | 200 | 1 | 53 | 126 | 126 | 53 | 161 | 268 | 268 |
| api avatar | 200 | 0 | 51 | 111 | 129 | 51 | 155 | 262 | 292 |
| api meetings candidates | 200 | 0 | 57 | 74 | 318 | 57 | 236 | 355 | 368 |

## HTTP routes and documents, tier new (n=30 sequential, then 5 concurrent; next dev)

| target | status | KB | single p50 | p95 | p99 | ttfb p50 | conc p50 | conc p95 | conc p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc /dashboard | 200 | 196 | 503 | 815 | 826 | 498 | 2616 | 3202 | 3271 |
| doc /contacts | 200 | 143 | 264 | 298 | 305 | 259 | 1120 | 1271 | 1271 |
| doc /contacts?q=hopper | 200 | 144 | 239 | 316 | 332 | 236 | 1275 | 1483 | 1483 |
| doc /reminders | 200 | 143 | 251 | 340 | 370 | 248 | 1349 | 2715 | 2717 |
| doc /capture | 200 | 137 | 238 | 296 | 312 | 235 | 1185 | 1257 | 1257 |
| doc /chat | 200 | 126 | 181 | 228 | 253 | 178 | 852 | 963 | 964 |
| doc /graph | 200 | 108 | 244 | 318 | 327 | 239 | 1342 | 2719 | 2719 |
| doc /knowledge | 200 | 111 | 222 | 297 | 328 | 218 | 962 | 1045 | 1046 |
| doc /imports | 200 | 134 | 202 | 242 | 254 | 199 | 1017 | 1235 | 1245 |
| doc /settings | 200 | 226 | 302 | 403 | 469 | 297 | 1561 | 3545 | 3546 |
| api /api/health | 200 | 0 | 47 | 67 | 69 | 46 | 152 | 251 | 269 |
| api mcp search_contacts | 200 | 0 | 86 | 115 | 115 | 86 | 243 | 391 | 391 |
| api mcp who_do_i_know_at | 200 | 0 | 73 | 103 | 103 | 72 | 238 | 418 | 418 |
| api mcp due_followups | 200 | 0 | 99 | 134 | 134 | 98 | 297 | 505 | 505 |
| api mcp get_network_overview | 200 | 1 | 121 | 142 | 142 | 120 | 381 | 595 | 595 |
| api v1 contacts?q= | 200 | 0 | 80 | 101 | 101 | 80 | 207 | 336 | 336 |
| api v1 followups | 200 | 0 | 95 | 123 | 123 | 95 | 298 | 567 | 567 |
| api ext me | 200 | 0 | 73 | 114 | 114 | 72 | 245 | 1857 | 1857 |
| api ext contacts?q= | 200 | 0 | 58 | 86 | 86 | 57 | 189 | 311 | 311 |
| api meetings candidates | 200 | 0 | 80 | 99 | 309 | 79 | 298 | 376 | 412 |

## AI paths, tier 500 (mock provider: {"ttft":900,"token":12,"tokens":180,"json":900,"jsonLarge":4000,"embed":215,"stt":1500})

| chat question | headers p50 | first token p50 | complete p50 | statements |
| --- | --- | --- | --- | --- |
| lookup: Who do I know at Acme? | 32 | 3064 | 5307 | 31 |
| open: Who should I talk to about hiring a staff engineer in Toronto? | 13 | 3061 | 5293 | 39 |
| person: What did I last discuss with Sarah Chen? | 16 | 2045 | 4256 | 27 |

Stage timeline of one open question (ms after request): 125 {"id":"understand","kind":"understand","label":"Working out what you're asking f; 152 {"id":"roster","kind":"roster","label":"You know 30 people at Acme","status":"do; 1246 {"id":"understand","kind":"understand","label":"Worked out what you're asking fo; 1247 {"id":"search","kind":"search","label":"Searching your network","status":"active; 1485 {"id":"search","kind":"search","label":"Searched your network, found 30 candidat; 1485 {"id":"rank","kind":"rank","label":"Ranking 30 candidates","status":"active"}; 1495 {"id":"search","kind":"search","label":"Searched your network, found 30 candidat; 2405 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 2405 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 2406 {"id":"read","kind":"read","label":"Reading notes on 12 people","status":"active; 2427 {"id":"read","kind":"read","label":"Read notes on 10 people","status":"done","ms; 2430 {"id":"answer","kind":"answer","label":"Writing the answer","status":"active"}; 5624 {"id":"answer","kind":"answer","label":"Wrote the answer","status":"done","ms":3

Capture (paste 478 chars → reviewed): p50 12185 ms; runs: 12185, 12189, 12152

## AI paths, tier 5000 (mock provider: {"ttft":900,"token":12,"tokens":180,"json":900,"jsonLarge":4000,"embed":215,"stt":1500})

| chat question | headers p50 | first token p50 | complete p50 | statements |
| --- | --- | --- | --- | --- |
| lookup: Who do I know at Acme? | 16 | 3535 | 5752 | 31 |
| open: Who should I talk to about hiring a staff engineer in Toronto? | 19 | 3974 | 6193 | 39 |
| person: What did I last discuss with Sarah Chen? | 12 | 2567 | 4781 | 27 |

Stage timeline of one open question (ms after request): 122 {"id":"understand","kind":"understand","label":"Working out what you're asking f; 148 {"id":"roster","kind":"roster","label":"You know 295 people at Acme","status":"d; 1207 {"id":"understand","kind":"understand","label":"Worked out what you're asking fo; 1209 {"id":"search","kind":"search","label":"Searching your network","status":"active; 2028 {"id":"search","kind":"search","label":"Searched your network, found 60 candidat; 2028 {"id":"rank","kind":"rank","label":"Ranking 60 candidates","status":"active"}; 2040 {"id":"search","kind":"search","label":"Searched your network, found 60 candidat; 2951 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 2951 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 2953 {"id":"read","kind":"read","label":"Reading notes on 12 people","status":"active; 2990 {"id":"read","kind":"read","label":"Read notes on 11 people","status":"done","ms; 2996 {"id":"answer","kind":"answer","label":"Writing the answer","status":"active"}; 6162 {"id":"answer","kind":"answer","label":"Wrote the answer","status":"done","ms":3

Capture (paste 478 chars → reviewed): p50 12294 ms; runs: 12321, 12294, 12234

## AI paths, tier 50000 (mock provider: {"ttft":900,"token":12,"tokens":180,"json":900,"jsonLarge":4000,"embed":215,"stt":1500})

| chat question | headers p50 | first token p50 | complete p50 | statements |
| --- | --- | --- | --- | --- |
| lookup: Who do I know at Acme? | 20 | 3822 | 6046 | 32 |
| open: Who should I talk to about hiring a staff engineer in Toronto? | 14 | 8101 | 10306 | 40 |
| person: What did I last discuss with Sarah Chen? | 15 | 2659 | 4866 | 28 |

Stage timeline of one open question (ms after request): 180 {"id":"understand","kind":"understand","label":"Working out what you're asking f; 370 {"id":"roster","kind":"roster","label":"You know 2,942 people at Acme","status":; 1437 {"id":"understand","kind":"understand","label":"Worked out what you're asking fo; 1438 {"id":"search","kind":"search","label":"Searching your network","status":"active; 2225 {"id":"search","kind":"search","label":"Searched your network, found 60 candidat; 2225 {"id":"rank","kind":"rank","label":"Ranking 60 candidates","status":"active"}; 2237 {"id":"search","kind":"search","label":"Searched your network, found 60 candidat; 3148 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 3149 {"id":"rank","kind":"rank","label":"Kept the 12 closest matches","detail":"In se; 3150 {"id":"read","kind":"read","label":"Reading notes on 12 people","status":"active; 3174 {"id":"read","kind":"read","label":"Read notes on 9 people","status":"done","ms"; 3177 {"id":"answer","kind":"answer","label":"Writing the answer","status":"active"}; 6334 {"id":"answer","kind":"answer","label":"Wrote the answer","status":"done","ms":3

Capture (paste 478 chars → reviewed): p50 13585 ms; runs: 13737, 13585, 13421

## LinkedIn import, tier 500 (20000 rows, 1965 KB CSV, network of 525)

| phase | ms | first progress ms | rows/s | statements |
| --- | --- | --- | --- | --- |
| stage (parse + write rows) | 2199 | – | – | 20 |
| run: all creates | 85488 | 85472 | 234 | 823 |
| stage again | 1674 | – | – | 20 |
| run: all merges | 138413 | 138404 | 144 | 567 |

## LinkedIn import, tier 5000 (20000 rows, 1965 KB CSV, network of 5025)

| phase | ms | first progress ms | rows/s | statements |
| --- | --- | --- | --- | --- |
| stage (parse + write rows) | 2127 | – | – | 20 |
| run: all creates | 88945 | 88932 | 225 | 823 |
| stage again | 1858 | – | – | 20 |
| run: all merges | 138757 | 138753 | 144 | 567 |

## LinkedIn import, tier 50000 (20000 rows, 1965 KB CSV, network of 50025)

| phase | ms | first progress ms | rows/s | statements |
| --- | --- | --- | --- | --- |
| stage (parse + write rows) | 1576 | – | – | 20 |
| run: all creates | 114448 | 114435 | 175 | 823 |
| stage again | 1702 | – | – | 20 |
| run: all merges | 167119 | 167115 | 120 | 567 |

## Constellation (/bench/constellation, static production build)

| n | profile | payload KB | ready ms | long tasks ms | idle fps | pan fps | pan p95 frame | zoom fps | nodes | heap MB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 500 | desktop | 301 | 518 | 84 | 60.3 | 60.1 | 16.7 | 37 | 177 | 49.4 |
| 5000 | desktop | 2969 | 972 | 237 | 60.2 | 60.1 | 16.7 | 52.2 | 133 | 22.2 |
| 50000 | desktop | 29671 | 2764 | 1355 | 59.3 | 59.1 | 16.8 | 54.2 | 100 | 147.4 |
| 500 | mobile4g | – | – | – | – | – | – | – | – | Error: page.evaluate: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')
    at center (eval at evaluate (:311:30), <anonymous>:3:42)
    at eval (eval at evaluate (:311:30),  |
| 5000 | mobile4g | – | – | – | – | – | – | – | – | Error: page.evaluate: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')
    at center (eval at evaluate (:311:30), <anonymous>:3:42)
    at eval (eval at evaluate (:311:30),  |
| 50000 | mobile4g | – | – | – | – | – | – | – | – | Error: page.evaluate: TypeError: Cannot read properties of null (reading 'getBoundingClientRect')
    at center (eval at evaluate (:311:30), <anonymous>:3:42)
    at eval (eval at evaluate (:311:30),  |
