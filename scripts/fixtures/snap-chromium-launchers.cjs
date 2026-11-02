const fs = require('node:fs');
const path = require('node:path');

// snapd can expose its launchers through either location depending on the distro.
const snapChromiumPaths = ['/snap/bin/chromium', '/var/lib/snapd/snap/bin/chromium'];

function isSnapChromiumLauncher(executable, exists = fs.existsSync) {
  let selected = path.resolve(executable);
  const seen = new Set();
  // The canonical Snap launchers themselves may link to generic /usr/bin/snap.
  // Check each hop *before* following it, or realpath() would lose the app name.
  for (let hops = 0; hops < 20 && !seen.has(selected); hops++) {
    if (snapChromiumPaths.includes(selected) ||
        (selected === '/usr/bin/chromium-browser' && snapChromiumPaths.some(candidate => exists(candidate)))) return true;
    seen.add(selected);
    try {
      selected = path.resolve(path.dirname(selected), fs.readlinkSync(selected));
    } catch { return false; }
  }
  return false;
}

module.exports = { snapChromiumPaths, isSnapChromiumLauncher };
