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
| /contacts | 9224 | – |
| /reminders | no link | – |
| /dashboard | timeout | – |
| /graph | no link | – |
| /chat | 4024 | 1746 |
| /capture | no link | – |
| /contacts | 3082 | – |
| /dashboard | timeout | – |

History: back – ms, forward – ms.

## Pages, tier 5000, desktop (unthrottled; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 1923 | 2236 | 2452 | 2568 | 48 | 0 | 164 | 1724 | 45 | 2338 | 2828 | 10 |
| /contacts | – | – | – | – | – | – | – | – | – | – | – | – |
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
| /contacts | timeout | – |
| /reminders | 3576 | – |
| /dashboard | 2282 | – |
| /graph | 1707 | – |
| /chat | 652 | – |
| /capture | 707 | 379 |
| /contacts | timeout | – |
| /dashboard | 4883 | 4068 |

History: back – ms, forward 1758 ms.

## Pages, tier 5000, mobile4g (4G 150 ms RTT, 4x CPU slowdown; next dev demo mode, median of 3)

| page | TTFB | FCP | LCP | usable | INP | CLS | TBT | JS gz KB | requests | repeat TTFB | repeat usable | repeat JS KB |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| /dashboard | 1493 | 3228 | 9608 | 12948 | – | 0 | 904 | 1724 | 45 | 1731 | 4463 | 10 |
| /contacts | – | – | – | – | – | – | – | – | – | – | – | – |
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
| /contacts | timeout | – |
| /reminders | 9498 | 6984 |
| /dashboard | timeout | – |
| /graph | no link | – |
| /chat | 3996 | 1571 |
| /capture | no link | – |
| /contacts | timeout | – |
| /dashboard | timeout | – |

History: back – ms, forward – ms.

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

## HTTP routes and documents, tier new (n=30 sequential, then 5 concurrent; next dev)

| target | status | KB | single p50 | p95 | p99 | ttfb p50 | conc p50 | conc p95 | conc p99 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| doc /dashboard | 200 | 196 | 430 | 584 | 841 | 427 | 2307 | 2678 | 2725 |
| doc /contacts | 200 | 143 | 213 | 305 | 305 | 210 | 1090 | 1328 | 1329 |
| doc /contacts?q=hopper | 200 | 144 | 256 | 340 | 343 | 253 | 1182 | 1436 | 1437 |
| doc /reminders | 200 | 143 | 261 | 339 | 361 | 257 | 1453 | 2703 | 2703 |
| doc /capture | 200 | 137 | 294 | 406 | 424 | 291 | 1840 | 2045 | 2046 |
| doc /chat | 200 | 126 | 243 | 388 | 426 | 240 | 1519 | 1813 | 1813 |
| doc /graph | 200 | 108 | 283 | 519 | 538 | 281 | 1342 | 3176 | 3177 |
| doc /knowledge | 200 | 111 | 209 | 273 | 277 | 207 | 1094 | 1134 | 1137 |
| doc /imports | 200 | 134 | 208 | 255 | 255 | 204 | 952 | 1159 | 1165 |
| doc /settings | 200 | 226 | 287 | 412 | 425 | 281 | 1681 | 3650 | 3650 |
| api /api/health | 200 | 0 | 46 | 58 | 62 | 46 | 150 | 260 | 262 |
| api mcp search_contacts | 200 | 0 | 91 | 129 | 130 | 91 | 294 | 494 | 546 |
| api mcp who_do_i_know_at | 200 | 0 | 77 | 99 | 99 | 77 | 276 | 2017 | 2101 |
| api mcp due_followups | 429 | 0 | 59 | 84 | 86 | 58 | 208 | 362 | 373 |
| api mcp get_network_overview | 429 | 0 | 64 | 92 | 93 | 64 | 194 | 333 | 334 |
| api v1 contacts?q= | 200 | 0 | 79 | 108 | 121 | 79 | 244 | 404 | 441 |
| api v1 followups | 200 | 0 | 107 | 161 | 1496 | 106 | 306 | 530 | 532 |
| api ext me | 200 | 0 | 78 | 94 | 96 | 77 | 225 | 384 | 408 |
| api ext contacts?q= | 429 | 0 | 60 | 74 | 78 | 60 | 192 | 303 | 321 |
| api meetings candidates | 200 | 0 | 82 | 120 | 370 | 82 | 346 | 1559 | 1576 |

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
