import type { AppApi } from '../preload/index.js';
import type { PetLibraryState, PetRecord } from '../shared/pets.js';
import type { PetController } from './pet.js';
import { $, el, icon, initCardMenuDismissal, run, toast } from './dom.js';
import { t, ui } from './i18n.js';

const builtinAtlas = new URL('./pet-assets/atlas.png', import.meta.url).href;
const PET_FORMAT_INSTRUCTIONS = `<describe your character here>

Create a production-ready Chat On Steroids (CoS) Pet package from the character brief above. Finish the complete package; do not stop at concept art, sample frames, or an approximate spritesheet.

WORKFLOW AUTHORITY

If you are Codex and the $hatch-pet skill is installed, invoke and read $hatch-pet before producing assets. Its official source is https://github.com/openai/skills/tree/main/skills/.curated/hatch-pet. Reuse its visual workflow: one canonical character reference, grounded image generation, transparency discipline, contact-sheet and motion-preview QA, and smallest-scope repairs. The skill name is the invocation; the URL is only its official reference/discovery location.

Do not use $hatch-pet's default Codex atlas assembler, state list, filenames, validator, or package output. The CoS contract below is authoritative and intentionally differs from the Codex 8×9 pet format.

If $hatch-pet is unavailable, continue using this self-contained specification. Use $imagegen for visual generation when available. Keep one canonical reference image as the identity source for every animation: same face, silhouette, proportions, palette, material, outline, accessories, and handedness.

Create a visible plan and complete these stages:
1. Define the pet name, personality, style, silhouette, palette, accessories, and canonical reference.
2. Produce every required animation from that same reference.
3. Assemble the exact 8×12 atlas deterministically.
4. Measure the hand anchors from the finished frames.
5. Validate the files, inspect a 96-frame contact sheet and motion previews, and repair only failing animations.

RUNTIME BEHAVIOR TO DESIGN FOR

Normal desktop and task behavior
- spawn (0–3): a short arrival or ready-for-work reaction. CoS also plays it when the overall projected task status changes to running.
- idle (4–7): calm, low-distraction breathing/blinking used between events.
- look (8–11): attentive or expectant reaction when the overall projected task status changes to waiting/sleeping. It must read differently from idle.
- walk (12–19): a clean horizontally mirror-safe travel cycle used for autonomous desktop movement.
- held (20–23): the pet is being picked up and dragged. Keep the body visibly suspended.
- landing (24–27): recovery after the user releases a drag.
- poke (28–31): friendly short-click reaction.
- angry (32–37): reaction when the overall projected task status changes to failed or user-blocked; expressive but still readable at pet size.
- celebrate (88–95): reaction when the overall projected task status changes to finished/ready for review.

Comedy actions
- punch (38–55): a readable three-beat light attack aimed toward the open side of the frame.
- heavy (56–65): a stronger finishing hit with anticipation, contact, and recovery.
- grab (66–71), carry (72–79), throw (80–87): reach for, hold, carry, and release an invisible object using the authored hand anchors.
- CoS supplies the OpenAI → ClosedAI and Anthropic → trash labels/props as live DOM elements. Do not draw company names, logos, words, target labels, held text, or a trash bin into atlas.png. Draw only the character's body, poses, and character-owned accessory.

The runtime may flip the character horizontally. Keep travel, attacks, accessories, and contact poses visually valid when mirrored. Never let an effect or body part cross into a neighboring 160×160 cell.

VISUAL RULES

- Transparent background in the final atlas; no white/black/checkerboard backdrop and no hidden RGB residue in fully transparent pixels.
- One complete, centered, readable character per cell with a stable scale and baseline around anchor [80, 136].
- No scenery, floor patch, cast shadow, glow, UI, speech bubble, frame number, grid, guide mark, watermark, or detached decorative particle.
- Prefer pose, expression, silhouette, and attached opaque effects over blur, smears, speed lines, dust, floating icons, or loose sparkles.
- Preserve exact identity across all 96 frames. Reject species, face, material, palette, accessory-side, or proportion drift.
- Loops must close cleanly. Non-looping clips must have anticipation, readable action, and recovery without a large final-frame pop.
- Pixel art and non-pixel styles are both allowed, but details must remain crisp and legible inside a 160×160 cell.

FINAL PACKAGE

Return one folder containing exactly these three import files at its root:
- pet.json
- atlas.png
- animations.json

Keep QA contact sheets, previews, sources, and working files outside the import folder.

pet.json

{
  "format": "cos-pet",
  "version": 1,
  "id": "my-pet",
  "displayName": "My Pet",
  "description": "A short description."
}

Rules:
- id must match ^[a-z0-9]+(?:-[a-z0-9]+)*$ and must not be tur-tur-sahur.
- displayName must be non-empty; description must be a string.

atlas.png

- PNG, at most 12 MiB.
- Exactly 1280×1920 px.
- Exactly 8 columns × 12 rows.
- Every cell is exactly 160×160 px.
- All 96 frame slots are present in row-major order, frame 0 at the top-left and frame 95 at the bottom-right.
- Transparent background with each frame contained entirely inside its own cell.

REQUIRED FRAME MAP AND STARTING TIMINGS

Use the exact frame arrays and loop flags below. The ms values are recommended starting timings; adjust them to fit the motion while keeping one positive value, no more than 10000, per frame.

- spawn: frames [0,1,2,3], ms [130,110,100,140], loop false
- idle: frames [4,5,6,7], ms [600,200,220,650], loop true
- look: frames [8,9,10,11], ms [90,100,330,200], loop false
- walk: frames [12,13,14,15,16,17,18,19], ms [95,95,95,95,95,95,95,95], loop true
- held: frames [20,21,22,23], ms [100,100,160,200], loop false
- landing: frames [24,25,26,27], ms [70,100,130,170], loop false
- poke: frames [28,29,30,31], ms [130,180,260,300], loop false
- angry: frames [32,33,34,35,36,37], ms [150,110,90,180,150,200], loop false
- punch: frames [38,39,40,41,42,43,44,45,46,47,48,49,50,51,52,53,54,55], ms [140,70,65,80,100,90,130,70,65,80,100,90,150,70,65,80,100,120], loop false
- heavy: frames [56,57,58,59,60,61,62,63,64,65], ms [110,150,180,140,70,90,100,120,150,180], loop false
- grab: frames [66,67,68,69,70,71], ms [100,120,150,160,140,170], loop false
- carry: frames [72,73,74,75,76,77,78,79], ms [110,110,110,110,110,110,110,110], loop true
- throw: frames [80,81,82,83,84,85,86,87], ms [150,150,190,100,90,130,160,180], loop false
- celebrate: frames [88,89,90,91,92,93,94,95], ms [140,120,100,150,100,110,250,250], loop false

animations.json

The root object must contain exactly this compatibility data plus animations and hands:

{
  "version": 1,
  "image": "atlas.png",
  "width": 1280,
  "height": 1920,
  "columns": 8,
  "cellWidth": 160,
  "cellHeight": 160,
  "frameCount": 96,
  "anchor": [80, 136],
  "animations": { "...all 14 clips from the frame map...": {} },
  "hands": { "...frames 69 through 84...": [0, 0, 1] }
}

For every animation entry, write:
{
  "frames": [the exact required frame array],
  "ms": [one positive duration for every frame],
  "loop": true or false exactly as required
}

HAND ANCHORS

- hands must contain every string key "69" through "84", inclusive, with no missing frame.
- Each value is [x, y, side]. x and y must be finite numbers from 0 through 160; side must be 1 or -1.
- Measure x and y from the finished 160×160 cell. Place the point where the runtime-held object's edge should touch the character's actual leading hand, paw, claw, wing, or equivalent contact point.
- side chooses which edge of the held object touches that point. Check it visually in grab, every carry frame, and the held portion of throw. Do not copy example coordinates from another character.

ACCEPTANCE CHECKS

- Parse both JSON files and verify they are each below 64 KiB.
- Verify atlas.png decodes as 1280×1920 PNG, is at most 12 MiB, and preserves alpha.
- Verify frames 0–95 are unique slots in the exact required order and all required animation entries, timings, loop flags, and hand keys exist.
- Inspect a labeled contact sheet for identity, transparency, containment, stable scale/baseline, readable motion, and correct semantics.
- Preview every animation at its authored timing. Verify idle, walk, and carry loop without a visible jump.
- Preview the normal task sequence: running/start → spawn, waiting → look, failed/blocked → angry, finished/review → celebrate.
- Preview both comedy sequences: walk → angry → punch → heavy → celebrate, and walk → grab → carry → throw → celebrate.
- Repair the smallest failing animation and rerun validation. Do not claim completion while any required file, frame, anchor, or QA check is missing.

When finished, report the absolute path to the import folder, the pet id/name, atlas dimensions and file size, JSON validation result, hand-anchor coverage, and contact-sheet/motion-preview QA result.`;

