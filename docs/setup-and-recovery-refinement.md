# Setup, profiles and recovery refinements

First-run Setup retains the six-step English/Chinese guide. Profile management is a compact
row below Language in Settings: choose a profile, add a named profile with Plus, or delete
an entry from its dropdown. The last profile remains protected. Active profile removal
selects a survivor atomically; encrypted keys retain their exact profile ownership.

The guide removes duplicate screenshots, shows both plugin screenshots together, supports
enlargement and marks missing required fields. Its collapse control remains available before
setup is complete. Settings places model defaults and worker/recovery choices near the top.

Project chats support deliberate in-group ordering, aligned labels and incremental expansion.
Generated plans clear their unchanged composer draft and support Enter submission while
preserving corrections authored during asynchronous admission.

Goal/Loop recovery reports its existing wait reason, explains failures and discards an obsolete
draft when the native conversation resumes work. Confirmed recovery retains source ownership
through reload adoption. Accepted temporary helper answers retire only their exact safe tab.

Validation includes focused owner-boundary regressions, Electron layout/interaction checks,
full repository verification and a production build. The bidirectional history test retains
all wheel/keyboard/scrollbar and live-update assertions; its mock geometry now indexes each
DOM revision once instead of rescanning the entire timeline for each rectangle. This reduced
the focused local test run from 9.83 seconds to 3.53 seconds without increasing its timeout.

Windows installation evidence is separate from CI: the local workspace package passed native
runtime smoke, all 285 installed files matched the package, and all 14 stable companion files
matched. This PR additionally preserves changes already integrated on public main. No release
or automatic update notification is created by these changes.

## 2.1.0 release audit follow-up

The first unpublished candidate passed packaged-runtime smoke but rejected the desktop addon against an obsolete macOS 12.3 exception. The actual bundle metadata already declares macOS 13.0 and Electron's addon build requires 13.0. All Mach-O payloads now use the same checked bundle minimum; binaries requiring a newer OS remain rejected. Architecture, executable mode, signatures and archive audits stay intact.

Validation: packaging regression coverage accepts a 13.0 desktop addon under the declared 13.0 floor and rejects 14.0. Native bundle/archive verification remains mandatory in the release workflow. No release or update notification was published for the failed candidate.

The Windows published-plugin fixture also bypassed PluginManager's process-tree shutdown. SDK close could stop a Python launcher while Unity's child retained the temporary working directory, producing EBUSY on both main CI attempts. The fixture now uses the same existing terminateProcessTree boundary before closing the transport and deleting its own directory; discovery assertions and cleanup remain enforced.
