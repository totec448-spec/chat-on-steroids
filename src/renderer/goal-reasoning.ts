import { goalModelEfforts, type GoalModel } from '../shared/goal-reasoning.js';
import type { GoalReasoning } from '../shared/types.js';
import { t, ui } from './i18n.js';

const labels: Record<GoalReasoning, string> = {
  default: 'Default', none: 'None', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max'
};

/** A saved unsupported value remains visible, never silently changed by a state push. */
export function renderGoalReasoning(select: HTMLSelectElement, model: GoalModel | undefined, custom: boolean,
  selected: GoalReasoning, changingModel = false): void {
  const values: GoalReasoning[] = ['default', ...goalModelEfforts(model, custom)];
  const unsupported = !values.includes(selected);
  if (unsupported && changingModel) selected = 'default';
  else if (unsupported) values.push(selected);
  const definitions = values.map(value => ({ value, disabled: value !== 'default' && !goalModelEfforts(model, custom).includes(value) }));
  // Do not replace the native popup during unrelated status pushes or while the user picks.
  if (JSON.stringify([...select.options].map(option => ({ value: option.value, disabled: option.disabled }))) !== JSON.stringify(definitions)) {
    select.replaceChildren(...definitions.map(({ value, disabled }) => {
      const option = document.createElement('option');
      option.value = value;
      option.disabled = disabled;
      return option;
    }));
  }
  for (const option of select.options) {
    const value = option.value as GoalReasoning;
    ui(option, 'textContent', () => option.disabled ? t('{0} (saved; unavailable)', [t(labels[value])])
      : value === 'default' && model?.reasoning?.defaultEffort ? t('Default ({0})', [t(labels[model.reasoning.defaultEffort])]) : t(labels[value]));
  }
  select.value = selected;
}
