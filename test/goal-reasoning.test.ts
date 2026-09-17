import { afterEach, describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { goalModelEfforts, parseGoalModelReasoning, type GoalModel } from '../src/shared/goal-reasoning.js';
import { renderGoalReasoning } from '../src/renderer/goal-reasoning.js';

const glm: GoalModel = { id: 'z-ai/glm-5.3', name: 'GLM 5.3', created: 0, contextLength: 200000,
  reasoning: parseGoalModelReasoning({ supported_efforts: ['max', 'high', 'low'], default_effort: 'max', mandatory: true }) };
let dom: JSDOM | undefined;
afterEach(() => { dom?.window.close(); dom = undefined; });

describe('catalogue-owned Goal reasoning', () => {
  it('keeps model-specific efforts and does not infer support from a GLM name', () => {
    expect(goalModelEfforts(glm)).toEqual(['max', 'high', 'low']);
    expect(goalModelEfforts({ ...glm, reasoning: undefined })).toEqual([]);
    expect(goalModelEfforts({ ...glm, reasoning: parseGoalModelReasoning({}) })).toEqual([]);
    expect(goalModelEfforts({ ...glm, reasoning: parseGoalModelReasoning({ supported_efforts: null, mandatory: true }) }))
      .toEqual(['max', 'xhigh', 'high', 'medium', 'low', 'minimal']);
  });
  it('bounds untrusted catalogue metadata and removes unsupported or duplicate efforts', () => {
    expect(parseGoalModelReasoning({ supported_efforts: ['high', 'invalid', 'high', {}, 'default', 'none'], default_effort: 'invalid' }))
      .toEqual({ mandatory: false, supportedEfforts: ['high', 'none'] });
    expect(parseGoalModelReasoning('high')).toBeUndefined();
    expect(parseGoalModelReasoning({ supported_efforts: Array(10000).fill('high') })?.supportedEfforts).toEqual(['high']);
  });
  it('offers clickable GLM High and Max, preserves selection, and replaces levels on model change', () => {
    dom = new JSDOM('<select></select>');
    const oldDocument = globalThis.document;
    globalThis.document = dom.window.document;
    try {
      const select = document.querySelector('select')!;
      const enabled = () => [...select.options].filter(o => !o.disabled).map(o => o.value);
      renderGoalReasoning(select, glm, false, 'high');
      expect(enabled()).toEqual(['default', 'max', 'high', 'low']);
      expect(select.value).toBe('high');
      expect(select.options[0]?.textContent).toBe('Default (Max)');
      const high = select.options[2];
      renderGoalReasoning(select, glm, false, 'high');
      expect(select.options[2]).toBe(high); // Status pushes cannot rebuild an open native menu.
      const other = { ...glm, id: 'other/model', reasoning: parseGoalModelReasoning({ supported_efforts: ['low', 'none'] }) };
      renderGoalReasoning(select, other, false, 'high');
      expect(select.value).toBe('high');
      expect(select.selectedOptions[0]?.disabled).toBe(true);
      expect(enabled()).toEqual(['default', 'low', 'none']);
      renderGoalReasoning(select, other, false, 'high', true);
      expect(select.value).toBe('default');
      renderGoalReasoning(select, undefined, false, 'default', true);
      expect(enabled()).toEqual(['default']);
      renderGoalReasoning(select, undefined, true, 'xhigh');
      expect(enabled()).toContain('xhigh');
    } finally { globalThis.document = oldDocument; }
  });
});
