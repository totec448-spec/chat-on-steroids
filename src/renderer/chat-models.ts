import { ui, uiText, t } from './i18n.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { chatModelDisplayLabel, chatModelName, isProModel } from '../shared/chat-models.js';
import type { ChatModelOption } from '../shared/chat-models.js';
import type { Config } from '../shared/types.js';
import type { ReasoningEffort } from '../shared/session.js';
import { $, el, run } from './dom.js';

let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let generation = 0;
let onComposerPaint: (() => void) | undefined;
const catalogWaiters = new Set<() => void>();
let discovery: Promise<void> | null = null;
let catalogSubscribed = false;
type ObservedSelection = { model: string; reasoningEffort?: ReasoningEffort; observedAt: number };
let composerContext: { scope: string | null; observation: ObservedSelection | null; edited: boolean } | null = null;
const pairs = [['composerModel', 'composerReasoning'], ['workerModel', 'workerReasoning'], ['helperModel', 'helperReasoning']] as const;
const effortNames: Record<string, string> = { none: "Instant", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", pro: 'Pro' } satisfies Record<ReasoningEffort, string>;
const composerEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'] as const;
const effortLabel = (effort: string): string => effortNames[effort] ? t(effortNames[effort]) : effort;
const modelEffortLabel = (model: ChatModelOption, effort: ReasoningEffort): string =>
  model.effortLabels?.[effort] ?? (isProModel(model.id) && model.efforts.length === 1 ? t('Pro') : effortLabel(effort));
function observedModel(value: string) {
  const exact = catalog.models.filter(choice => choice.id === value || choice.aliases?.includes(value));
  if (exact.length) return exact.length === 1 ? exact[0] : undefined;
  const normalize = (text: string) => text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}.]/gu, '');
  const name = normalize(value);
  const matches = name ? catalog.models.filter(choice => normalize(choice.label) === name) : [];
  return matches.length === 1 ? matches[0] : undefined;
}

function paintComposerContext(): void {
  if (!composerContext || composerContext.edited) return;
  const observed = composerContext.observation;
  if (composerContext.scope === null) return;
  const match = observed && observedModel(observed.model);
  // An unknown session model must not inherit the previous chat's valid Send choice.
  paintPair('composerModel', 'composerReasoning', match?.id ?? observed?.model ?? 'not-observed', observed?.reasoningEffort ?? 'not-observed');
}

/** Scope comes from the caller's session + selection generation; no browser mutation. */
export function applyComposerSessionModel(scope: string | null, observation: ObservedSelection | null): void {
  if (!composerContext || composerContext.scope !== scope) {
    composerContext = { scope, observation, edited: false };
    if (scope === null) paintPair('composerModel', 'composerReasoning', '', '');
  } else if (observation && (!composerContext.observation || observation.observedAt >= composerContext.observation.observedAt)) {
    composerContext.observation = observation;
  }
  paintComposerContext(); paintStatus();
}

/** Every observed model and effort is selectable; no generation or lane is hidden. */
function composerModels() {
  if (!catalog.models.length) return [];
  return catalog.models
    .map(model => ({ ...model, efforts: composerEfforts.filter(effort => model.efforts.includes(effort)) }))
    .filter(model => model.efforts.length > 0);
}

function options(select: HTMLSelectElement, choices: Array<{ id: string; label: string | (() => string) }>, value: string): void {
  const option = (label: string | (() => string), id: string) => {
    const node = el('option', '', label) as HTMLOptionElement; node.value = id; return node;
  };
  const desired = choices.map(choice => option(choice.label, choice.id));
  if (!desired.length && !value) {
    const unavailable = option(() => t("No observed choices"), ''); unavailable.disabled = true; desired.push(unavailable);
  }
  if (value && !choices.some(choice => choice.id === value)) {
    const unverified = option(() => t("{0} · not verified", [value]), value);
    unverified.disabled = true;
    desired.push(unverified);
  }
  // State pushes must not close a native picker or replace nodes while its choices are unchanged.
  if (select.options.length !== desired.length || desired.some((node, index) => {
    const current = select.options[index];
    return !current || current.value !== node.value || current.text !== node.text || current.disabled !== node.disabled;
  })) select.replaceChildren(...desired);
  select.value = value;
}

