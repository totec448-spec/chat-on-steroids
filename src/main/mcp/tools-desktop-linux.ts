/** Strictly semantic, opt-in Linux AT-SPI tools. Never run a physical-input fallback. */
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getConfig, effectiveCapabilities } from '../config.js';
import { isBrowserProcess } from '../computer/browser-chords.js';
import { checkLinuxDesktopVersion, runLinuxDesktop, type LinuxDesktopEnvelope } from '../computer/linux-agent-desktop.js';
import { LINUX_DESKTOP_REF_PATTERN, MAX_LINUX_DESKTOP_REF_LENGTH, validLinuxDesktopRef } from '../computer/linux-desktop-ref.js';
import { parseLinuxScreenshot, LinuxScreenshotError } from '../computer/linux-screenshot.js';
import { MAX_VIEW_IMAGE_BYTES, validateImageBytes } from '../codex/view-image.js';
import sharp from 'sharp';
import { askBeforeDesktopStep, desktopStepEnded } from '../desktop-ask-window.js';
import { currentCaller } from './call-context.js';
import { requestCorrelation } from '../session/correlation.js';
import { fail, type SurfaceRegistrar, type ToolResult } from './kernel.js';
import { toolDeclaration } from './tool-declarations.js';
import { logInfo } from '../logger.js';

interface WindowRow { id: string; app_name: string; pid: number; process_instance: string }
interface Observation { window: WindowRow; session: string; refs: Set<string>; observedAt: number }
const observations = new Map<string, Observation>();
const MAX_OWNERS = 32;
const MAX_JSON = 900_000;
/** A ref is not evidence that the same UI still exists indefinitely. */
const MAX_REF_AGE_MS = 120_000;
// An error `code` comes from the native backend too; length limiting alone
// cannot prevent it from carrying private application/window text. Forward
// only exact stable codes whose meaning is known, never arbitrary strings.
const SAFE_BACKEND_ERRORS = new Set(['DENIED', 'PERM_DENIED', 'STALE_REF']);

