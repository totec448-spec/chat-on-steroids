# Windows plugin installer close boundary — 2026-09-22

## Failure

The Windows CI runner completed the temporary `uv.exe` process and then failed to remove the
test environment with `EBUSY`. `runInstaller()` resolved on the child `exit` event, which proves
the process ended but can precede closure of its executable and stdio handles on Windows.

## Repair

The installer now retains ownership until the child `close` event. Callers may replace or remove
staged runtimes immediately after a successful installer promise without adding filesystem
retries or sleeps. Exit-code handling, the three-minute deadline and process-tree termination are
unchanged.

## Validation

The focused Windows plugin-environment test executes a copied real executable through the same
runtime-discovery path and immediately removes its complete temporary profile. The three focused
plugin files passed 74 tests in both repositories; the exact Windows removal case passed five
consecutive Mainstream runs. Typecheck and production build passed in both trees. The upstream
CI matrix rerun remains the final acceptance level.
