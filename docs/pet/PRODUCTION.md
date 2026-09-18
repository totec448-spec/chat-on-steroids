# Tur Tur Sahur pet — animation production contract

The approved base is `approved-base.png`. The previous 36-frame sheet and the
1×6 strips are rejected prototypes, not production artwork. Their structural
validation did not establish visual quality. No app integration has shipped.

## Generation method

Generate exactly six **new consecutive** frames per ImageGen invocation in a
**3-column × 2-row** image. Read frames left-to-right, then the next row. Use the
approved base plus the last one or two **cropped individual frames as actual
image inputs** for the next invocation. Never reset each batch to the base pose.
Batch boundaries are unrelated to animation boundaries: a punch or throw can
span several batches. The previous frame is a reference, not one of the six new
frames. Sixteen accepted batches provide 96 authored character frames.

Keep rigid log dimensions, face proportions, palette, outline thickness, camera,
logical pixel scale and foot ground line constant. Target 64×96 logical character
detail inside generous 160×160 runtime cells. Register by the character root and
ground, never independently stretch each frame to fill a cell. Pixel snapping and
nearest-neighbor sampling happen at asset export. Judge continuity in motion at
normal pet scale, enlarged pixel scale and both app themes.

The bat must be visible and used to strike OpenAI. Attack frames contain the
clearly held bat; a separate rigid sprite supplies it in earlier noncombat frames.
It must never fuse with the arms/body. Targets are DOM plain text; impact
sparks and the reacting bin are separate original pixel assets. No company logos.

## Fixed frame allocation (96 total)

| Frames | Count | Motion |
| --- | ---: | --- |
| 0–3 | 4 | Spawn: crouch, rise, settle into standing |
| 4–7 | 4 | Idle: restrained breathing, clean loop closure |
| 8–11 | 4 | Blink and look: close, glance, return |
| 12–19 | 8 | Complete walk cycle, both feet contact/pass; left uses direction reflection |
| 20–23 | 4 | Held: pickup transition, dangling legs, settling hold |
| 24–27 | 4 | Landing: feet touch, knees absorb, rise, settle |
| 28–31 | 4 | Poke: surprise, recoil, annoyed recovery, settle |
| 32–37 | 6 | Repeated-click anger: tense, stomp, fists, recover |
| 38–55 | 18 | Three connected six-frame bat strikes: anticipate, accelerate, contact, follow through, retract, transfer weight |
| 56–65 | 10 | Heavy finishing hit: longer windup, launch, impact, overshoot and recovery |
| 66–71 | 6 | Grab: prepare, reach, close fingers, secure grip, lift, settle |
| 72–79 | 8 | Carry: complete supported walking cycle with stable hand attachment |
| 80–87 | 8 | Throw: plant, rotate, windup, accelerate, release, follow through, recover, settle |
| 88–95 | 8 | Celebrate: anticipation, raise arms, hop, apex, descend, land, proud pose, return |

Generation batches are `[0..5]`, `[6..11]`, …, `[90..95]`. In particular the
punch combo crosses four batches, the heavy hit crosses two, and the throw
crosses two. The six-frame generation limit never caps a motion's length.

## OpenAI → ClosedAI choreography

1. Plain `OpenAI` appears within the available stage area, beyond the fists.
2. Walk cycles 12–19 move toward it with matched ground speed, then decelerate.
3. Bat-strike sequence 38–55 plays once. Contacts at 40, 46 and 52 briefly displace
   the text and emit small pixel sparks. Targets do not drift out of reach.
4. Heavy hit 56–65 has a longer visible anticipation. **Only frame 61 contact**
   changes the text to `ClosedAI`; the target kicks back and settles.
5. Celebrate 88–95, leave the changed text readable briefly, then clear props.

The contact frames, not unrelated timers, own the label change and sparks.
Pause on anticipation/contact briefly rather than repeating identical generated
frames. Reuse walking loops as needed for distance. Text never overlaps the face.

## Anthropic → bin choreography

1. Plain `Anthropic` and a small original pixel bin appear within the stage.
2. Approach with 12–19. Grab 66–71; at **frame 69**, the text attaches to the
   hands without changing screen position at the attachment boundary.
3. Carry 72–79 moves toward the bin, keeping the word above the hands. Match
   gait speed to travel; stop far enough away for a readable throw arc.
4. Throw 80–87 releases at **frame 84**. Preserve its release position, then
   animate a ballistic arc into the bin. The text stays independent of sprites.
5. At actual bin contact, hide the word and bounce the bin lid. Celebrate 88–95.

## Interruption and acceptance

