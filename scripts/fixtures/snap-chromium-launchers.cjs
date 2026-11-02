const fs = require('node:fs');
const path = require('node:path');

// snapd can expose its launchers through either location depending on the distro.
const snapChromiumPaths = ['/snap/bin/chromium', '/var/lib/snapd/snap/bin/chromium'];

function isSnapChromiumLauncher(executable, exists = fs.existsSync) {
  const selected = path.resolve(executable);
  return snapChromiumPaths.includes(selected) ||
    (selected === '/usr/bin/chromium-browser' && snapChromiumPaths.some(candidate => exists(candidate)));
}

module.exports = { snapChromiumPaths, isSnapChromiumLauncher };