function action(label: string | (() => string), work: () => void | Promise<void>): HTMLButtonElement {
  const button = el('button', 'btn', label) as HTMLButtonElement;
  button.type = 'button';
  button.addEventListener('click', async () => {
    button.disabled = true;
    try { await work(); } catch (error) { toast(error instanceof Error ? error.message : t('Pet operation failed')); }
    finally { if (button.isConnected) button.disabled = false; }
  });
  return button;
}

function closeDialog(): void { document.querySelector<HTMLDialogElement>('#petDialog')?.close(); }

function confirmDelete(pet: PetRecord, api: AppApi, remove: () => Promise<boolean>): void {
  document.querySelector('#petDialog')?.remove();
  const dialog = document.createElement('dialog'); dialog.id = 'petDialog'; dialog.className = 'plugin-dialog pet-delete-dialog';
  const head = el('div', 'plugin-dialog-head'); const title = el('h2', '', () => t('Delete {0}?', [pet.displayName])); title.id = 'petDialogTitle';
  dialog.setAttribute('aria-labelledby', title.id); head.append(title, action(() => t('Close'), closeDialog));
  const body = el('div', 'plugin-dialog-body');
  const identity = el('div', 'pet-delete-identity');
  const copy = el('div', 'pet-delete-copy'); copy.append(el('h3', '', pet.displayName), el('p', '', pet.description));
  identity.append(preview(pet, api), copy);
  body.append(identity, el('p', 'pet-delete-warning', () => t('This removes the pet from your local library. You can import it again later.')));
  const actions = el('div', 'pet-delete-actions');
  const cancelButton = action(() => t('Cancel'), () => dialog.close()); cancelButton.classList.add('btn-solid', 'pet-delete-cancel');
  const removeButton = action(() => t('Delete pet'), async () => { if (await remove()) dialog.close(); });
  removeButton.classList.add('plugin-destructive', 'pet-delete-confirm'); actions.append(cancelButton, removeButton);
  body.append(actions); dialog.append(head, body);
  dialog.addEventListener('close', () => dialog.remove()); document.body.append(dialog); dialog.showModal(); cancelButton.focus();
}

