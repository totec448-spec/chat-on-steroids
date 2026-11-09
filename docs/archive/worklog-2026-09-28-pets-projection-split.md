# Independent Pets projection and visibility fixes

Extracted from #537 onto upstream 21b960a at the reviewer's request. The two changes are
independent of Windows activation: use pet-library's initial state/change publication in the
overlay host (no repeated package validation/image decoding on pointer polls), and include
visibility/disposal in renderer interaction deduplication so hide/show can re-arm input.

No focusability, native binding, dependency, packaging or focus-return change is included.
The original Windows missing-pointerdown bug and keyboard focus return remain in #537.
The user's integration tree and full working Windows correction are unchanged.

Validation on this split: typecheck passed; host/renderer tests passed (5 tests, 2 files),
including an explicit unchanged non-focusable host assertion, catalog publication/empty start,
idle polling without repeated reads, and stationary-pointer hide/show. Diff whitespace passed.
No native drag or cross-platform runtime claim for this reduced patch; full CI runs remotely.
