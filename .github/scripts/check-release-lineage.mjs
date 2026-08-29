import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const FULL_SHA = /^[0-9a-f]{40}$/;
const RELEASE_TAG = /^v\d+\.\d+\.\d+-(?:alpha|beta|rc)\.[1-9]\d*$/;

export function parseRemoteTag(output, tag) {
  if (!RELEASE_TAG.test(tag)) throw new Error(`invalid release tag: ${tag}`);
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const values = new Map();

  for (const line of String(output).trim().split(/\r?\n/).filter(Boolean)) {
    const match = /^([0-9a-f]{40})\s+(.+)$/.exec(line);
    if (!match || (match[2] !== directRef && match[2] !== peeledRef)) {
      throw new Error(`unexpected ls-remote output: ${line}`);
    }
    if (values.has(match[2]) && values.get(match[2]) !== match[1]) {
      throw new Error(`conflicting remote values for ${match[2]}`);
    }
    values.set(match[2], match[1]);
  }

  // An annotated tag's direct ref names a tag object; ^{} is the commit it
  // ultimately peels to. A lightweight tag has only the direct ref.
  const resolved = values.get(peeledRef) ?? values.get(directRef);
  if (!resolved) throw new Error(`remote tag is missing: ${tag}`);
  return resolved;
}

function argument(name, fallback = null) {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : process.argv[index + 1];
}

function git(args, options = {}) {
  return execFileSync('git', args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function authenticatedGitEnvironment(remote, tokenEnvironmentName) {
  const env = { ...process.env };
  if (!tokenEnvironmentName) return env;
  const token = process.env[tokenEnvironmentName];
  if (!token) throw new Error(`${tokenEnvironmentName} is required for remote verification`);
  const remoteUrl = git(['remote', 'get-url', remote]);
  let parsed;
  try { parsed = new URL(remoteUrl); } catch { throw new Error(`authenticated remote must be an HTTPS URL: ${remoteUrl}`); }
  if (parsed.protocol !== 'https:') throw new Error(`authenticated remote must use HTTPS: ${remoteUrl}`);

  // Supply the token only to this git child through an ephemeral config entry;
  // do not write it into .git/config or expose it as a command-line URL.
  const count = Number.parseInt(env.GIT_CONFIG_COUNT ?? '0', 10);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('invalid inherited GIT_CONFIG_COUNT');
  env.GIT_CONFIG_COUNT = String(count + 1);
  env[`GIT_CONFIG_KEY_${count}`] = `http.${parsed.protocol}//${parsed.host}/.extraheader`;
  env[`GIT_CONFIG_VALUE_${count}`] = `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`;
  delete env[tokenEnvironmentName];
  return env;
}

export function verifyLocalLineage({ eventSha, tag, mainRef }) {
  if (!FULL_SHA.test(eventSha)) throw new Error(`event SHA is not a full commit SHA: ${eventSha}`);
  if (!RELEASE_TAG.test(tag)) throw new Error(`invalid release tag: ${tag}`);
  const eventCommit = git(['rev-parse', '--verify', `${eventSha}^{commit}`]);
  if (eventCommit !== eventSha) throw new Error(`event SHA does not resolve to itself: ${eventCommit}`);
  const mainCommit = git(['rev-parse', '--verify', `${mainRef}^{commit}`]);
  if (!FULL_SHA.test(mainCommit)) throw new Error(`trusted main ref is invalid: ${mainRef}`);
  const ancestry = spawnSync('git', ['merge-base', '--is-ancestor', eventSha, mainRef], {
    cwd: process.cwd(), stdio: 'ignore',
  });
  if (ancestry.status !== 0) {
    throw new Error(ancestry.status === 1
      ? `${eventSha} is not reachable from ${mainRef}`
      : `git merge-base failed with status ${ancestry.status}`);
  }
  const localTagCommit = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`]);
  if (localTagCommit !== eventSha) {
    throw new Error(`local tag peels to ${localTagCommit}, expected event SHA ${eventSha}`);
  }
  return { eventCommit, mainCommit, localTagCommit };
}

export function verifyRemoteTag({ eventSha, tag, remote, tokenEnvironmentName }) {
  if (!FULL_SHA.test(eventSha)) throw new Error(`event SHA is not a full commit SHA: ${eventSha}`);
  if (!RELEASE_TAG.test(tag)) throw new Error(`invalid release tag: ${tag}`);
  const env = authenticatedGitEnvironment(remote, tokenEnvironmentName);
  const output = git([
    'ls-remote', '--tags', remote,
    `refs/tags/${tag}`,
    `refs/tags/${tag}^{}`,
  ], { env });
  const remoteCommit = parseRemoteTag(output, tag);
  if (remoteCommit !== eventSha) {
    throw new Error(`remote tag peels to ${remoteCommit}, expected event SHA ${eventSha}`);
  }
  return remoteCommit;
}

async function main() {
  const eventSha = argument('--event-sha', process.env.GITHUB_SHA);
  const tag = argument('--tag', process.env.GITHUB_REF_NAME);
  const mainRef = argument('--main-ref', 'refs/remotes/origin/main');
  const remote = argument('--remote', 'origin');
  const tokenEnvironmentName = argument('--token-env');
  if (!eventSha || !tag) throw new Error('event SHA and release tag are required');

  const local = verifyLocalLineage({ eventSha, tag, mainRef });
  const remoteCommit = verifyRemoteTag({ eventSha, tag, remote, tokenEnvironmentName });
  console.log(`RELEASE_LINEAGE_VERIFIED event=${local.eventCommit} main=${local.mainCommit} remoteTag=${remoteCommit}`);
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main().catch((error) => {
    console.error('RELEASE_LINEAGE_BLOCKED');
    console.error(`- ${error.message}`);
    process.exit(1);
  });
}