function paintPair(modelId: string, effortId: string, modelValue?: string, effortValue?: string): void {
  const model = document.getElementById(modelId) as HTMLSelectElement | null;
  const effort = document.getElementById(effortId) as HTMLSelectElement | null;
  if (!model || !effort) return;
  const models = modelId === 'composerModel' ? composerModels() : catalog.models;
  let nextModel = modelValue ?? model.value;
  let nextEffort = effortValue ?? effort.value;
  const observed = observedModel(nextModel);
  if (modelId !== 'composerModel' && observed?.id !== nextModel && observed?.aliases?.includes(nextModel)) {
    // A saved execution alias is an exact lane request. The family effort union
    // cannot prove which efforts that alias supports. Retain both requested values
    // until the user deliberately selects a family; native selection proves the pair.
    options(model, [...models, { id: nextModel, label: `${observed.label} · ${nextModel}` }], nextModel);
    options(effort, [{ id: nextEffort, label: () => nextEffort ? effortLabel(nextEffort) : t('Keep requested model settings') }], nextEffort);
    return;
  }
  nextModel = observed?.id ?? nextModel;
  if (models.length && !nextModel) {
    // A preference selects only a model/effort actually observed in this catalog.
    const preferred = models.find(item => /^gpt[ -]?6$/i.test(item.label) && item.efforts.includes('high'))
      ?? models.find(item => item.efforts.includes('high'));
    nextModel = (preferred ?? models[0]!).id;
    nextEffort = '';
  }
  const supported = models.find(item => item.id === nextModel)?.efforts;
  if (supported && !nextEffort) {
    nextEffort = supported.includes('high') ? 'high' : supported[0] ?? '';
  }
  options(model, models.map(item => ({ id: item.id, label: chatModelName(item) })), nextModel);
  const selectedModel = models.find(item => item.id === model.value);
  options(effort, (selectedModel?.efforts ?? []).map(id => ({ id, label: () => modelEffortLabel(selectedModel!, id) })), nextEffort);
}

/** Keyboard interaction stays within one radio group; no Enter reaches the composer. */
function wireChoiceGroup(group: HTMLElement): void {
  group.onkeydown = event => {
    const buttons = [...group.querySelectorAll<HTMLButtonElement>('button[role="radio"]')];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1
      : ['ArrowDown', 'ArrowRight'].includes(event.key) ? (at + 1) % buttons.length
      : ['ArrowUp', 'ArrowLeft'].includes(event.key) ? (at + buttons.length - 1) % buttons.length : -1;
    if (next < 0) return;
    event.preventDefault(); event.stopPropagation(); buttons[next]!.click(); buttons[next]!.focus();
  };
}

function paintComposerChoices(): void {
  const models = document.getElementById('composerModelChoices');
  const powers = document.getElementById('composerPowerChoices');
  if (!models || !powers) return;
  const selected = $<HTMLSelectElement>('composerModel');
  const effort = $<HTMLSelectElement>('composerReasoning');
  const choices = composerModels();
  const title = document.getElementById('composerPowerTitle');
  const subtitle = document.getElementById('composerPowerModel');
  if (title) ui(title, 'textContent', () => choices.length ? t('Model') : catalog.state === 'pending' ? t('Loading models…') : t('Models unavailable'));
  const current = choices.find(choice => choice.id === selected.value);
  if (subtitle) ui(subtitle, 'textContent', () => current ? chatModelName(current) : t('Choose an available model and effort'));
  // Reconcile presentation only when its choices change, never on a status push or selection.
  // The native selects remain the sole requested-selection authority for every Send path.
  const signature = JSON.stringify(choices.map(choice => [choice.id, chatModelName(choice)]));
  if (models.dataset.signature !== signature) {
    const focused = (document.activeElement as HTMLElement | null)?.dataset?.modelId;
    models.dataset.signature = signature; models.replaceChildren();
    for (const choice of choices) {
      const button = el('button', 'model-choice') as HTMLButtonElement;
      button.type = 'button'; button.dataset.modelId = choice.id; button.dataset.keepMenu = 'true';
      button.setAttribute('role', 'radio'); button.title = choice.id;
      button.append(el('span', '', chatModelName(choice)), el('span', 'model-choice-check', '✓'));
      button.lastElementChild!.setAttribute('aria-hidden', 'true');
      button.onclick = () => {
        if (selected.value === choice.id && confirmedComposerModel()) return;
        selected.value = choice.id; selected.dispatchEvent(new window.Event('change', { bubbles: true }));
      };
      models.append(button);
    }
    wireChoiceGroup(models);
    if (focused) [...models.querySelectorAll<HTMLButtonElement>('button')].find(button => button.dataset.modelId === focused)?.focus();
  }
  for (const [index, button] of [...models.querySelectorAll<HTMLButtonElement>('button')].entries()) {
    const checked = button.dataset.modelId === selected.value;
    button.setAttribute('aria-checked', String(checked)); button.tabIndex = checked || !current && index === 0 ? 0 : -1;
  }
  const supported = current?.efforts ?? [];
  const effortSignature = JSON.stringify([current?.id, supported.map(value => [value, modelEffortLabel(current!, value)])]);
  if (powers.dataset.signature !== effortSignature) {
    powers.dataset.signature = effortSignature; powers.replaceChildren();
    for (const value of supported) {
      const button = el('button', 'effort-choice', () => modelEffortLabel(current!, value)) as HTMLButtonElement;
      button.type = 'button'; button.dataset.effort = value; button.dataset.keepMenu = 'true'; button.setAttribute('role', 'radio');
      button.onclick = () => { effort.value = value; effort.dispatchEvent(new window.Event('change', { bubbles: true })); };
      powers.append(button);
    }
    wireChoiceGroup(powers);
  }
  for (const [index, button] of [...powers.querySelectorAll<HTMLButtonElement>('button')].entries()) {
    const checked = button.dataset.effort === effort.value;
    button.setAttribute('aria-checked', String(checked)); button.tabIndex = checked || !supported.includes(effort.value as ReasoningEffort) && index === 0 ? 0 : -1;
  }
}

