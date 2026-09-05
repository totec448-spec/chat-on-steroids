# Sourced by every hook in this directory, never run directly.
#
# Git invokes hooks with a minimal PATH that often excludes a user-local Node install —
# `~/.local/bin`, nvm's per-version bin, Homebrew's `/opt/homebrew/bin` on Apple Silicon — so a
# bare `exec node ...` can fail with `exec: node: not found`. That reads as a git problem, and a
# QA round measured exactly that reading it caused: a push aborted on this line, on a machine
# where node was installed and worked everywhere else, under `~/.local`. Widen the search before
# giving up, and say plainly what happened and how to recover if it still cannot be found, rather
# than leaving the generic shell error as the only trace.
#
# The version-manager layouts are globbed rather than listed because none of them install a
# bare `bin/node`: an official tarball unpacked under `~/.local` keeps its own
# `node-v22.23.2/bin`, and nvm and fnm both key a directory on the version. The first widening
# of this list named `~/.local/bin` for the machine that reported the problem and still did not
# find that machine's node, which was one directory further down all along.
#
# The two fixed (non-$HOME) candidates are overridable so a test can point them at a directory
# that provably does not exist instead of the real system paths. Left unset, both default to
# the real locations for every actual hook invocation - this is not a behavior switch, only a
# seam test/git-hooks.test.ts needs: a machine that genuinely has node at /usr/local/bin (common
# on Linux and Intel-Homebrew installs) would otherwise make every candidate below it
# unreachable from a test's synthetic $HOME, regardless of which layout the test means to check.
: "${CLF_HOOK_HOMEBREW_BIN:=/opt/homebrew/bin}"
: "${CLF_HOOK_USR_LOCAL_BIN:=/usr/local/bin}"
if ! command -v node >/dev/null 2>&1; then
  for candidate in \
    "$HOME/.local/bin" \
    "$CLF_HOOK_HOMEBREW_BIN" \
    "$CLF_HOOK_USR_LOCAL_BIN" \
    "$HOME/.volta/bin" \
    "$HOME"/.local/node-*/bin \
    "$HOME"/.nvm/versions/node/*/bin \
    "$HOME"/.fnm/node-versions/*/installation/bin \
    "$HOME"/n/bin
  do
    # An unmatched glob stays literal here, and a literal path is simply not executable.
    if [ -x "$candidate/node" ]; then
      PATH="$candidate:$PATH"
      export PATH
      break
    fi
  done
fi
if ! command -v node >/dev/null 2>&1; then
  echo "$(basename "$0"): node not found on PATH or in common install locations" \
    "(~/.local, Homebrew, Volta, nvm, fnm, n). The privacy check could not run — add node to" \
    "PATH, or run 'npm run verify:privacy' by hand before pushing." >&2
  exit 1
fi
