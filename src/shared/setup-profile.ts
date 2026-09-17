/** Stable credential identity; the original setup keeps its existing encrypted slot. */
export function setupApiKeySlot(profileId = 'default'): 'openaiApiKey' | `setup:${string}` {
  return profileId === 'default' ? 'openaiApiKey' : `setup:${profileId}`;
}
