# Contributors

Chat On Steroids is maintained by [@totec448-spec](https://github.com/totec448-spec) and built with contributions from the community.

Some contributions were adapted into maintainer snapshot commits and their original PRs were closed without preserving GitHub commit attribution. That was our mistake. Reworking a patch does not erase its author's contribution. The record below restores explicit credit and links to the original work.

## Incorporated code and designs

Listed alphabetically by GitHub handle. "Adapted" means the implementation changed during integration; it does not mean the entire original branch was merged.

| Contributor | Contribution and original work |
| --- | --- |
| [@becoolmin](https://github.com/becoolmin) | Preserving window size on reopen: [#122](https://github.com/totec448-spec/chat-on-steroids/pull/122), adapted into [#134](https://github.com/totec448-spec/chat-on-steroids/pull/134). |
| [@Bemirror99](https://github.com/Bemirror99) | Resume-shadow recovery and stale Fiber attribution fixes: merged [#19](https://github.com/totec448-spec/chat-on-steroids/pull/19) and [#20](https://github.com/totec448-spec/chat-on-steroids/pull/20). |
| [@devrajmahar](https://github.com/devrajmahar) | Conversation-scoped generation reset, extracted with an independent SPA recovery regression from [#163](https://github.com/totec448-spec/chat-on-steroids/pull/163). The renderer rewrite and other feature changes were not incorporated. |
| [@Firefulcar](https://github.com/Firefulcar) | Claimed Compact & Resume leases: merged [#33](https://github.com/totec448-spec/chat-on-steroids/pull/33). Selected-browser startup routing: [#100](https://github.com/totec448-spec/chat-on-steroids/pull/100), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@frytufrytu](https://github.com/frytufrytu) | Diagnosing and fixing blocked-handoff compaction recovery loops: [#127](https://github.com/totec448-spec/chat-on-steroids/pull/127), adapted with durable refusal and draft preservation into [#134](https://github.com/totec448-spec/chat-on-steroids/pull/134). |
| [@gnustella-lab](https://github.com/gnustella-lab) | Brave Browser support: merged [#106](https://github.com/totec448-spec/chat-on-steroids/pull/106). |
| [@hhh2210](https://github.com/hhh2210) | Native macOS Desktop backend and platform validation: merged [#28](https://github.com/totec448-spec/chat-on-steroids/pull/28). Desktop reply provenance, activity details, editable folder access and the bounded bridge RFC: merged [#74](https://github.com/totec448-spec/chat-on-steroids/pull/74), [#75](https://github.com/totec448-spec/chat-on-steroids/pull/75), [#77](https://github.com/totec448-spec/chat-on-steroids/pull/77), [#43](https://github.com/totec448-spec/chat-on-steroids/pull/43). Companion mismatch guidance: [#101](https://github.com/totec448-spec/chat-on-steroids/pull/101), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@Inmerson](https://github.com/Inmerson) | Fresh worker placement through the Prime's extension context, background tabs and a single fallback owner: [#72](https://github.com/totec448-spec/chat-on-steroids/pull/72), adapted for batch-safe placement. |
| [@JeshuaCastro](https://github.com/JeshuaCastro) | Per-worker model and reasoning selection design: [#68](https://github.com/totec448-spec/chat-on-steroids/pull/68). The incorporated design was completed by the schema correction in [#87](https://github.com/totec448-spec/chat-on-steroids/pull/87) through [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@lookvincent](https://github.com/lookvincent) | Native ChatGPT artifact downloads and custom OpenAI-compatible Goal/Loop providers: [#94](https://github.com/totec448-spec/chat-on-steroids/pull/94) and [#95](https://github.com/totec448-spec/chat-on-steroids/pull/95), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@Maximapple](https://github.com/Maximapple) | Merged fixes for public-history scope, Project routes, swapped mouse buttons, tunnel readiness, access limits, RTL text, Linux packaging, complete session enumeration and continuation relays: [#37](https://github.com/totec448-spec/chat-on-steroids/pull/37), [#38](https://github.com/totec448-spec/chat-on-steroids/pull/38), [#79](https://github.com/totec448-spec/chat-on-steroids/pull/79), [#110](https://github.com/totec448-spec/chat-on-steroids/pull/110), [#116](https://github.com/totec448-spec/chat-on-steroids/pull/116), [#117](https://github.com/totec448-spec/chat-on-steroids/pull/117), [#131](https://github.com/totec448-spec/chat-on-steroids/pull/131), [#139](https://github.com/totec448-spec/chat-on-steroids/pull/139), [#141](https://github.com/totec448-spec/chat-on-steroids/pull/141). Adapted work on handoff lifetime, macOS sealing, Project successors, worker schemas, custom instructions and caller-evidence waits: [#39](https://github.com/totec448-spec/chat-on-steroids/pull/39), [#80](https://github.com/totec448-spec/chat-on-steroids/pull/80), [#86](https://github.com/totec448-spec/chat-on-steroids/pull/86), [#87](https://github.com/totec448-spec/chat-on-steroids/pull/87), [#88](https://github.com/totec448-spec/chat-on-steroids/pull/88), [#115](https://github.com/totec448-spec/chat-on-steroids/pull/115). |
| [@PatrickSys](https://github.com/PatrickSys) | Windows installer sandbox folder permissions: [#62](https://github.com/totec448-spec/chat-on-steroids/pull/62), incorporated into the 2.0.6 snapshot and retained in [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@TaeyanG4](https://github.com/TaeyanG4) | Handling plugin schemas when a Refresh control is unavailable: [#92](https://github.com/totec448-spec/chat-on-steroids/pull/92), adapted into [#91](https://github.com/totec448-spec/chat-on-steroids/pull/91). |
| [@ventianima-lab](https://github.com/ventianima-lab) | Preserving the exact message, conversation and page-epoch identity accepted by a desktop-send ACK when later canonical text differs, so the same send retains its turn-start boundary: adapted from the [code and regression tests in #185](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5647883368). This narrow repair does not reconstruct earlier missing history or resolve every symptom in the issue. |

The September 12 repair snapshot also adapts [@Maximapple](https://github.com/Maximapple)'s
destination loading guard ([#164](https://github.com/totec448-spec/chat-on-steroids/pull/164)),
expired automatic resume claim release ([#165](https://github.com/totec448-spec/chat-on-steroids/pull/165)),
nested user-message text fix ([#179](https://github.com/totec448-spec/chat-on-steroids/pull/179)) and
disabled-permission guidance from [#146](https://github.com/totec448-spec/chat-on-steroids/pull/146).
The claim release was strengthened with durable command/document ownership; this does not
incorporate the rest of the native Desktop proposal.

The September 13 review confirms the incorporated bounded tab-reuse work from
[@ventianima-lab](https://github.com/ventianima-lab) ([#144](https://github.com/totec448-spec/chat-on-steroids/pull/144),
[#159](https://github.com/totec448-spec/chat-on-steroids/pull/159)), the stream-attribution design
from [#170](https://github.com/totec448-spec/chat-on-steroids/pull/170), and
[@nofihq](https://github.com/nofihq)'s fetch-reattachment follow-up. The implementation retains
bounded server-metadata parsing and exact page ownership; this does not claim every attribution
failure is resolved. Pinned-tab protection incorporates the proposals from
[@Maximapple](https://github.com/Maximapple) ([#161](https://github.com/totec448-spec/chat-on-steroids/pull/161))
and [@L4XB](https://github.com/L4XB) ([#158](https://github.com/totec448-spec/chat-on-steroids/pull/158)),
with fresh pin checks at the existing close sites.
[@pop15106](https://github.com/pop15106)'s [#192](https://github.com/totec448-spec/chat-on-steroids/pull/192)
corrected the README and hero's absolute quota claim. The adapted wording describes CoS's Chat
surface and links to OpenAI's current Work/Codex usage policy.

Additional receipt-promotion and adopted-answer ownership fixes adapt
[@ventianima-lab](https://github.com/ventianima-lab)'s minimal reproductions and proposed repairs
in [#185](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5650663451)
and its [remounted-answer follow-up](https://github.com/totec448-spec/chat-on-steroids/issues/185#issuecomment-5651819276).

## Reports, review and proposed work

[@ventianima-lab](https://github.com/ventianima-lab)'s reproductions also led to the focused
resume-selection ([#155](https://github.com/totec448-spec/chat-on-steroids/issues/155)) and Windows
plugin-path ([#178](https://github.com/totec448-spec/chat-on-steroids/issues/178)) repairs.
[@rcnir](https://github.com/rcnir) identified the unknown-model silence-recovery gap in
[#172](https://github.com/totec448-spec/chat-on-steroids/issues/172), and
[@Gauthammaster2012Code](https://github.com/Gauthammaster2012Code) reported the missing visible
plan-collapse affordance in [#191](https://github.com/totec448-spec/chat-on-steroids/issues/191).

Contributions also include reproductions, independent testing, designs and patches that are still under review or were superseded. Thank you to:

- [@ventianima-lab](https://github.com/ventianima-lab) for detailed request-attribution and delivery investigations and controller, stream-observation and tab-reuse proposals, including [#108](https://github.com/totec448-spec/chat-on-steroids/issues/108), [#124](https://github.com/totec448-spec/chat-on-steroids/pull/124), [#159](https://github.com/totec448-spec/chat-on-steroids/pull/159) and [#170](https://github.com/totec448-spec/chat-on-steroids/pull/170).
- [@nofihq](https://github.com/nofihq) for independent Linux validation on [#159](https://github.com/totec448-spec/chat-on-steroids/pull/159) and [#170](https://github.com/totec448-spec/chat-on-steroids/pull/170), and the recovery investigations in [#175](https://github.com/totec448-spec/chat-on-steroids/pull/175) and [#183](https://github.com/totec448-spec/chat-on-steroids/pull/183).
- [@piotrczukwinski](https://github.com/piotrczukwinski) for the localized model-picker investigation and structural discovery proposal in [#102](https://github.com/totec448-spec/chat-on-steroids/pull/102).
- [@L4XB](https://github.com/L4XB) for pinned-tab protection work and the distinction between pinned-tab and active-conversation closure in [#158](https://github.com/totec448-spec/chat-on-steroids/pull/158).
- [@ahrorbeksoft](https://github.com/ahrorbeksoft) for the macOS tray/window lifecycle proposal in [#93](https://github.com/totec448-spec/chat-on-steroids/pull/93).
- [@Akilaydin](https://github.com/Akilaydin) for reviewing the fallback race and clarifying browser placement in [#72](https://github.com/totec448-spec/chat-on-steroids/pull/72).
- [@lavalava45](https://github.com/lavalava45) for regional artifact-host reproductions in [#111](https://github.com/totec448-spec/chat-on-steroids/issues/111).

This is a growing attribution record, not a complete list of everyone who has helped. The [PR history](https://github.com/totec448-spec/chat-on-steroids/pulls?q=is%3Apr) and [issue history](https://github.com/totec448-spec/chat-on-steroids/issues?q=is%3Aissue) retain other submissions and discussions. Acknowledging a proposal here does not claim it was merged.

## Preserving credit

Keep original authorship when merging a contribution. When adapting or consolidating contributed work, name the original author and PR, and preserve appropriate `Co-authored-by` trailers using the contributor's public GitHub noreply identity. Reports and review deserve explicit acknowledgment without inventing code authorship. See [CONTRIBUTING.md](CONTRIBUTING.md#credit-and-attribution).

The September 2026 attribution correction adds a new public record and retroactive co-author credit for incorporated work. It does not rewrite released commits or imply that contributors authored the correction's prose. GitHub's automatic contributor displays are separate from this maintained record.
