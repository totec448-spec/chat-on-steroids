// The platforms a release candidate packages, read from .github/release-targets.json.
//
// `all` is every target and is what a release builds. `common` is the targets most installs use,
// measured by release downloads (2.1.25: Windows x64 1066, macOS arm64 73, Linux x64 69, each other
// target under 10); canaries build only those. Usage in a workflow:
//   node scripts/release-targets.mjs <all|common>   -> `include` and `files` in $GITHUB_OUTPUT
import { appendFileSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ALWAYS = ['Chat-On-Steroids-Extension.zip', 'Chat-On-Steroids-Native-Sources.tar.gz'];

export function releaseTargets(platforms = 'all', targets = JSON.parse(readFileSync(new URL('../.github/release-targets.json', import.meta.url), 'utf8'))) {
  if (platforms !== 'all' && platforms !== 'common') throw new Error(`platforms must be all or common, got ${platforms}`);
  const chosen = targets.filter(target => platforms === 'all' || target.common === true);
  return {
    include: chosen.map(({ common, files, ...target }) => ({ ...target, files: files.map(file => `release/${file}`).join('\n') })),
    files: [...chosen.flatMap(target => target.files), ...ALWAYS]
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { include, files } = releaseTargets(process.argv[2] || 'all');
  const output = `include=${JSON.stringify(include)}\nfiles=${files.join(' ')}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, output);
  process.stdout.write(output);
}
