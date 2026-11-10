// Only owned, inactive UI-check profiles may be removed; screenshots/results are never profiles.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const OWNER = '.ui-check-owner.json';
function processScope() {
  // A hostname alone does not identify a PID namespace. Linux exposes its boot and
  // namespace identities; elsewhere (or without /proc) keep interrupted profiles.
  if (process.platform !== 'linux') return null;
  try {
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    const namespace = fs.readlinkSync('/proc/self/ns/pid');
    return boot && /^pid:\[\d+\]$/.test(namespace) ? `${boot}/${namespace}` : null;
  } catch { return null; }
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; }
}
function remove(profile) {
  fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
function pruneProfiles(root) {
  fs.mkdirSync(root, { recursive: true });
  const scope = processScope();
  if (!scope) return;
  const host = os.hostname();
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith('runtime-')) continue;
    const profile = path.join(root, entry.name);
    let owner;
    try { owner = JSON.parse(fs.readFileSync(path.join(profile, OWNER), 'utf8')); } catch { continue; }
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)) continue;
    if (owner.host !== host || owner.processScope !== scope) continue;
    const group = owner.processGroup;
    if (group?.kind !== 'detached-posix' || !Number.isSafeInteger(group.id) || group.id <= 0 || group.id !== owner.child) continue;
    if (owner.kind !== 'terminal-ui-check' || alive(owner.parent) || alive(owner.child)) continue;
    // Dead parent/root PIDs do not prove that ignored-stdio descendants exited.
    // Probe only the explicitly recorded owned group; never terminate it during pruning.
    try { process.kill(-group.id, 0); continue; }
    catch (error) { if (error.code !== 'ESRCH') continue; }
    console.log('UI profile: removing inactive interrupted terminal check profile');
    try { remove(profile); }
    catch (error) { console.warn('UI profile cleanup deferred; retained stale profile:', error); }
  }
}
function createProfile(root) {
  pruneProfiles(root);
  const profile = fs.mkdtempSync(path.join(root, 'runtime-'));
  // Missing/invalid child PID is treated as active until spawn has completed.
  const host = os.hostname(), scope = processScope();
  const markChild = (child, group = null) => fs.writeFileSync(path.join(profile, OWNER), JSON.stringify({
    kind: 'terminal-ui-check', host, processScope: scope, parent: process.pid, child,
    processGroup: Number.isSafeInteger(child) && child > 0 && group === child ? { kind: 'detached-posix', id: group } : null
  }));
  markChild(null);
  return { path: profile, markChild, cleanup: () => remove(profile) };
}
module.exports = { createProfile, pruneProfiles };
