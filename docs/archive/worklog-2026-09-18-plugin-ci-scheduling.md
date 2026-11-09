# Live plugin CI scheduling

The pet CPU PR passed the normal verification suite on Windows, macOS and Linux.
Two Windows runs then failed during the separate live-plugin integration step:
Fetch exceeded the unchanged 20-second server initialization bound, while Blender
cleanup reported a locked working directory. Unity failed cleanup in the first
run and passed in the second. The plugin source and tests were unchanged by the
pet PR, and the preceding main-line build had passed them.

The three corresponding tests passed locally without source changes (Fetch in
about 9 seconds, Blender in 12 and Unity in 15). The CI step had been running
independent suites that install large npm/Python environments concurrently, then
immediately initializing their cold servers. Resource contention is the working
explanation; the available failure logs do not identify the underlying host I/O
or Python import costs.

The dedicated live-plugin step now uses one Vitest worker. Every existing test
and assertion still executes; production connection and shutdown deadlines are
unchanged. The ordinary verification suite retains its existing parallelism.
The sequential command is checked locally and the exact PR head is validated by
the platform CI jobs before delivery.
