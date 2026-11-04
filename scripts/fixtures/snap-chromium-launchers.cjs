const fs = require('node:fs');
const path = require('node:path');

// snapd can expose its launchers through either location depending on the distro.
const snapChromiumPaths = ['/snap/bin/chromium', '/var/lib/snapd/snap/bin/chromium'];

function isSnapChromiumLauncher(executable, exists = fs.existsSync) {
  let selected = path.resolve(executable);
  const seen = new Set();
  // The canonical Snap launchers themselves may link to generic /usr/bin/snap.
  // Canonicalize each parent directory, not the final filename, before matching:
  // /bin/chromium-browser can be /usr/bin/chromium-browser on merged-usr Linux.
  // Resolving the whole executable would lose the Chromium name at /usr/bin/snap.
  for (let hops = 0; hops < 20; hops++) {
    let normalized = selected;
    try { normalized = path.join(fs.realpathSync(path.dirname(selected)), path.basename(selected)); }
    catch { /* Preserve named Snap launchers when their parent is absent in tests. */ }
    if (snapChromiumPaths.includes(selected) || snapChromiumPaths.includes(normalized) ||
        ([selected, normalized].includes('/usr/bin/chromium-browser') &&
          snapChromiumPaths.some(candidate => exists(candidate)))) return true;
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    try {
      selected = path.resolve(path.dirname(normalized), fs.readlinkSync(normalized));
    } catch { return false; }
  }
  return false;
}

module.exports = { snapChromiumPaths, isSnapChromiumLauncher };