function provenPrincipal(): { key: string; sessionId: string | null; conversationId: string | null } | null {
  const caller = currentCaller();
  const correlated = caller.requestId ? requestCorrelation(caller.requestId) : null;
  // A bound request cannot borrow the snapshot of a different proven chat.
  if (correlated?.conversationId && caller.conversationId && correlated.conversationId !== caller.conversationId) return null;
  if (correlated?.sessionId && caller.sessionId && correlated.sessionId !== caller.sessionId) return null;
  const session = caller.sessionId ?? correlated?.sessionId ?? null;
  const conversation = caller.conversationId ?? correlated?.conversationId ?? null;
  if (!session && !conversation) return null;
  // A session may later rebind to a different ChatGPT conversation, and an
  // app can have multiple Setup profiles. Neither transition may inherit a
  // previous chat's accessibility refs or the backend snapshot namespace.
  return { key: JSON.stringify([caller.setupProfileId ?? null, session, conversation]), sessionId: session, conversationId: conversation };
}
function principal(): string | null { return provenPrincipal()?.key ?? null; }
function sessionFor(principal: string): string {
  return `cos-${createHash('sha256').update(principal).digest('hex').slice(0, 40)}`;
}
function refusal(control: boolean): ToolResult | null {
  const config = getConfig();
  if (config.ui.linuxDesktopEnabled !== true) return fail('LINUX_DESKTOP_DISABLED: Enable native Linux Desktop access in Settings. Browser permissions alone cannot enable it.');
  if (control && config.readOnly) return fail('TOOL_DISABLED: Read-only mode forbids native Linux input.');
  if (!effectiveCapabilities(config)[control ? 'control' : 'screen']) return fail(`TOOL_DISABLED: Live ${control ? 'control' : 'screen'} permission is required for native Linux Desktop.`);
  return null;
}
function freshObservation(observation: Observation): boolean {
  const age = Date.now() - observation.observedAt;
  return age >= 0 && age <= MAX_REF_AGE_MS;
}
function successful(envelope: LinuxDesktopEnvelope): ToolResult {
  if (!envelope.ok) {
    // The backend's error message may include an application title or sensitive
    // accessibility text. Emit a stable bounded code only, not its raw payload.
    const code = (envelope.error as { code?: unknown } | null)?.code;
    return fail('LINUX_DESKTOP_BACKEND: ' + (typeof code === 'string' && SAFE_BACKEND_ERRORS.has(code) ? code : 'UNKNOWN'));
  }
  const data = envelope.data ?? null;
  const json = JSON.stringify(data);
  if (json.length > MAX_JSON) return fail('DESKTOP_RESULT_TOO_LARGE: use a smaller or more specific window snapshot.');
  return { content: [{ type: 'text', text: json }], structuredContent: { value: data } };
}
function windowRows(data: unknown): WindowRow[] {
  if (!Array.isArray(data)) return [];
  return data.filter((row): row is WindowRow => !!row && typeof row.id === 'string' && typeof row.app_name === 'string' &&
    Number.isInteger(row.pid) && typeof row.process_instance === 'string');
}
function safeWindow(row: WindowRow): boolean {
  // Unknown application ownership cannot be assumed safe just because a title looks harmless.
  // Linux may report reverse-DNS application IDs (org.mozilla.firefox) rather than
  // executable names; treating dots as ordinary letters would permit browser refs.
  const appId = row.app_name.replace(/[./\\]/g, ' ');
  // Never let a chat inspect or control CoS itself: it could read other chats
  // or click the app's own Desktop Ask / Settings controls to grant permission.
  // Other running CoS copies have different PIDs, so also reject the packaged
  // desktop ID and the app's common executable/display-name variants.
  const normalizedAppId = row.app_name.toLowerCase().replace(/[^a-z0-9]/g, '');
  const isOwnApp = normalizedAppId === 'chatonsteroids' ||
    normalizedAppId === 'comchatonsteroidsapp' ||
    normalizedAppId === 'comchatonsteroidsappdesktop';
  return row.id.length > 0 && row.app_name.length > 0 && row.process_instance.length > 0 && row.pid > 0 &&
    row.pid !== process.pid && !isOwnApp &&
    !isBrowserProcess(appId) && !/(^|[\s_-])(epiphany|qutebrowser|librewolf|waterfox|torbrowser|falkon|midori)([\s_-]|$)/i.test(appId);
}
async function inventory(): Promise<WindowRow[] | ToolResult> {
  const response = await runLinuxDesktop({ kind: 'windows' });
  if (!response.ok) return successful(response);
  if (!Array.isArray(response.data)) return fail('DESKTOP_BACKEND_INVALID: window inventory is missing.');
  return windowRows(response.data);
}
function identityStillMatches(earlier: WindowRow, current: WindowRow[]): boolean {
  const matched = current.filter(w => w.id === earlier.id);
  return matched.length === 1 && safeWindow(matched[0]!) && matched[0]!.app_name === earlier.app_name &&
    matched[0]!.pid === earlier.pid && matched[0]!.process_instance === earlier.process_instance;
}
function collectRefs(tree: unknown, snapshot: string): Set<string> | null {
  const refs = new Set<string>();
  let complete = true;
  const walk = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || !complete) return;
    if (depth > 24) { complete = false; return; }
    const entry = node as { ref_id?: unknown; children?: unknown };
    if (typeof entry.ref_id === 'string') {
      if (!validLinuxDesktopRef(entry.ref_id) || !entry.ref_id.startsWith(`@${snapshot}:`)) { complete = false; return; }
      refs.add(entry.ref_id);
      if (refs.size > 512) { complete = false; return; }
    }
    if (Array.isArray(entry.children)) {
      if (entry.children.length > 200) { complete = false; return; }
      for (const child of entry.children) walk(child, depth + 1);
    }
  };
  if (!tree || typeof tree !== 'object') return null;
  walk(tree, 0);
  return complete ? refs : null;
}

const observeSchema = z.discriminatedUnion('what', [
  z.object({ what: z.literal('windows') }).strict(),
  z.object({ what: z.literal('apps') }).strict(),
  z.object({ what: z.literal('displays') }).strict(),
  z.object({ what: z.literal('snapshot'), window_id: z.string().min(1).max(128) }).strict(),
  z.object({ what: z.literal('screenshot'), display: z.literal(0).default(0) }).strict()
]);
const actSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('click'), ref: z.string().max(MAX_LINUX_DESKTOP_REF_LENGTH).regex(LINUX_DESKTOP_REF_PATTERN) }).strict(),
  z.object({ action: z.literal('set_value'), ref: z.string().max(MAX_LINUX_DESKTOP_REF_LENGTH).regex(LINUX_DESKTOP_REF_PATTERN), value: z.string().max(4000) }).strict()
]);

