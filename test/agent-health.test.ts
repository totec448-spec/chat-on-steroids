import { expect, it } from 'vitest';
import { evaluateWorkerOverviewHealth } from '../src/shared/agent-health.js';

it('keeps exact active work healthy even when the browser is detached', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'detached',
    exactIdentity: true,
    working: true,
    activeTurn: false
  })).toMatchObject({ health: 'healthy', activity: 'working' });
});

it('degrades a detached worker only when no stronger positive work evidence exists', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'detached',
    exactIdentity: true,
    working: false,
    activeTurn: false
  })).toMatchObject({ health: 'degraded', activity: 'working' });
});

it('fails closed when exact worker/conversation binding is missing', () => {
  expect(evaluateWorkerOverviewHealth({
    state: null,
    exactIdentity: false,
    working: true,
    activeTurn: true
  })).toMatchObject({ health: 'unknown' });
});

it('keeps starting and sleeping lifecycle states healthy without inventing recovery work', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'waking',
    exactIdentity: true,
    working: false,
    activeTurn: false
  })).toMatchObject({ health: 'healthy', activity: 'starting' });
  expect(evaluateWorkerOverviewHealth({
    state: 'sleeping',
    exactIdentity: true,
    working: false,
    activeTurn: false
  })).toMatchObject({ health: 'healthy', activity: 'sleeping' });
});

it('reports a terminal failed worker as degraded history rather than healthy active work', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'failed',
    exactIdentity: true,
    working: false,
    activeTurn: false
  })).toMatchObject({ health: 'degraded', activity: 'done' });
});


it('keeps broker terminal failure authoritative over stale recorded work', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'failed',
    exactIdentity: true,
    working: true,
    activeTurn: true
  })).toMatchObject({ health: 'degraded', activity: 'done' });
});


it('keeps broker sleeping and finished states authoritative over stale recorded work', () => {
  expect(evaluateWorkerOverviewHealth({
    state: 'sleeping',
    exactIdentity: true,
    working: true,
    activeTurn: true
  })).toMatchObject({ health: 'healthy', activity: 'sleeping' });
  expect(evaluateWorkerOverviewHealth({
    state: 'finished',
    exactIdentity: true,
    working: true,
    activeTurn: true
  })).toMatchObject({ health: 'healthy', activity: 'done' });
});
