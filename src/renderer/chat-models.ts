import { ui, uiText, t } from './i18n.js';
import type { ChatModelCatalog } from '../shared/chat-models.js';
import { chatModelDisplayLabel, resolveChatModel } from '../shared/chat-models.js';
import type { Config } from '../shared/types.js';
import type { ReasoningEffort } from '../shared/session.js';
import { $, el, icon, run } from './dom.js';

let catalog: ChatModelCatalog = { state: 'unknown', requestedAt: null, observedAt: null, models: [] };
let generation = 0;
let onComposerPaint: (() => void) | undefined;
const catalogWaiters = new Set<() => void>();
let discovery: Promise<void> | null = null;
let catalogSubscribed = false;
type ObservedSelection = { model: string; reasoningEffort?: ReasoningEffort; observedAt: number };
let composerContext: { scope: string | null; observation: ObservedSelection | null; edited: boolean } | null = null;
/**
 * The user's explicit choice to send with whatever model ChatGPT already has selected.
 *
 * Some plans (ChatGPT Go and Free, #104) show no model picker at all, so discovery can never
 * produce a list and Send refused every message. Nothing is guessed or switched silently: this is
 * offered only while no account list is readable, the person has to pick it, and a readable list
 * takes over again the moment one exists.
 */
let useCurrentModel = false;
type SendModel = { model: string | null; reasoningEffort: ReasoningEffort | null };
const CURRENT_MODEL: SendModel = { model: null, reasoningEffort: null };
function currentModelOffered(): boolean {
  return !catalog.models.length && catalog.state !== 'pending' && (catalog.state === 'unavailable' || !!catalog.error);
}
function currentModelChosen(): boolean {
  return useCurrentModel && currentModelOffered();
}
const pairs = [['composerModel', 'composerReasoning'], ['workerModel', 'workerReasoning'], ['helperModel', 'helperReasoning']] as const;
const effortNames: Record<string, string> = { none: "Instant", minimal: "Minimal", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max", ultra: "Ultra", pro: 'Pro' } satisfies Record<ReasoningEffort, string>;
const composerEfforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'] as const;
const effortLabel = (effort: string): string => effortNames[effort] ? t(effortNames[effort]) : effort;
function observedModel(value: string) {
  return resolveChatModel(catalog.models, value);
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

/** Provider order and available efforts define the slider, including newly released models. */
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
    // The worker and helper selects show an Unverified badge beside them; every other select
    // (the composer and the reasoning pickers) keeps saying so in the option itself.
    const badged = select.id === 'workerModel' || select.id === 'helperModel';
    const unverified = option(badged ? value : () => t("{0} · not verified", [value]), value);
    unverified.disabled = true;
    desired.push(unverified);
  }
  // State pushes must not close a native picker or replace nodes while its choices are unchanged.
  if (select.options.length !== desired.length || desired.some((node, index) => {
    const current = select.options[index];
    return !current || current.value !== node.value || current.text !== node.text || current.disabled !== node.disabled;
  })) select.replaceChildren(...desired);
  select.value = value;
  if (select.id === 'workerModel' || select.id === 'helperModel') {
    let badge = select.nextElementSibling as HTMLElement | null;
    if (!badge?.classList.contains('model-verification')) {
      badge = el('span', 'model-verification');
      badge.id = `${select.id}Verification`;
      select.after(badge);
      select.setAttribute('aria-describedby', badge.id);
    }
    const unverified = !!value && !choices.some(choice => choice.id === value);
    badge.hidden = !unverified;
    if (unverified) ui(badge, 'textContent', () => t('Unverified'));
  }
}

function distinctModelChoices(models: ChatModelCatalog['models']): Array<{ id: string; label: string | (() => string) }> {
  const sameName = new Map<string, number>();
  for (const model of models) sameName.set(model.label, (sameName.get(model.label) ?? 0) + 1);
  const variant = (model: ChatModelCatalog['models'][number]): string | null => {
    if (model.efforts.length && model.efforts.every(effort => effort === 'none')) return 'Instant';
    if (model.efforts.length && model.efforts.every(effort => effort !== 'none' && effort !== 'pro')) return 'Reasoning';
    if (model.efforts.length && model.efforts.every(effort => effort === 'pro')) return 'Pro';
    return null;
  };
  const variantCounts = new Map<string, number>();
  for (const model of models) {
    const lane = variant(model);
    if (lane) {
      const key = `${model.label}\0${lane}`;
      variantCounts.set(key, (variantCounts.get(key) ?? 0) + 1);
    }
  }
  return models.map(model => {
    if (sameName.get(model.label) === 1) return { id: model.id, label: model.label };
    const lane = variant(model);
    return { id: model.id, label: lane && variantCounts.get(`${model.label}\0${lane}`) === 1
      ? () => `${model.label} · ${t(lane)}` : `${model.label} · ${model.id}` };
  });
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
    options(model, [...distinctModelChoices(models), { id: nextModel, label: `${observed.label} · ${nextModel}` }], nextModel);
    options(effort, [{ id: nextEffort, label: () => nextEffort ? effortLabel(nextEffort) : t('Keep requested model settings') }], nextEffort);
    return;
  }
  nextModel = observed?.id ?? nextModel;
  if (models.length && !nextModel) {
    // A preference selects only a model/effort actually observed in this catalog.
    const preferred = models.find(item => /^gpt[ -]?6$/i.test(item.label) && item.efforts.includes('high'));
    nextModel = (preferred ?? models[0]!).id;
    nextEffort = '';
  }
  const supported = models.find(item => item.id === nextModel)?.efforts;
  if (supported && !nextEffort) {
    nextEffort = supported.includes('high') ? 'high' : supported[0] ?? '';
  }
  options(model, distinctModelChoices(models), nextModel);
  options(effort, (models.find(item => item.id === model.value)?.efforts ?? []).map(id => ({ id, label: () => effortLabel(id) })), nextEffort);
}

