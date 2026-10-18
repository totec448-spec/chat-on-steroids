// The renderer page without its own scripts, for UI checks that load it with a fixture instead.
// A DOM parser, not a pattern: a regex tag filter misses forms such as `</script >` or a tag split
// by another one (code scanning: js/bad-tag-filter, js/incomplete-multi-character-sanitization).
const { JSDOM } = require('jsdom');

function withoutScripts(html) {
  const dom = new JSDOM(html);
  for (const script of dom.window.document.querySelectorAll('script')) script.remove();
  const page = dom.serialize();
  dom.window.close();
  return page;
}

module.exports = { withoutScripts };
