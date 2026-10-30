import { describe, it, expect } from 'vitest';
import { newIndependentDraftKey, parseIndependentDraftKey } from '../src/renderer/sidebar-draft-identity.js';

const uuid = '01234567-89ab-cdef-1234-567890abcdef';
describe('independent new-chat draft identity', () => {
  it('round trips individual new-chat and project-scoped draft keys', () => {
    expect(parseIndependentDraftKey(newIndependentDraftKey(null, uuid))).toEqual({ projectId: null });
    expect(parseIndependentDraftKey(newIndependentDraftKey('project:name:1', uuid))).toEqual({ projectId: 'project:name:1' });
    expect(newIndependentDraftKey('p', uuid)).not.toBe(newIndependentDraftKey('p', 'fedcba98-7654-3210-fedc-ba9876543210'));
  });
  it('never mistakes existing session or legacy draft keys for independent drafts', () => {
    for (const key of ['new', 'project:p', 'draft:new:bad', 'draft:project:p:bad', 'session-id', 'draft:project:%:01234567-89ab-cdef-1234-567890abcdef'])
      expect(parseIndependentDraftKey(key)).toBeNull();
    expect(() => newIndependentDraftKey('x'.repeat(200), uuid)).toThrow(/too long/);
  });
});