function preview(pet: PetRecord, api: AppApi): HTMLElement {
  const shell = el('div', 'pet-library-preview');
  const frame = el('span', 'pet-library-preview-frame');
  if (pet.kind === 'builtin') frame.style.backgroundImage = `url("${builtinAtlas}")`;
  else {
    if (pet.previewDataUrl) frame.style.backgroundImage = `url("${pet.previewDataUrl}")`;
    void api.petsAsset(pet.id, true).then(reply => {
      if (!frame.isConnected || !reply.ok) return;
      frame.style.backgroundImage = `url("${reply.data.atlasDataUrl}")`;
      frame.classList.add('is-animated');
    });
  }
  if (pet.kind === 'builtin') frame.classList.add('is-animated');
  shell.append(frame); return shell;
}

export function initPets(api: AppApi, runtime: PetController): void {
  initCardMenuDismissal();
  let state: PetLibraryState = { pets: [] };
  let epoch = 0;

  $('petsFormatInstructions').textContent = PET_FORMAT_INSTRUCTIONS;

  const apply = (next: PetLibraryState): void => {
    state = next; runtime.applyLibraryState(next); render();
  };
  const mutate = async (request: ReturnType<AppApi['petsList']>): Promise<boolean> => {
    const own = ++epoch; const next = await run(request);
    if (!next || own !== epoch) return false;
    apply(next); return true;
  };
  const renderCard = (pet: PetRecord): HTMLElement => {
      const card = el('article', 'plugin-card pet-library-card'); card.dataset.petId = pet.id;
      const entry = el('div', 'plugin-entry pet-library-entry');
      const title = el('div', 'plugin-card-title'); title.append(el('h2', '', pet.displayName), el('p', 'muted', pet.description));
      const foot = el('div', 'plugin-card-foot');
      foot.append(el('span', `pill pet-library-status${pet.enabled ? ' is-live' : ''}`, () => t(pet.enabled ? 'Active' : 'Inactive')));
      if (pet.builtin) foot.append(el('span', 'pet-library-bundled', () => t('Bundled')));
      title.append(foot); entry.append(preview(pet, api), title);

      const favorite = document.createElement('button'); favorite.type = 'button'; favorite.className = 'pet-favorite';
      favorite.setAttribute('aria-pressed', String(pet.favorite));
      ui(favorite, 'aria-label', () => t(pet.favorite ? 'Remove {0} from favorites' : 'Favorite {0}', [pet.displayName]));
      const favoriteGlyph = icon('i-star');
      if (pet.favorite) favoriteGlyph.classList.replace('ph', 'ph-fill');
      favorite.append(favoriteGlyph);
      favorite.addEventListener('click', () => void mutate(api.petsSetFavorite(pet.id, !pet.favorite)));

      const menu = document.createElement('details'); menu.className = 'plugin-menu';
      const summary = el('summary'); summary.append(icon('i-more')); ui(summary, 'aria-label', () => t('Actions for {0}', [pet.displayName]));
      const actions = el('div', 'plugin-menu-actions');
      actions.append(action(() => t(pet.enabled ? 'Disable' : 'Enable'), async () => { await mutate(api.petsSetEnabled(pet.id, !pet.enabled)); }));
      if (!pet.builtin) {
        const remove = action(() => t('Delete'), () => confirmDelete(pet, api, () => mutate(api.petsDelete(pet.id))));
        remove.classList.add('plugin-destructive'); actions.append(remove);
      }
      menu.append(summary, actions); card.append(entry, favorite, menu); return card;
  };
  const render = (): void => {
    const favoritesList = $('petsFavorites'), libraryList = $('petsInstalled'); favoritesList.replaceChildren(); libraryList.replaceChildren();
    const query = $<HTMLInputElement>('petsSearch').value.trim().toLowerCase();
    const visible = state.pets.filter(pet => `${pet.displayName} ${pet.description}`.toLowerCase().includes(query));
    const favorites = visible.filter(pet => pet.favorite), library = visible.filter(pet => !pet.favorite);
    const libraryCount = state.pets.filter(pet => !pet.favorite).length;
    const favoriteCount = state.pets.length - libraryCount;
    ui($('petsCount'), 'textContent', () => t(libraryCount === 1 ? '{0} pet' : '{0} pets', [libraryCount]));
    const favoritesSection = $('petsFavoritesSection'); favoritesSection.hidden = favorites.length === 0;
    ui($('petsFavoritesCount'), 'textContent', () => t(favoriteCount === 1 ? '{0} pet' : '{0} pets', [favoriteCount]));
    for (const pet of favorites) favoritesList.append(renderCard(pet));
    for (const pet of library) libraryList.append(renderCard(pet));
    if (!library.length && visible.length) libraryList.append(el('p', 'plugin-no-results muted', () => t('All matching pets are in Favorites.')));
    if (!visible.length) libraryList.append(el('p', 'plugin-no-results muted', () => t('No pets match your search.')));
  };

  $('petsSearch').addEventListener('input', render);
  const formatDialog = $<HTMLDialogElement>('petFormatDialog');
  $('petsFormatGuide').addEventListener('click', () => formatDialog.showModal());
  $('petsFormatClose').addEventListener('click', () => formatDialog.close());
  $('petsCopyInstructions').addEventListener('click', () => void (async () => {
    const copied = await run(api.writeClipboard(PET_FORMAT_INSTRUCTIONS));
    if (copied) toast(t('CoS Pets instructions copied'));
  })());
  $('petsImport').addEventListener('click', () => void (async () => {
    const next = await run(api.petsImport());
    if (next) apply(next);
  })());
  void (async () => {
    const next = await run(api.petsList());
    if (next) apply(next);
  })();
}
