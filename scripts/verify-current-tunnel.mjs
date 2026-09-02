import { pathToFileURL } from 'node:url';
import { TUNNEL_CLIENT } from './packaging-versions.mjs';

const DEFAULT_API = 'https://api.github.com';
const UPSTREAM_REPOSITORY = 'openai/tunnel-client';

export async function assertCurrentTunnelRelease({
  pinnedVersion = TUNNEL_CLIENT.version,
  token,
  fetchImpl = fetch,
  apiBase = DEFAULT_API
} = {}) {
  if (!/^v\d+\.\d+\.\d+$/.test(pinnedVersion)) {
    throw new Error(`Pinned tunnel-client version is invalid: ${JSON.stringify(pinnedVersion)}`);
  }

  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'chat-on-steroids-release-preflight'
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetchImpl(
    `${apiBase.replace(/\/$/, '')}/repos/${UPSTREAM_REPOSITORY}/releases/latest`,
    { headers }
  );
  if (!response.ok) {
    const body = (await response.text()).trim().replace(/\s+/g, ' ').slice(0, 500);
    throw new Error(
      `OpenAI tunnel-client release lookup failed with HTTP ${response.status}${body ? `: ${body}` : ''}; refusing to publish without proving the pin is current.`
    );
  }

  const release = await response.json();
  const latestVersion = release?.tag_name;
  if (!/^v\d+\.\d+\.\d+$/.test(latestVersion) || release.draft || release.prerelease) {
    throw new Error('OpenAI tunnel-client latest-release response was not a stable semantic-version release.');
  }
  if (latestVersion !== pinnedVersion) {
    throw new Error(
      `Pinned tunnel-client ${pinnedVersion} is stale; OpenAI's current release is ${latestVersion}. Update packaging-versions.mjs and its six checksums before publishing.`
    );
  }

  return release;
}

async function main() {
  const release = await assertCurrentTunnelRelease({
    token: process.env.GH_TOKEN || process.env.GITHUB_TOKEN
  });
  process.stdout.write(`Pinned tunnel-client ${TUNNEL_CLIENT.version} matches OpenAI's current release (${release.html_url ?? UPSTREAM_REPOSITORY}).\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
