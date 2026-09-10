import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionListCursor } from '../../preload/index.js';
import type { SessionEvent, SessionSummary } from '../../shared/session.js';
import type { LocalProject } from '../../shared/projects.js';
import { api, unwrap } from './app-store.js';

export interface SessionState {
  sessions: SessionSummary[];
  projects: LocalProject[];
  blocked: Set<string>;
  activeId: string | null;
  total: number;
  nextCursor: SessionListCursor | null;
  loading: boolean;
}

/**
 * One IPC page of sessions. `sessions:list` caps `limit` at 60, so a larger value fails
 * validation and breaks every refresh ( surfacing as "Too big: expected number to be <= 60"
 * with the folder/project list never updating).
 */
const SESSION_PAGE_SIZE = 60;

const initial: SessionState = {
  sessions: [],
  projects: [],
  blocked: new Set(),
  activeId: null,
  total: 0,
  nextCursor: null,
  loading: true,
};

export function useSessions() {
  const [state, setState] = useState<SessionState>(initial);
  const generation = useRef(0);

  const refresh = useCallback(async (preserveSelection = true) => {
    const request = ++generation.current;
    setState((current) => ({ ...current, loading: true }));
    const [page, projects] = await Promise.all([
      unwrap(api.listSessions({ limit: SESSION_PAGE_SIZE })),
      unwrap(api.listProjects()),
    ]);
    if (request !== generation.current) return;
    setState((current) => ({
      sessions: page.sessions,
      projects,
      blocked: new Set(page.blocked),
      activeId: preserveSelection && current.activeId && page.sessions.some((row) => row.id === current.activeId)
        ? current.activeId
        : current.activeId === null
          ? null
          : page.activeId ?? page.sessions[0]?.id ?? null,
      total: page.total,
      nextCursor: page.nextCursor,
      loading: false,
    }));
  }, []);

  const loadMore = useCallback(async () => {
    const cursor = state.nextCursor;
    if (!cursor) return;
    const request = ++generation.current;
    const page = await unwrap(api.listSessions({ cursor, limit: SESSION_PAGE_SIZE }));
    if (request !== generation.current) return;
    setState((current) => {
      const known = new Set(current.sessions.map((session) => session.id));
      return {
        ...current,
        sessions: [...current.sessions, ...page.sessions.filter((session) => !known.has(session.id))],
        total: page.total,
        nextCursor: page.nextCursor,
        blocked: new Set(page.blocked),
      };
    });
  }, [state.nextCursor]);

  useEffect(() => {
    void refresh(false);
    const dispose = api.onSessionChanged(() => void refresh(true));
    return () => { if (typeof dispose === 'function') dispose(); };
  }, [refresh]);

  const select = useCallback((id: string | null) => {
    setState((current) => ({ ...current, activeId: id }));
  }, []);

  return { ...state, refresh, loadMore, select };
}

export function useSessionDetail(id: string | null) {
  const [summary, setSummary] = useState<SessionSummary | null>(null);
  const [events, setEvents] = useState<SessionEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const [loadingNewer, setLoadingNewer] = useState(false);
  const [atLatest, setAtLatest] = useState(true);
  const generation = useRef(0);
  const deltaGeneration = useRef(0);
  const stateRef = useRef({ events: [] as SessionEvent[], atLatest: true, nextFrom: 1 });

  const commitWindow = useCallback((nextEvents: SessionEvent[], nextAtLatest: boolean, nextCursor: number) => {
    stateRef.current = { events: nextEvents, atLatest: nextAtLatest, nextFrom: nextCursor };
    setEvents(nextEvents);
    setAtLatest(nextAtLatest);
  }, []);

  const refresh = useCallback(async () => {
    if (!id) {
      ++generation.current;
      setSummary(null);
      commitWindow([], true, 1);
      return;
    }
    const request = ++generation.current;
    setLoading(true);
    try {
      const detail = await unwrap(api.getSession(id, { limit: 160 }));
      if (request !== generation.current) return;
      setSummary(detail.summary);
      commitWindow(detail.events, true, detail.nextFrom);
    } finally {
      if (request === generation.current) setLoading(false);
    }
  }, [commitWindow, id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!id) return;
    const dispose = api.onSessionChanged(() => {
      if (!stateRef.current.atLatest) return;
      const request = generation.current;
      const deltaRequest = ++deltaGeneration.current;
      const cursor = stateRef.current.nextFrom;
      void unwrap(api.getSession(id, { from: cursor, limit: 160 })).then((detail) => {
        if (request !== generation.current || deltaRequest !== deltaGeneration.current || !stateRef.current.atLatest) return;
        setSummary(detail.summary);
        const next = detail.events.length
          ? mergeEvents(stateRef.current.events, detail.events).slice(-160)
          : stateRef.current.events;
        commitWindow(next, true, detail.nextFrom);
      }).catch(() => undefined);
    });
    return () => { if (typeof dispose === 'function') dispose(); };
  }, [commitWindow, id]);

  const loadOlder = useCallback(async (): Promise<boolean> => {
    if (!id || loadingOlder || !stateRef.current.events.length) return false;
    const before = Math.min(...stateRef.current.events.map((event) => event.seq));
    if (before <= 1) return false;
    const request = generation.current;
    setLoadingOlder(true);
    try {
      const detail = await unwrap(api.getSession(id, { before, limit: 80 }));
      if (request !== generation.current || !detail.events.length) return false;
      setSummary(detail.summary);
      const merged = mergeEvents(detail.events, stateRef.current.events);
      // Older navigation deliberately evicts the newest rows first. Keeping one bounded
      // window avoids turning a long recording into an unbounded renderer allocation.
      const next = merged.slice(0, 160);
      const nextCursor = next.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 1);
      commitWindow(next, nextCursor >= detail.nextFrom && next.length === merged.length, nextCursor);
      return true;
    } finally {
      if (request === generation.current) setLoadingOlder(false);
    }
  }, [commitWindow, id, loadingOlder]);

  const loadNewer = useCallback(async (): Promise<boolean> => {
    if (!id || loadingNewer || atLatest || !stateRef.current.events.length) return false;
    const from = stateRef.current.events.reduce((cursor, event) => Math.max(cursor, event.seq + 1), 1);
    const request = generation.current;
    setLoadingNewer(true);
    try {
      const detail = await unwrap(api.getSession(id, { from, limit: 80 }));
      if (request !== generation.current) return false;
      setSummary(detail.summary);
      if (!detail.events.length) {
        commitWindow(stateRef.current.events, true, detail.nextFrom);
        return true;
      }
      const merged = mergeEvents(stateRef.current.events, detail.events);
      const next = merged.slice(-160);
      // A full forward page says nothing about whether another page exists. Only a short
      // page (or the next empty read) proves we reached the live tail.
      const nextAtLatest = detail.events.length < 80;
      commitWindow(next, nextAtLatest, detail.nextFrom);
      return true;
    } finally {
      if (request === generation.current) setLoadingNewer(false);
    }
  }, [atLatest, commitWindow, id, loadingNewer]);

  const canLoadOlder = events.length > 0 && Math.min(...events.map((event) => event.seq)) > 1;

  return { summary, events, loading, refresh, loadOlder, loadNewer, loadingOlder, loadingNewer, atLatest, canLoadOlder };
}

function mergeEvents(current: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const bySeq = new Map(current.map((event) => [event.seq, event]));
  for (const event of incoming) bySeq.set(event.seq, event);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}
