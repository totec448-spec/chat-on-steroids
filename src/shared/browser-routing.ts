/**
 * Model-facing identity for the two deliberately independent web surfaces.
 *
 * Keep this vocabulary shared by connector discovery, tool declarations and refusal guidance.
 * Neither surface imports or dispatches to the other; these strings only prevent the model from
 * treating "a browser" as one interchangeable authority.
 */
export const BROWSER_USE_SCOPE =
  'BROWSER USE — isolated Browser panel and web session; no Desktop connector or companion extension.';

export const COMPANION_BROWSER_SCOPE =
  'DESKTOP COMPANION BROWSER — existing browser tabs exposed by the companion; not Browser Use.';

export const BROWSER_SURFACE_ROUTING =
  'Route Browser Use/Browser panel to Core browser. Route existing companion-exposed or ChatGPT tabs to Desktop browser_*. Missing Companion does not mean Browser Use is unavailable.';
