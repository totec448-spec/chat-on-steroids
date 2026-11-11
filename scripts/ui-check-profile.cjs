const { mkdirSync, mkdtempSync, rmSync } = require('node:fs');
const path = require('node:path');

exports.createProfile = root => {
  mkdirSync(root, { recursive: true });
  return mkdtempSync(path.join(root, 'profile-'));
};

exports.removeProfile = profile => {
  try { rmSync(profile, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); }
  catch (error) { console.warn('Could not remove temporary terminal check profile:', error.message); }
};