/** Admission guard for desktop sends: a stale selection is not permission to use defaults. */
export function confirmedComposerModel(): { model: string; reasoningEffort: ReasoningEffort } | null {
  if (!catalog.models.length) return null;
  const model = $<HTMLSelectElement>('composerModel').value;
  const reasoningEffort = $<HTMLSelectElement>('composerReasoning').value;
  const confirmed = composerModels().find(choice => choice.id === model)?.efforts.find(effort => effort === reasoningEffort);
  return confirmed ? { model, reasoningEffort: confirmed } : null;
}

function paintComposerLabel(): void {
  // Display the same admission decision as Send, including discovery and removed efforts.
  const confirmed = confirmedComposerModel();
  const model = confirmed ? catalog.models.find(model => model.id === confirmed.model)! : null;
  const modelLabel = model ? chatModelName(model) : '';
  const label = () => confirmed
    ? isProModel(confirmed.model) && model?.efforts.length === 1 ? modelLabel
      : chatModelDisplayLabel(modelLabel, confirmed.reasoningEffort, modelEffortLabel(model!, confirmed.reasoningEffort))
    : catalog.state === 'pending' ? t("Loading models…") : t("Select model");
  const node = $('composerModelLabel');
  if (confirmed) {
    const pro = confirmed.reasoningEffort === 'pro' || isProModel(confirmed.model) && model?.efforts.length === 1;
    node.replaceChildren(el('strong', '', pro ? label : modelLabel));
    if (!pro) node.append(uiText(() => ` · ${modelEffortLabel(model!, confirmed.reasoningEffort)}`));
  } else node.replaceChildren(uiText(label));
  ui(node, 'title', label);
  onComposerPaint?.();
}

function paintStatus(): void {
  paintComposerChoices();
  const error = () => catalog.error?.startsWith('Model discovery timed out. ')
    ? t('Model discovery timed out. {0}', [t(catalog.error.slice('Model discovery timed out. '.length))]) : t(catalog.error ?? '');
  const message = () => catalog.state === 'pending' ? t(catalog.waiting ?? "Reading your account’s model choices…")
    : catalog.error ? (catalog.models.length ? t('Refresh failed. Previously observed choices remain available. {0}', [error()]) : error())
    : catalog.state === 'ready' ? t("Available in your ChatGPT account · checked {0}", [new Date(catalog.observedAt!).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })])
    : t("Connect to ChatGPT to load your models.");
  for (const id of ['chatModelStatus', 'composerModelStatus']) {
    const node = document.getElementById(id);
    if (node) {
      ui(node, 'textContent', message);
      if (id === 'composerModelStatus') node.hidden = catalog.state === 'ready' && !catalog.error;
    }
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) {
    const button = document.getElementById(id) as HTMLButtonElement | null;
    if (button) {
      // Refresh can promote passive discovery; main coalesces repeated explicit clicks.
      button.disabled = false;
      if (id === 'refreshComposerModels') {
        button.hidden = false;
        ui(button, 'title', () => catalog.state === 'pending' ? t("Reading ChatGPT models") : t("Reload ChatGPT models"));
        ui(button, 'aria-label', () => catalog.state === 'pending' ? t('Reading ChatGPT models') : t('Reload ChatGPT models'));
      }
    }
  }
  paintComposerLabel();
  for (const waiter of catalogWaiters) waiter();
}