One state-machine owner arbitrates hidden, idle/motion, pointer pending, held,
landing, poke/anger and special action. Drag or hide retires the action and all
props synchronously. A click under the distance threshold is not a drag;
pointer cancellation never becomes a click. Repeated clicks are bounded by a
short rolling time window. Hiding stops requestAnimationFrame entirely.

Persist visibility and the settled, clamped position using the existing renderer
preference pattern. Recheck viewport bounds on resize/zoom; reduced motion removes
autonomous travel and elaborate effects. No backend/provider authority is added.

Before accepting each batch: verify six distinct intended poses, connected limbs,
unchanged face/log dimensions, clear hands, no bat fusion, transparent export and
no neighbor-cell contamination. Inspect previous tail + new batch as a GIF.
Regenerate failures before using their frames as subsequent references. Review
the complete walk/carry loops and both full special actions after assembly.

Final acceptance must separately report source, tests, build, Electron smoke,
real-app interaction, restart, themes, zoom, resize and console results. Do not
describe structural atlas checks as animation or live acceptance.

## Final export and regeneration

Runtime uses `src/renderer/pet-assets/atlas.png`: 1280×1920, eight columns,
96 transparent 160×160 cells, 32-color palette. The visible character remains
approximately 90 pixels tall; padding protects extended bats without changing
the character scale. The registered root is x=80 and the ground is y=136.
Grounded frames align from their foot landmarks. Held/jump poses preserve their
authored vertical displacement. Standing idle/look frames use a fixed 90-pixel
height. The repaired idle bounds vary by at most one pixel across the loop.

The accepted originals are `batches/batch-00.png` through `batch-15.png`.
`batches/repair-003.png` replaces frames 3–8 to correct the reported idle wobble.
Each batch after the first took `approved-base.png` and the preceding cropped
frame as actual ImageGen image inputs. The repair used frame 5 plus the approved
base. The six-pose 3×2 layout is a generation format, not the runtime atlas layout.

To reproduce the local exports from the accepted originals:

```powershell
0..15 | ForEach-Object {
  $batchName = 'docs/pet/batches/batch-{0:D2}.png' -f $_
  node scripts/ingest-pet-batch.mjs $_ $batchName
}
node scripts/ingest-pet-batch.mjs 0 docs/pet/batches/repair-003.png 3
node scripts/build-pet-props.mjs
node scripts/build-pet-atlas.mjs
npm test -- --run test/pet-atlas.test.ts test/pet-choreography.test.ts
```

For new ImageGen generation, retain the approved base and the preceding crop as
two image inputs. Request six NEW consecutive poses in exactly 3 columns × 2 rows
on a 1536×1024 transparent canvas. Specify the six global frame numbers and their
poses from the allocation above. Lock cylinder dimensions, face, palette, camera,
pixel scale and baseline; ask for one distinct, rigid bat with no limb fusion.
Never include text or company graphics. Inspect and repair each batch before
using its final crop as the next input. Generative output is not deterministic;
the archived originals provide exact export reproducibility.

`scripts/pet-plan.mjs` owns timings and measured hand anchors. After any artwork
repair, check those anchors in the registered atlas. `pet-choreography.ts` smoothly
interpolates them and starts the throw exactly at the last attached position.
Company text uses a white shadow/outline with no box, below the character layer.
Special actions adapt their stage to available space; they do not teleport the pet.

`props.png` contains the separate original bat, closed/open/reacting bin and hit
art. The renderer supplies the bat in early frames; combat frames contain it in
the character artwork. Runtime assets are local and need no ImageGen service.

`previews/chronological.gif` and per-clip GIFs show character animation.
`previews/openai-live.gif` and `anthropic-live.gif` are crops of the real Electron
action recordings, including the independent text and bin. Rebuild these with
`node scripts/build-pet-live-previews.mjs` after the Electron acceptance script.
The live GIFs use the recording's average capture interval (about 8 fps). The app
keeps the manifest's authored frame durations. Stationary frames sleep until the
next frame, phase or autonomous decision; travel and interpolated props use
requestAnimationFrame. The context menu and hidden document stop that clock.
Interactions retire any previous wake before scheduling from the new state.
Unchanged DOM values, including hit/target visibility, do not get rewritten.

Run `node scripts/verify-pet-performance.cjs <label> --check` to build the current
production pet and CSS into an isolated Electron fixture. It records process CPU
time normalized across logical processors, renderer task/style/layout work and
actual animation callbacks. A CPU counter reset invalidates that sample instead
of counting it as a saving. The idle/menu checks are independent of machine speed;
CPU percentages are measurements of the fixture, not an installed-app guarantee.
