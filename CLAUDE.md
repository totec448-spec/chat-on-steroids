# Claude repository instructions

Read and follow `AGENTS.md` before changing this repository.

This is a public repository. Never add Claude provenance session URLs or session trailers to
commit messages, files, release notes, logs, or generated artifacts. Maintainer commits must use
a GitHub noreply address; never use a personal mailbox or a private local path. Before every
commit, push, tag, or release, run `npm run verify:privacy`. The versioned Git hooks installed by
`npm run hooks:install` enforce the same policy for Claude-created commits.

Do not bypass these guards with `--no-verify`. If a privacy check blocks a change, remove the
private value at its source and create a new clean commit instead.

Never push this clone's local branch history. Publish work as fresh commits built on the remote
branch tip (`git write-tree` / `git commit-tree`, or a merge of `origin/main` done the same way),
pointed at by a new local branch. The local history is private and stays here.

Never add a `Co-Authored-By` trailer, a "Generated with" line, or any other Claude attribution to
commits, pull requests, tags or release notes. The maintainer is the only author on this repository.