/** Refresh and Send share one request; state pushes complete waiting sends without polling. */
function discoverModels(): Promise<void> {
  if (discovery) return discovery;
  const requested = ++generation;
  catalog = { ...catalog, state: 'pending', requestedAt: Date.now(), error: undefined };
  paintStatus();
  const work = (async () => {
    const result = await run(window.api.requestChatModels()).catch(() => null);
    if (requested !== generation) return;
    catalog = result ?? { ...catalog, state: 'unavailable', error: t("Model discovery could not start.") };
    for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
    paintComposerContext(); paintStatus();
  })();
  discovery = work.finally(() => { discovery = null; });
  return discovery;
}

export async function ensureComposerModel(refresh = false): Promise<ReturnType<typeof confirmedComposerModel>> {
  if (!refresh && catalog.models.length && catalog.state !== 'pending') return confirmedComposerModel();
  const ready = new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); catalogWaiters.delete(check); resolve(); };
    const check = () => { if (catalog.state === 'ready' || catalog.state === 'unavailable') finish(); };
    const timer = setTimeout(finish, 125000);
    catalogWaiters.add(check);
  });
  await discoverModels();
  await ready;
  return catalog.state === 'ready' && !catalog.error ? confirmedComposerModel() : null;
}

export function applyChatModels(config: Config, previous?: Config): void {
  // Preserve configured values even before an observation arrives; unrelated saves must not erase them.
  const chosen = (id: string, value: string, prior?: string) => {
    const select = document.getElementById(id) as HTMLSelectElement | null;
    return select && document.activeElement === select && previous && select.value !== (prior ?? '') ? select.value : value;
  };
  paintPair('workerModel', 'workerReasoning', chosen('workerModel', config.multiAgent.defaultModel ?? '', previous?.multiAgent.defaultModel), chosen('workerReasoning', config.multiAgent.defaultReasoning ?? '', previous?.multiAgent.defaultReasoning));
  paintPair('helperModel', 'helperReasoning', chosen('helperModel', config.goal.helperModel ?? 'gpt-5.6-sol', previous?.goal.helperModel ?? 'gpt-5.6-sol'), chosen('helperReasoning', config.goal.helperReasoning ?? 'high', previous?.goal.helperReasoning ?? 'high'));
  if (catalogSubscribed && catalog.state !== 'unknown') return;
  const requested = ++generation;
  void window.api.getChatModels().then(result => {
    if (requested !== generation || !result?.ok || !result.data) return;
    catalog = result.data;
    for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
    paintComposerContext();
    paintStatus();
  });
}

export function initChatModels(onPaint?: () => void): void {
  onComposerPaint = onPaint;
  if (window.api.onChatModelsChanged) {
    catalogSubscribed = true;
    window.api.onChatModelsChanged(value => {
      // A current push supersedes every older startup/read/refresh response.
      ++generation; catalog = value;
      for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
      paintComposerContext(); paintStatus();
    });
  }
  document.getElementById('modelMenu')?.addEventListener('toggle', () => {
    if (($('modelMenu') as HTMLDetailsElement).open && !catalog.models.length) $('refreshComposerModels').click();
  });
  for (const [modelId, effortId] of pairs) {
    document.getElementById(modelId)?.addEventListener('change', () => {
      if (modelId === 'composerModel' && composerContext) composerContext.edited = true;
      const model = $<HTMLSelectElement>(modelId);
      const supported = catalog.models.find(item => item.id === model.value)?.efforts ?? [];
      paintPair(modelId, effortId, model.value, supported.includes('high') ? 'high' : supported[0] ?? '');
      paintStatus();
    });
    document.getElementById(effortId)?.addEventListener('change', () => {
      if (effortId === 'composerReasoning' && composerContext) composerContext.edited = true;
      paintStatus();
    });
  }
  for (const id of ['refreshChatModels', 'refreshComposerModels']) document.getElementById(id)?.addEventListener('click', () => { void discoverModels(); });
  for (const [modelId, effortId] of pairs) paintPair(modelId, effortId);
  paintStatus();
}
