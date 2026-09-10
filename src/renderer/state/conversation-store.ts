import { useCallback, useEffect, useRef, useState } from 'react';
import type { InputEntry, SessionControlsView } from '../../preload/index.js';
import { api, unwrap } from './app-store.js';

const ACTIVE_INPUT_STATES = new Set<InputEntry['state']>(['queued', 'browser', 'tool']);

export function useSessionControls(sessionId: string | null) {
  const [controls, setControls] = useState<SessionControlsView | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const refresh = useCallback(async (): Promise<SessionControlsView | null> => {
    const request = ++generation.current;
    if (!sessionId) {
      setControls(null);
      setLoading(false);
      setError('');
      return null;
    }
    setLoading(true);
    try {
      const next = await unwrap(api.getSessionControls(sessionId));
      if (request !== generation.current) return null;
      setControls(next);
      setError('');
      return next;
    } catch (cause) {
      if (request !== generation.current) return null;
      setControls(null);
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [sessionId]);

  const commit = useCallback(async (operation: () => Promise<{ ok: true; data: SessionControlsView } | { ok: false; error: string }>) => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const next = await unwrap(operation());
      if (request === generation.current) {
        setControls(next);
        setError('');
      }
      return next;
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      throw cause;
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, []);

  const accept = useCallback((next: SessionControlsView) => {
    ++generation.current;
    setControls(next);
    setLoading(false);
    setError('');
  }, []);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const dispose = api.onSessionChanged(() => { void refresh(); });
    return () => dispose?.();
  }, [refresh, sessionId]);

  return { controls, loading, error, refresh, commit, accept };
}

export function useSessionQueue(sessionId: string | null) {
  const [rows, setRows] = useState<InputEntry[]>([]);
  const [pausedHelpers, setPausedHelpers] = useState<Array<{ id: string; sourceSessionId: string }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++generation.current;
    if (!sessionId) {
      setRows([]);
      setPausedHelpers([]);
      setLoading(false);
      setError('');
      return;
    }
    setLoading(true);
    try {
      const [inputs, helpers] = await Promise.all([unwrap(api.listInputs()), unwrap(api.listPausedHelpers())]);
      if (request !== generation.current) return;
      setRows(inputs.filter((row) => row.sessionId === sessionId && ACTIVE_INPUT_STATES.has(row.state)));
      setPausedHelpers(helpers.filter((row) => row.sourceSessionId === sessionId));
      setError('');
    } catch (cause) {
      if (request === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [sessionId]);

  useEffect(() => {
    void refresh();
    if (!sessionId) return;
    const dispose = api.onSessionChanged(() => { void refresh(); });
    return () => dispose?.();
  }, [refresh, sessionId]);

  return { rows, pausedHelpers, loading, error, refresh };
}
