import { pathToFileURL } from 'node:url';

const DEFAULT_API = 'https://api.github.com';

export async function assertReleaseAbsent({
  repository,
  tag,
  token,
  fetchImpl = fetch,
  apiBase = DEFAULT_API
}) {
  if (!repository || !repository.includes('/')) throw new Error('GITHUB_REPOSITORY is missing or invalid');
  if (!tag) throw new Error('Release tag is missing');
  if (!token) throw new Error('GH_TOKEN is missing');

  const response = await fetchImpl(
    `${apiBase.replace(/\/$/, '')}/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'chat-on-steroids-release-preflight'
      }
    }
  );

  if (response.status === 404) return;
  if (response.status === 200) {
    throw new Error(`Release ${tag} already exists; refusing to overwrite it.`);
  }

  const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500);
  throw new Error(
    `GitHub release lookup failed with HTTP ${response.status}${body ? `: ${body}` : ''}; refusing to assume the release is absent.`
  );
}

async function main() {
  await assertReleaseAbsent({
    repository: process.env.GITHUB_REPOSITORY,
    tag: process.env.TAG || process.env.GITHUB_REF_NAME,
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  });
  process.stdout.write(`Release ${process.env.TAG || process.env.GITHUB_REF_NAME} does not exist yet.\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
