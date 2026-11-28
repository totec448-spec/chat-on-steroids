// The first plain command-line argument of a UI check: its output folder or screenshot destination.
//
// verify-ui starts a check as `electron <flags> scripts/<check>.cjs --lang=en-US`, and on Linux X11 the flags
// (`--no-sandbox`, `--ozone-platform=x11`) come first. Electron keeps the script itself in `process.argv` in front of
// the switches, so a check that read "the first argument that is not a switch" took its own script path for an
// output folder and failed before it ran. The script is recognised by its path, so a folder that only looks like it
// is still an output folder, and a destination that does not exist yet is kept.
const fs = require('node:fs');
const path = require('node:path');

function plainArgument(argv, scriptFile) {
  const script = (() => { try { return fs.realpathSync(scriptFile); } catch { return scriptFile; } })();
  return argv.slice(1).find(arg => {
    if (arg.startsWith('--')) return false;
    const candidate = path.resolve(arg);
    if (candidate === scriptFile || candidate === script) return false;
    try { return fs.realpathSync(candidate) !== script; }
    catch { return true; }
  });
}

module.exports = { plainArgument };