function paintComposerChoices(): void {
  const models = document.getElementById('composerModelChoices');
  const powers = document.getElementById('composerPowerChoices');
  if (!models || !powers) return;
  const selected = $<HTMLSelectElement>('composerModel');
  const effort = $<HTMLSelectElement>('composerReasoning');
  const choices = composerModels();
  const signature = JSON.stringify([catalog.state, choices, selected.value, effort.value]);
  if (models.dataset.signature === signature) return;
  models.dataset.signature = signature;
  models.replaceChildren();
  powers.replaceChildren();
  const title = document.getElementById('composerPowerTitle');
  const subtitle = document.getElementById('composerPowerModel');
  if (!choices.length) {
    if (currentModelChosen()) {
      if (title) ui(title, 'textContent', () => t("ChatGPT’s current model"));
      if (subtitle) ui(subtitle, 'textContent', () => t("Sent without choosing a model"));
      return;
    }
    if (title) ui(title, 'textContent', () => catalog.state === 'pending' ? t("Loading models…") : t("Models unavailable"));
    if (subtitle) ui(subtitle, 'textContent', () => catalog.state === 'pending' ? t("Reading your ChatGPT account") : t("Reload models"));
    if (currentModelOffered()) {
      const use = el('button', 'btn', () => t("Use ChatGPT’s current model")) as HTMLButtonElement;
      use.type = 'button';
      use.dataset.useCurrentModel = '';
      ui(use, 'title', () => t("Your ChatGPT plan shows no model picker. Send with the model ChatGPT already uses."));
      use.addEventListener('click', () => {
        useCurrentModel = true;
        if (composerContext) composerContext.edited = true;
        paintStatus();
      });
      powers.append(use);
    }
    return;
  }
  for (const choice of distinctModelChoices(choices)) {
    const button = el('button', 'model-choice') as HTMLButtonElement;
    button.type = 'button'; button.dataset.keepMenu = 'true'; button.dataset.model = choice.id;
    button.setAttribute('aria-pressed', String(choice.id === selected.value));
    button.append(el('span', '', choice.label), icon('i-check'));
    button.addEventListener('click', event => {
      // Repainting the choices detaches this button before the document listener.
      // Keep the model menu open without giving it a second selection authority.
      event.stopPropagation();
      if (selected.value === choice.id) return;
      const focused = document.activeElement === button;
      selected.value = choice.id;
      selected.dispatchEvent(new window.Event('change', { bubbles: true }));
      if (focused) models.querySelector<HTMLButtonElement>('[aria-pressed="true"]')?.focus();
    });
    models.append(button);
  }
  const supported = choices.find(choice => choice.id === selected.value)?.efforts ?? [];
  if (title) ui(title, 'textContent', () => t('Thinking effort'));
  const current = supported.findIndex(power => power === effort.value);
  if (subtitle) ui(subtitle, 'textContent', () => current < 0 ? t('Previous selection unavailable') : effortLabel(effort.value));
  if (!supported.length) return;
  const choose = (power: ReasoningEffort | string): void => {
    if (composerContext) composerContext.edited = true;
    effort.value = power;
    if (subtitle) ui(subtitle, 'textContent', () => effortLabel(power));
    paintComposerLabel();
    models.dataset.signature = JSON.stringify([catalog.state, choices, selected.value, effort.value]);
  };
  // One effort (an Instant model) is not a choice: no slider, just its name. A stale saved
  // effort still needs one explicit confirmation before Send may use this model.
  if (supported.length === 1) {
    if (current >= 0) return;
    const only = supported[0]!;
    const use = el('button', 'btn power-single', () => t('Use effort: {0}', [effortLabel(only)])) as HTMLButtonElement;
    use.type = 'button'; use.dataset.keepMenu = 'true';
    use.addEventListener('click', event => { event.stopPropagation(); choose(only); use.remove(); });
    powers.append(use);
    return;
  }
  const last = supported.length - 1;
  const track = el('div', 'power-track');
  // The thumb follows the pointer continuously and settles on the nearest effort when released;
  // keys and the stored choice stay whole steps. The fill ends under the thumb's centre.
  const slider = document.createElement('input'); slider.type = 'range'; slider.min = '0'; slider.max = String(last); slider.step = 'any';
  ui(slider, 'aria-label', () => t('Thinking effort'));
  const nearest = (): number => Math.max(0, Math.min(last, Math.round(Number(slider.value))));
  const paintPosition = (value: number): void => { track.style.setProperty('--power-fraction', String(value / last)); };
  const announce = (index: number): void => { ui(slider, 'aria-valuetext', () => effortLabel(supported[index]!)); };
  for (let index = 0; index <= last; index++) {
    const stop = el('span', 'power-stop'); stop.style.setProperty('--power-stop', String(index / last)); track.append(stop);
  }
  let shown = Math.max(0, current);
  slider.value = String(shown);
  paintPosition(shown);
  if (current >= 0) announce(shown);
  else ui(slider, 'aria-valuetext', () => t('Choose an available model and effort'));
  const pick = (index: number): void => {
    announce(index);
    if (index !== shown || effort.value !== supported[index]) { shown = index; choose(supported[index]!); }
  };
  // Test DOMs and hidden windows may lack animation frames; settling then just lands at once.
  const frame = (callback: FrameRequestCallback): number => typeof requestAnimationFrame === 'function' ? requestAnimationFrame(callback) : (callback(performance.now() + 1000), 0);
  const cancelFrame = (id: number): void => { if (id && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(id); };
  let settling = 0;
  const settle = (): void => {
    cancelFrame(settling);
    const from = Number(slider.value), to = nearest(), started = performance.now();
    pick(to);
    const step = (now: number): void => {
      const progress = Math.min(1, (now - started) / 140), eased = 1 - (1 - progress) ** 3;
      const value = from + (to - from) * eased;
      slider.value = String(value); paintPosition(value);
      if (progress < 1) settling = frame(step);
    };
    settling = frame(step);
  };
  slider.addEventListener('input', () => { cancelFrame(settling); paintPosition(Number(slider.value)); pick(nearest()); });
  slider.addEventListener('change', settle);
  slider.addEventListener('pointerup', settle);
  slider.addEventListener('keydown', event => {
    const moves: Record<string, number> = { ArrowLeft: -1, ArrowDown: -1, ArrowRight: 1, ArrowUp: 1, PageDown: -1, PageUp: 1, Home: -last, End: last };
    const move = moves[event.key];
    if (move === undefined) return;
    event.preventDefault();
    slider.value = String(Math.max(0, Math.min(last, nearest() + move)));
    settle();
  });
  // Keep the range node alive through pointer/keyboard adjustment; hidden selects remain
  // the existing send authority, and no separate model selection state is introduced.
  track.append(slider);
  const endpoints = el('div', 'effort-endpoints');
  endpoints.append(el('span', '', () => effortLabel(supported[0]!)), el('span', '', () => effortLabel(supported[last]!)));
  powers.append(track, endpoints);
}

/** Admission guard for desktop sends: a stale selection is not permission to use defaults. */
/** What Send uses: the confirmed pair, or the explicitly chosen "ChatGPT's current model". */
export function composerSendModel(): SendModel | null {
  return confirmedComposerModel() ?? (currentModelChosen() ? { ...CURRENT_MODEL } : null);
}

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
  const modelLabel = confirmed ? catalog.models.find(model => model.id === confirmed.model)!.label : '';
  const label = () => confirmed
    ? chatModelDisplayLabel(modelLabel, confirmed.reasoningEffort, effortLabel(confirmed.reasoningEffort))
    : currentModelChosen() ? t("ChatGPT’s current model")
    : catalog.state === 'pending' ? t("Loading models…") : t("Select model");
  const node = $('composerModelLabel');
  if (confirmed) {
    const pro = confirmed.reasoningEffort === 'pro';
    node.replaceChildren(el('strong', '', pro ? label : modelLabel));
    if (!pro) node.append(uiText(() => ` · ${effortLabel(confirmed.reasoningEffort)}`));
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

export async function ensureComposerModel(refresh = false): Promise<SendModel | null> {
  if (!refresh && catalog.models.length && catalog.state !== 'pending') return confirmedComposerModel();
  if (!refresh && currentModelChosen()) return { ...CURRENT_MODEL };
  const ready = new Promise<void>(resolve => {
    const finish = () => { clearTimeout(timer); catalogWaiters.delete(check); resolve(); };
    const check = () => { if (catalog.state === 'ready' || catalog.state === 'unavailable') finish(); };
    const timer = setTimeout(finish, 125000);
    catalogWaiters.add(check);
  });
  await discoverModels();
  await ready;
  return catalog.state === 'ready' && !catalog.error ? confirmedComposerModel() : currentModelChosen() ? { ...CURRENT_MODEL } : null;
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
