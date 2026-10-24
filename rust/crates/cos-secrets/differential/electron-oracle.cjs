// Headless Electron runner for the real `src/main/secrets.ts`. Opens no window.
//   electron electron-oracle.cjs <secrets.cjs> <userData> <ops.json>
// <secrets.cjs> is secrets.ts bundled by roundtrip.mjs. Store operations match
// examples/secrets_ops.rs. `rawWrite` and `rawRead` call safeStorage directly, the way
// writeAll() and loadAll() do, to seed a profile and to inspect what the other side wrote.
const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const [bundle, userData, opsFile] = process.argv.slice(process.defaultApp ? 2 : 1);
app.setPath('userData', path.resolve(userData));
app.disableHardwareAcceleration();
const secrets = require(path.resolve(bundle));
const secretsPath = path.join(app.getPath('userData'), 'secrets.bin');

const ERROR_KINDS = new Map([
  ['Secure OS credential storage is unavailable, so the key was not saved', 'unavailable'],
  ['Secure OS credential storage is unavailable, so nothing was changed', 'unavailable'],
  ['The saved keys could not be read, so the key was not saved', 'unreadable']
]);

async function outcome(promise) {
  try {
    return (await promise) ?? null;
  } catch (error) {
    return { error: ERROR_KINDS.get(error.message) ?? 'io' };
  }
}

async function apply(op) {
  switch (op.op) {
    case 'status':
      return secrets.secureStorageStatus();
    case 'get':
      return secrets.getSecret(op.key);
    case 'has':
      return secrets.hasSecret(op.key);
    case 'set':
      return outcome(secrets.setSecret(op.key, op.value));
    case 'clear':
      return outcome(secrets.clearSecret(op.key));
    case 'deleteAll':
      return outcome(secrets.deleteAllSecrets());
    case 'setAside':
      return outcome(secrets.setAsideUnreadableSecrets(new Date(op.now)));
    case 'unreadable':
      return secrets.storedSecretsUnreadable();
    case 'restart':
      secrets.resetSecretsCacheForTests();
      return null;
    case 'rawWrite': {
      const blob = op.sync ? safeStorage.encryptString(op.plaintext) : await safeStorage.encryptStringAsync(op.plaintext);
      fs.mkdirSync(path.dirname(secretsPath), { recursive: true });
      fs.writeFileSync(`${secretsPath}.tmp`, blob);
      fs.renameSync(`${secretsPath}.tmp`, secretsPath);
      return { prefix: blob.subarray(0, 3).toString('latin1'), bytes: blob.length };
    }
    case 'rawRead':
      try {
        const { result, shouldReEncrypt } = await safeStorage.decryptStringAsync(fs.readFileSync(secretsPath));
        return { plaintext: result, shouldReEncrypt };
      } catch (error) {
        return { error: 'decrypt' };
      }
    default:
      throw new Error(`unknown operation ${op.op}`);
  }
}

async function run() {
  secrets.initSecretsPath(app.getPath('userData'));
  const results = [];
  for (const op of JSON.parse(fs.readFileSync(opsFile, 'utf8'))) results.push(await apply(op));
  return results;
}

app.whenReady()
  .then(run)
  .then(
    results => {
      process.stdout.write(`${JSON.stringify(results)}\n`);
      // quit, not exit: app.exit() right after the first key creation skips the Local State commit.
      app.quit();
    },
    error => {
      process.stderr.write(`${error.stack ?? error}\n`);
      app.exit(1);
    }
  );
