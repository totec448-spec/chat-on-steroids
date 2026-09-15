# Published-code issue reproductions

These fixtures characterize failures in commit `2f9be7eb9d6d1f13ccac9019e20965af15d4e4be`. They do not verify the newer dirty Windows worktree or a signed-in ChatGPT session. Both result files deliberately report `fixVerified: false`.

From this directory, use Node 22.16.0 or a compatible Node version with TypeScript stripping:

```sh
node --experimental-strip-types reproduce-187.mjs
node reproduce-212.mjs
```

No package install, browser, API credentials, real signed file reference, or network request is used. The scripts overwrite only their adjacent JSON result files and fail with a nonzero exit if an assertion fails.

## Sources and scope

`artifact-fetch.ts` is the unchanged complete repository module from `src/main/mcp/artifact-fetch.ts`, Git blob `edfad203750c8fe096e0d9a63d38f8be514d6257`. The #187 harness checks that blob identity before testing it. Three report-provided Azure regional hostnames are rejected before the injected fetch stub runs. Three accepted-host controls and nine rejection guards are covered. This demonstrates the rejection, not independent native-origin proof for the reported hosts.

`project-entry-published.js` is the unchanged `projectHomeId`/`enterProject` excerpt from `extension/chatgpt-dom.js`, whose full-file Git blob is `c7effab569d84ccd227d735c6e766efe4debda3b`. The #212 harness supplies synthetic DOM dependencies and virtual timers. Readiness at 11 seconds succeeds; readiness at 13 seconds fails at 12. Six other cases cover never-ready, cancellation, user interruption, attachments, ambiguous links and a swallowed single click. This does not test the enclosing continuation workflow or the later expiry-aware patch.

Expected summaries: #187 has 3 reproduced rejections, 3 positive controls and 9 rejection guards; #212 has 8 characterization cases. These are original-behavior checks, not evidence of a released fix.

The repository-root `ISSUE_TRIAGE.md` records the full 47-issue inventory, prior test report counts, GitHub actions, and remaining blockers. Keep it as the canonical audit; these fixtures are supporting evidence. Source copies retain the repository's MIT license.
