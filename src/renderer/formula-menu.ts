/**
 * A right click on a drawn formula opens Copy LaTeX and Copy MathML. Selecting a formula and
 * copying gives KaTeX's drawing as text, which is neither the source nor something an editor can
 * read back. Both come from what KaTeX already drew (`output: 'htmlAndMathml'`): the MathML, and
 * the source it keeps in that MathML's TeX annotation. A formula shown as its source has neither,
 * and is copied like any text.
 */
import { run, toast } from './dom.js';
import { t } from './i18n.js';
import { openRowMenu } from './row-menu.js';

/** The source and MathML of the drawn formula an event happened in, if any. */
export function formulaAt(target: EventTarget | null): { tex: string; mathml: string } | null {
  const holder = target instanceof Element ? target.closest('.math-inline, .math-display') : null;
  const math = holder?.querySelector('.katex-mathml math');
  const tex = math?.querySelector('annotation[encoding="application/x-tex"]')?.textContent;
  return math && tex ? { tex, mathml: math.outerHTML } : null;
}

/** Gives every drawn formula inside `root` its menu, however often the content is drawn again. */
export function installFormulaMenu(root: HTMLElement): void {
  root.addEventListener('contextmenu', event => {
    const formula = formulaAt(event.target);
    if (!formula) return;
    event.preventDefault();
    const copy = (text: string) => async () => {
      if (await run(window.api.writeClipboard(text))) toast(t('Copied'));
    };
    openRowMenu({
      owner: 'formula', at: { x: event.clientX, y: event.clientY }, anchor: () => null, label: () => t('Formula'),
      items: () => [
        { action: 'copy-latex', icon: 'i-copy', label: () => t('Copy LaTeX'), run: copy(formula.tex) },
        { action: 'copy-mathml', icon: 'i-copy', label: () => t('Copy MathML'), run: copy(formula.mathml) }
      ]
    });
  });
}
