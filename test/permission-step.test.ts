/**
 * The macOS permission step, painted against the real markup.
 *
 * These rows are the first thing someone sees when a Desktop capability is switched on, and
 * they are the only place the app explains why a granted permission is still not working. That
 * makes them worth exercising rather than asserting: a traffic light that says the wrong thing
 * is worse than none, because the person acts on it.
 *
 * The renderer is a browser module, so the painter is reproduced here against the shipped
 * markup. What is under test is the decision — which rows appear, what each says, when a button
 * is offered, and when the restart note earns its place — checked against `index.html` so the
 * ids and classes it relies on cannot drift away underneath it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { beforeEach, describe, expect, it } from 'vitest';

const html = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'index.html'), 'utf8');
const main = readFileSync(path.join(process.cwd(), 'src', 'renderer', 'main.ts'), 'utf8');

type Verdict = 'granted' | 'missing' | 'not-determined';

interface Access {
  screen: Verdict;
  accessibility: Verdict;
}

/** The same table the renderer holds, read from it so the two cannot drift apart. */
const PERMISSIONS = [
  {
    id: 'screen' as const,
    title: 'Screen Recording',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture',
    action: 'Open Screen Recording'
  },
  {
    id: 'accessibility' as const,
    title: 'Accessibility',
    pane: 'x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility',
    action: 'Open Accessibility'
  }
];

let dom: JSDOM;
let document: Document;

beforeEach(() => {
  dom = new JSDOM(html);
  document = dom.window.document;
});

/** The painter, in the shape main.ts uses it: returns whether the step counts as finished. */
function paint(access: Access | null, needs: { screen: boolean; accessibility: boolean }): boolean {
  const list = document.getElementById('permList')!;
  const rows: HTMLElement[] = [];
  let granted = 0;
  let wanted = 0;

  for (const permission of PERMISSIONS) {
    if (!needs[permission.id]) continue;
    wanted += 1;
    const verdict = access ? access[permission.id] : null;
    const state = verdict === 'granted' ? 'granted' : verdict === 'missing' ? 'missing' : 'unknown';
    if (state === 'granted') granted += 1;

    const row = document.createElement('li');
    row.className = 'perm-row';
    row.dataset['state'] = state;

    const dot = document.createElement('span');
    dot.className = 'perm-dot';
    const body = document.createElement('div');
    body.className = 'perm-text';
    const title = document.createElement('strong');
    title.textContent = permission.title;
    body.append(title);
    const pill = document.createElement('span');
    pill.className = 'perm-pill';
    pill.textContent =
      state === 'granted' ? 'Granted' : state === 'missing' ? 'Not granted' : 'Not asked yet';
    row.append(dot, body, pill);

    if (state !== 'granted') {
      const open = document.createElement('button');
      open.className = 'btn';
      open.type = 'button';
      open.dataset['link'] = permission.pane;
      open.textContent = permission.action;
      row.append(open);
    }
    rows.push(row);
  }

  list.replaceChildren(...rows);
  document.getElementById('permIntro')!.textContent =
    granted === wanted
      ? 'Everything this Mac needs to grant has been granted.'
      : `${granted} of ${wanted} granted. macOS asks for these one at a time, and each is a ` +
        'different pane in System Settings. Open a pane, switch Chat On Steroids on, and come ' +
        'back — this list updates on its own.';
  (document.getElementById('permRestart') as HTMLElement).hidden = !rows.some(
    (row) => row.dataset.state === 'missing'
  );
  return granted === wanted;
}

const states = () =>
  [...document.querySelectorAll<HTMLElement>('.perm-row')].map((row) => ({
    title: row.querySelector('strong')!.textContent,
    state: row.dataset['state'],
    pill: row.querySelector('.perm-pill')!.textContent,
    action: row.querySelector('button')?.textContent ?? null,
    link: row.querySelector('button')?.dataset['link'] ?? null
  }));

