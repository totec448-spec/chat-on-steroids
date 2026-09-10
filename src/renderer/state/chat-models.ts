import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chatModelDisplayLabel, type ChatModelCatalog } from '../../shared/chat-models.js';
import type { ReasoningEffort, SessionSummary } from '../../shared/session.js';
import { api, unwrap } from './app-store.js';

const effortNames: Record<ReasoningEffort, string> = {
  none: 'Instant', minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High',
  xhigh: 'Extra high', max: 'Max', ultra: 'Ultra', pro: 'Pro',
};
const composerEfforts: readonly ReasoningEffort[] = ['low', 'medium', 'high', 'xhigh', 'max', 'ultra', 'pro'];

function usable(catalog: ChatModelCatalog) {
  return catalog.models
    .filter((model) => !/^gpt[ -]?5\.5(?:$|[ -])/i.test(model.label))
    .map((model) => ({ ...model, efforts: composerEfforts.filter((effort) => model.efforts.includes(effort)) }))
    .filter((model) => model.efforts.length > 0);
}

export function useChatModels(summary: SessionSummary | null) {
  const [catalog, setCatalog] = useState<ChatModelCatalog>({ state: 'unknown', requestedAt: null, observedAt: null, models: [] });
  const [model, setModel] = useState('');
  const [effort, setEffort] = useState<ReasoningEffort | ''>('');
  const choices = useRef(new Map<string, { model: string; effort: ReasoningEffort }>());
  const catalogRequest = useRef(0);
  const scope = summary?.id ?? 'new-chat';

  const refresh = useCallback(async () => {
    const request = ++catalogRequest.current;
    setCatalog((current) => ({ ...current, state: 'pending', requestedAt: Date.now(), error: undefined }));
    try {
      const next = await unwrap(api.requestChatModels());
      if (request === catalogRequest.current) setCatalog(next);
    } catch (error) {
      if (request === catalogRequest.current) setCatalog((current) => ({ ...current, state: 'unavailable', error: error instanceof Error ? error.message : String(error) }));
    }
  }, []);

  useEffect(() => {
    const request = ++catalogRequest.current;
    void unwrap(api.getChatModels()).then((next) => { if (request === catalogRequest.current) setCatalog(next); }).catch(() => undefined);
    const dispose = api.onChatModelsChanged((next) => { ++catalogRequest.current; setCatalog(next); });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, []);

  const models = useMemo(() => usable(catalog), [catalog]);

  useEffect(() => {
    const held = choices.current.get(scope);
    if (held && models.some((choice) => choice.id === held.model && choice.efforts.includes(held.effort))) {
      setModel(held.model);
      setEffort(held.effort);
      return;
    }
    if (held) choices.current.delete(scope);
    const observed = summary?.selectedModel;
    if (observed) {
      const matched = models.find((choice) => choice.id === observed.model || choice.aliases?.includes(observed.model));
      setModel(matched?.id ?? observed.model);
      setEffort(observed.reasoningEffort ?? '');
      return;
    }
    if (!models.length) { setModel(''); setEffort(''); return; }
    const preferred = models.find((choice) => /^gpt[ -]?6$/i.test(choice.label) && choice.efforts.includes('high')) ?? models[0]!;
    setModel(preferred.id);
    setEffort(preferred.efforts.includes('high') ? 'high' : preferred.efforts[0] ?? '');
  }, [models, scope, summary?.selectedModel]);

  const choose = useCallback((nextModel: string, nextEffort: ReasoningEffort) => {
    choices.current.set(scope, { model: nextModel, effort: nextEffort });
    setModel(nextModel);
    setEffort(nextEffort);
  }, [scope]);

  const steps = useMemo(() => models.flatMap((choice) => choice.efforts.map((reasoningEffort) => ({
    model: choice.id,
    modelLabel: choice.label,
    effort: reasoningEffort,
    effortLabel: effortNames[reasoningEffort],
    label: chatModelDisplayLabel(choice.label, reasoningEffort, effortNames[reasoningEffort]),
  }))), [models]);
  const selected = steps.find((step) => step.model === model && step.effort === effort) ?? null;

  return { catalog, models, steps, selected, model, effort, choose, refresh };
}
