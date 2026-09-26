# Chat workspace corner

The missing top-left curve was caused by the sidebar motion clip, not by the welcome prompt or skill pills. The decorative corner begins 1px past the sidebar edge and is 18px wide, but the expanded sidebar exposed only 8px past that edge.

The expanded clip now allows 20px, preserving the entire corner while retaining the existing closing clip, opacity, and slide. The Chromium panel-motion fixture checks that allowance and the non-interactive collapsed sidebar.

Validation: the mainstream Chromium panel-motion probe passed with three directions; the Internal Chromium probe passed with four. Both projects passed 47 panel/layout tests, typecheck, and production build. Full mainstream `npm run verify` reached 218 passing test files (5,339 tests) and two unrelated `test/session.test.ts` timeouts; both timed-out tests passed when rerun alone. Internal Chromium's first full verify stopped on a transient Windows `EPERM` while staging ripgrep; a separate `npm run rg` retry passed. `git diff --check` passed in both trees. No package or installation was made.