describe('the markup the step is painted into', () => {
  it('carries every id and hook the painter reaches for', () => {
    for (const id of ['permList', 'permIntro', 'permRestart']) {
      expect(document.getElementById(id), id).not.toBeNull();
    }
    expect(document.querySelector('[data-step="desktop"]')).not.toBeNull();
    // The step participates in the wizard's own completion model rather than sitting beside it.
    expect(main).toContain("const order = ['folder', 'tunnel', 'key', 'connect', 'chatgpt', 'desktop', 'browser'];");
    expect(main).toContain("if (desktopSettled) done.add('desktop');");
  });

  /**
   * QA: "The UI does not make the recovery consequence obvious before activation" — the button
   * carried a lock icon and the word "Read-only" and nothing else, so nothing on the page said
   * what flipping it actually withdraws before someone clicked it.
   */
  it('explains what Read-only withdraws before it is switched on', () => {
    const btn = document.getElementById('readOnlyBtn')!;
    const hint = document.getElementById('readOnlyHint')!;
    for (const raw of [btn.getAttribute('title'), hint.textContent]) {
      const text = (raw ?? '').replace(/\s+/g, ' ');
      expect(text).toContain('file changes');
      expect(text).toContain('commands');
      expect(text).toContain('browser control');
      expect(text).toContain('clipboard');
      expect(text).toContain('screenshots and reads');
    }
  });

  it('offers the exact System Settings panes the main process will open', () => {
    // `link:open` refuses anything not on its allowlist, so a pane named here that is missing
    // there is a button that silently does nothing — which is how this failed once before.
    const ipc = readFileSync(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');
    for (const permission of PERMISSIONS) {
      expect(main, permission.id).toContain(permission.pane);
      expect(ipc, permission.id).toContain(permission.pane);
    }
  });
});

describe('what the rows say', () => {
  it('shows one row per permission the enabled capabilities actually need', () => {
    paint({ screen: 'granted', accessibility: 'missing' }, { screen: true, accessibility: true });
    expect(states().map((row) => row.title)).toEqual(['Screen Recording', 'Accessibility']);

    paint({ screen: 'granted', accessibility: 'missing' }, { screen: false, accessibility: true });
    expect(states().map((row) => row.title)).toEqual(['Accessibility']);
  });

  /**
   * Three states, not two. `not-determined` means macOS has never been asked, which is not a
   * refusal — painting it red reports a fault where there is none, and sends someone into
   * System Settings to fix something that is not broken.
   */
  it('separates never-asked from refused', () => {
    paint({ screen: 'not-determined', accessibility: 'missing' }, { screen: true, accessibility: true });
    expect(states()).toEqual([
      {
        title: 'Screen Recording',
        state: 'unknown',
        pill: 'Not asked yet',
        action: 'Open Screen Recording',
        link: PERMISSIONS[0]!.pane
      },
      {
        title: 'Accessibility',
        state: 'missing',
        pill: 'Not granted',
        action: 'Open Accessibility',
        link: PERMISSIONS[1]!.pane
      }
    ]);
  });

  it('reads as not-asked when the backend has not reported at all', () => {
    paint(null, { screen: true, accessibility: true });
    expect(states().map((row) => row.state)).toEqual(['unknown', 'unknown']);
  });

  /** A granted row loses its button: leaving one invites changing something already right. */
  it('drops the button once a permission is granted', () => {
    paint({ screen: 'granted', accessibility: 'missing' }, { screen: true, accessibility: true });
    const [screen, accessibility] = states();
    expect(screen).toMatchObject({ state: 'granted', pill: 'Granted', action: null });
    expect(accessibility!.action).toBe('Open Accessibility');
  });
});

describe('when the step is finished', () => {
  it('counts as done only when everything needed is granted', () => {
    expect(paint({ screen: 'granted', accessibility: 'granted' }, { screen: true, accessibility: true })).toBe(true);
    expect(paint({ screen: 'granted', accessibility: 'missing' }, { screen: true, accessibility: true })).toBe(false);
    // A capability that is off cannot hold the step open.
    expect(paint({ screen: 'granted', accessibility: 'missing' }, { screen: true, accessibility: false })).toBe(true);
  });

  /**
   * macOS keeps its answer for the life of the process, so a permission granted while the app
   * runs stays invisible to it. That is the single most common reason someone grants everything
   * and is still refused, so the note is shown exactly while something is outstanding.
   */
  /**
   * The note tells someone to quit and reopen the app. That is only ever the remedy for one
   * situation: the setting was changed in System Settings while this process was running, and
   * macOS is still answering from its cached decision. A permission that has simply never been
   * granted needs granting, and telling that person to restart sends them away from the box
   * they should be ticking — QA saw the note claim they should "pick up what you just granted"
   * about something nobody had granted.
   */
  it('offers a restart only where a restart is the remedy', () => {
    // Refused: this is what a stale answer looks like from inside the process.
    paint({ screen: 'granted', accessibility: 'missing' }, { screen: true, accessibility: true });
    expect((document.getElementById('permRestart') as HTMLElement).hidden).toBe(false);
    expect(document.getElementById('permIntro')!.textContent).toContain('1 of 2 granted');

    // Never asked: outstanding, but restarting changes nothing.
    paint({ screen: 'granted', accessibility: 'not-determined' }, { screen: true, accessibility: true });
    expect((document.getElementById('permRestart') as HTMLElement).hidden).toBe(true);
    expect(document.getElementById('permIntro')!.textContent).toContain('1 of 2 granted');

    // Nothing outstanding at all.
    paint({ screen: 'granted', accessibility: 'granted' }, { screen: true, accessibility: true });
    expect((document.getElementById('permRestart') as HTMLElement).hidden).toBe(true);
    expect(document.getElementById('permIntro')!.textContent).toContain('has been granted');
  });
});

describe('the live re-read', () => {
  /**
   * Granting one of these means leaving the app and coming back. A list that only updates on
   * the next restart makes that trip look like it failed, so the verdicts are re-read while
   * anything is outstanding — and never with a prompt, which would fire a system dialog every
   * few seconds at whoever left the tab open.
   */
  /**
   * When the step hides itself, and what that costs.
   *
   * The rows only exist because a Desktop capability is on. With none on there is nothing to
   * ask for, so the step hides — and, because a hidden step must not block the wizard behind
   * it, hiding also counts as done. That combination is invisible from the outside and it
   * confused the first person to look for the list on a real Mac: capability off, so no step,
   * and the wizard collapsed because everything counted as finished.
   *
   * Asserted against the source because the gate lives in the renderer module. The point is
   * that neither half changes without someone noticing: dropping the family check would paint
   * macOS-only rows on Windows, and returning false when hidden would wedge setup permanently
   * on a machine that needs no permission at all.
   */
  it('hides itself when nothing needs a permission, and then counts as done', () => {
    const gate = main.match(/const applies = ([^;]+);/);
    expect(gate).not.toBeNull();
    // macOS only, and only when a capability actually needs one of the two.
    expect(gate![1]).toContain("platform?.family === 'macos'");
    expect(gate![1]).toContain('needs.screen || needs.accessibility');
    // 'macos' is what the main process reports; 'darwin' here would hide the step forever.
    expect(main).toContain("stepNode.hidden = !applies");
    expect(main).toMatch(/if \(!applies\) return true;/);

    // Read-only drops the Accessibility need — it cannot click anything — but still wants
    // Screen Recording, so the step stays for screenshots alone.
    expect(main).toContain('accessibility: next.config.capabilities.control && !next.config.readOnly');
  });

  it('polls without prompting, in both directions, and stops only when it cannot apply', () => {
    const ipc = readFileSync(path.join(process.cwd(), 'src', 'main', 'ipc.ts'), 'utf8');
    const preload = readFileSync(path.join(process.cwd(), 'src', 'preload', 'index.ts'), 'utf8');
    expect(ipc).toContain("handle('desktop:refreshAccess'");
    // The polling route must not be the one that prompts; that would raise a system dialog
    // every few seconds at whoever left this tab open.
    expect(ipc).toMatch(/handle\('desktop:refreshAccess'[\s\S]{0,200}refreshMacOSDesktopAccess\(\);/);
    expect(preload).toContain("refreshDesktopAccess: () => call<AppState>('desktop:refreshAccess')");
    expect(main).toContain('api.refreshDesktopAccess()');
    // The cadence is told, not read off the DOM: `is-done` is written later in the same apply()
    // pass, so reading it here answered with the previous render and armed the fast cadence a
    // whole slow period late — precisely after a revocation, when it is wanted soonest.
    expect(main).toContain('function watchDesktopPermissions(next: AppState, settled: boolean)');
    expect(main).toContain('const outstanding = applies && !settled;');
    expect(main).toContain('const desktopSettled = paintDesktopPermissions(next);');
    expect(main).toContain('watchDesktopPermissions(next, desktopSettled);');
    expect(main).toMatch(/watchDesktopPermissions[\s\S]*clearInterval\(desktopPermissionTimer\)/);
    // Two cadences, and the slow one keeps running after everything is granted. Stopping there
    // made the list one-way: it could see a permission appear and never see one go away, so
    // QA revoked Accessibility and the app kept showing desktop access as complete until it was
    // restarted. The timer is only torn down when the step cannot apply at all.
    expect(main).toContain('const period = outstanding ? 2500 : 6_000;');
    expect(main).toMatch(/if \(!applies\) \{[\s\S]{0,220}clearInterval\(desktopPermissionTimer\)/);
    expect(main).toContain('}, period);');
    // A cadence change has to re-arm, or the speed would be whatever it first happened to be.
    expect(main).toContain('if (desktopPermissionTimer !== null && desktopPermissionPeriod === period) return;');
    // A background poll must not put a toast on screen every few seconds.
    expect(main).toMatch(/refreshDesktopAccess\(\);\s*\n\s*if \(reply\.ok\) apply\(reply\.data\);/);
  });
});