export function registerLinuxDesktopTools(reg: SurfaceRegistrar): void {
  if (process.platform !== 'linux' || !(reg.ctx.exposedLinuxDesktop ?? getConfig().ui.linuxDesktopEnabled)) return;
  if (reg.exposedCaps.screen) reg.register('linux_observe', toolDeclaration('linux_observe', () => ({
    description: 'Native Linux AT-SPI observation: list running apps, windows or displays, read the accessibility tree of an exact window, or capture a DISPLAY screenshot through the Wayland portal (not a window screenshot). Requires the separate Linux Desktop opt-in and live screen permission. Observations without proven chat identity require explicit Allow unattributed desktop calls; their refs cannot be acted on.',
    inputSchema: observeSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true }
  }), 'linux'), async input => reg.guarded('screen', 'linux_observe', async () => {
    const denied = refusal(false); if (denied) return denied;
    if (input.what === 'screenshot' && input.display !== 0)
      return fail('LINUX_SCREENSHOT_DISPLAY_UNSUPPORTED: only display 0 is available.');
    await checkLinuxDesktopVersion();
    const again = refusal(false); if (again) return again;
    if (input.what === 'windows' || input.what === 'displays' || input.what === 'apps') {
      const value = await runLinuxDesktop({ kind: input.what });
      const revoked = refusal(false); if (revoked) return revoked;
      if (!value.ok) return successful(value);
      const rows = input.what === 'apps' && value.data && typeof value.data === 'object'
        ? (value.data as { apps?: unknown }).apps : value.data;
      if (!Array.isArray(rows)) return fail('DESKTOP_BACKEND_INVALID: expected inventory array.');
      return successful({ ...value, data: { items: rows.slice(0, 80), total: rows.length, truncated: rows.length > 80 } });
    }
    if (input.what === 'screenshot') {
      const value = await runLinuxDesktop({ kind: 'screenshot', display: input.display });
      // A person can revoke screen access while the portal prompt waits. A
      // successful portal capture is not permission to publish after revocation.
      const revoked = refusal(false); if (revoked) return revoked;
      if (!value.ok) return successful(value);
      try {
        const screenshot = await parseLinuxScreenshot(value);
        let png = screenshot.png;
        let resized = false;
        // The Desktop connector has the same 8 MiB *wire* budget as view_image,
        // not the backend's 8 MiB raw capture limit. On a large display shrink
        // the already-authorized PNG in memory; never repeat the portal request.
        if (png.length > MAX_VIEW_IMAGE_BYTES) {
          resized = true;
          for (const width of [2560, 1920, 1280]) {
            png = await sharp(screenshot.png)
              .resize({ width, withoutEnlargement: true })
              .png({ compressionLevel: 9 }).toBuffer();
            if (png.length <= MAX_VIEW_IMAGE_BYTES) break;
          }
        }
        if (png.length > MAX_VIEW_IMAGE_BYTES) return fail('DESKTOP_IMAGE_TOO_LARGE: display PNG does not fit the bounded MCP image transport.');
        if (await validateImageBytes(png) !== 'image/png') return fail('DESKTOP_IMAGE_INVALID: expected PNG pixels.');
        const metadata = await sharp(png).metadata();
        const revokedAfterProcessing = refusal(false); if (revokedAfterProcessing) return revokedAfterProcessing;
        const dimensions = { scope: 'display', display: input.display, mimeType: 'image/png',
          width: metadata.width, height: metadata.height, sourceWidth: screenshot.width,
          sourceHeight: screenshot.height, resized };
        return { content: [{ type: 'text', text: JSON.stringify(dimensions) },
          { type: 'image', mimeType: 'image/png', data: resized ? png.toString('base64') : screenshot.base64 }],
          structuredContent: { value: dimensions } };
      } catch (error) {
        return fail(`DESKTOP_IMAGE_INVALID: ${error instanceof LinuxScreenshotError ? error.code : 'PNG_PROCESSING_FAILED'}; no image was emitted.`);
      }
    }
    const windows = await inventory(); if (!Array.isArray(windows)) return windows;
    // The inventory subprocess may outlive a Screen-permission grant. Refuse
    // before starting an accessibility-tree read, not just before publishing it.
    const revokedBeforeSnapshot = refusal(false);
    if (revokedBeforeSnapshot) {
      logInfo('linux desktop snapshot: refused because Screen permission changed during window inventory');
      return revokedBeforeSnapshot;
    }
    const matches = windows.filter(row => row.id === input.window_id);
    if (matches.length !== 1 || !safeWindow(matches[0]!)) return fail('DESKTOP_TARGET_UNPROVEN: browser, missing or ambiguous windows cannot be targeted with native Linux tools.');
    const owner = principal();
    // Unowned observations get a single-use private namespace; no shared anonymous
    // snapshot store and no route from these refs into linux_act.
    const session = sessionFor(owner ?? `unattributed-observation:${randomUUID()}`);
    const result = await runLinuxDesktop({ kind: 'snapshot', windowId: input.window_id, session });
    const revoked = refusal(false); if (revoked) return revoked;
    // A request can acquire or lose exact attribution while the backend is
    // reading the tree. Do not issue reusable refs under its previous owner.
    if (owner !== principal()) return fail('DESKTOP_IDENTITY_CHANGED: chat ownership changed during the Linux snapshot; observe again.');
    if (!result.ok) return successful(result);
    const data = result.data as { snapshot_id?: unknown; complete?: unknown; window?: { id?: unknown }; tree?: unknown } | null;
    const refs = typeof data?.snapshot_id === 'string' ? collectRefs(data.tree, data.snapshot_id) : null;
    if (data?.window?.id !== input.window_id || data?.complete !== true || refs === null) {
      // Never log backend refs, UI labels or app/window names; rejected trees
      // may contain private data. Nothing from this snapshot is published.
      logInfo('linux desktop snapshot: rejected incomplete, mismatched or invalid accessibility refs');
      return fail('DESKTOP_SNAPSHOT_UNPROVEN: incomplete or mismatched accessibility snapshot; no refs issued.');
    }
    if (owner) {
      observations.delete(owner);
      observations.set(owner, { window: matches[0]!, session, refs, observedAt: Date.now() });
      while (observations.size > MAX_OWNERS) observations.delete(observations.keys().next().value!);
    }
    return successful(result);
  }));
  if (reg.exposedCaps.control) reg.register('linux_act', toolDeclaration('linux_act', () => ({
    description: 'Act on a fresh, provably owned Linux AT-SPI accessibility ref, click or set_value only. Ref actions ALWAYS require proven chat/session identity even with Allow unattributed desktop calls. Browser windows, stale/foreign refs and unclear target ownership are rejected; no pointer or keyboard fallback. Reobserve after an action. Requires separate Linux opt-in, live control permission and Read-only off.',
    inputSchema: actSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true }
  }), 'linux'), async input => reg.guarded('control', 'linux_act', async () => {
    const denied = refusal(true); if (denied) return denied;
    const attributed = provenPrincipal();
    if (!attributed) return fail('DESKTOP_IDENTITY_REQUIRED: native Linux ref actions require a proven chat or session; no action ran.');
    const owner = attributed.key;
    const observed = observations.get(owner);
    if (!observed || !observed.refs.has(input.ref)) return fail('STALE_OR_FOREIGN_REF: observe this window again in the same chat; no action ran.');
    if (!freshObservation(observed)) {
      observations.delete(owner);
      return fail('STALE_OR_FOREIGN_REF: this Linux accessibility snapshot expired; observe the window again; no action ran.');
    }
    await checkLinuxDesktopVersion();
    const asked = await askBeforeDesktopStep(input.action === 'click' ? 'click' : 'type', observed.window.app_name, {
      sessionId: attributed.sessionId, conversationId: attributed.conversationId, scopedPrincipal: owner
    });
    if (asked) return fail(asked);
    // Recheck live authority AND the exact window's process incarnation AFTER all waits.
    // A failed pre-input check did not touch the desktop and must not be counted
    // as app-generated pointer/keyboard input by the confirmation gate.
    let attemptedInput = false;
    try {
      const current = await inventory(); if (!Array.isArray(current)) return current;
      const freshOwner = principal();
      if (freshOwner !== owner || observations.get(owner) !== observed || !freshObservation(observed) ||
          !identityStillMatches(observed.window, current) || !observed.refs.has(input.ref))
        return fail('DESKTOP_TARGET_UNPROVEN: owner, ref or target changed while waiting; no action ran.');
      const revoked = refusal(true); if (revoked) return revoked;
      observations.delete(owner); // Every action consumes its refs, including unknown delivery.
      attemptedInput = true;
      const value = input.action === 'click'
        ? await runLinuxDesktop({ kind: 'click', ref: input.ref, session: observed.session })
        : await runLinuxDesktop({ kind: 'setValue', ref: input.ref, session: observed.session, value: input.value });
      return successful(value);
    } finally { if (attemptedInput) desktopStepEnded(); }
  }));
}
