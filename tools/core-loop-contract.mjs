import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SCHEMA_VERSION = '1.0.0';
export const HARNESS_VERSION = 'core-loop-harness-v1';

export const FAILURE_CLASSES = Object.freeze([
  'CI_SOURCE_CONTRACT',
  'CI_HOST_LAYOUT_ASSUMPTION',
  'PACKAGED_NOTICE_MISSING',
  'PACKAGED_NOTICE_STALE',
  'ASAR_MANIFEST_DRIFT',
  'INPUT_BUDGET_REJECTED',
  'UNSUPPORTED_COMPLEX_BACKGROUND',
  'SUBJECT_EXTRACTION_FAILURE',
  'SUBJECT_EXTRACTION_UNCERTAIN',
  'FACE_OR_PARTS_DETECTION_FAILURE',
  'MANUAL_FIX_REQUIRED',
  'PIXELIZE_FAILURE',
  'PREVIEW_FAILURE',
  'PERSISTENCE_FAILURE',
  'SPAWN_FAILURE',
  'RESTART_RECOVERY_FAILURE',
  'RUNTIME_COMPOSITION_FAILURE',
  'PERFORMANCE_REGRESSION',
  'TEST_FIXTURE_ERROR',
  'ENVIRONMENT_FAILURE',
  'HUMAN_EVIDENCE_UNAVAILABLE',
  'RIGHTS_OR_PROVENANCE_BLOCKED',
]);

export const INPUT_BUCKETS = Object.freeze(['supported', 'recovery', 'unsupported']);
export const OUTCOMES = Object.freeze(['success', 'recovered', 'rejected', 'failed']);
export const ACTORS = Object.freeze(['automation', 'human']);
export const EVIDENCE_KINDS = Object.freeze([
  'synthetic-auxiliary',
  'automated-engineering',
  'human-product',
]);
export const RIGHTS_STATUSES = Object.freeze([
  'project-synthetic',
  'rights-cleared',
  'unverified',
  'blocked',
]);
const LOGICAL_CPU_BUCKETS = Object.freeze(['1-2', '3-4', '5-8', '9-16', '17-32', '>32']);
const MEMORY_GIB_BUCKETS = Object.freeze(['0-4', '5-8', '9-16', '17-32', '33-64', '>64']);
const NODE_ARCHES = Object.freeze([
  'x64', 'arm64', 'ia32', 'arm', 'ppc64', 's390x', 'riscv64', 'loong64',
]);
const PIXELIZE_PRESET_NAMES = Object.freeze(['original', 'soft', 'classic', 'chunky', 'tiny']);
const EXTRACTOR_MODES = Object.freeze(['alpha', 'chroma', 'none']);

export const PERFORMANCE_PROTOCOL = Object.freeze({
  petCounts: Object.freeze([1, 3, 6]),
  repetitions: 3,
  warmupMs: 30_000,
  idleMs: 60_000,
  activeMs: 60_000,
  recoveryMs: 30_000,
  soakPets: 6,
  soakWarmupMs: 10 * 60_000,
  soakMs: 60 * 60_000,
  sampleIntervalMs: 1_000,
  longFrameMultiplier: 2,
  eventLoopStallMs: 100,
  relativeRegression: 0.20,
  longFrameRatePoints: 1,
  bootstrapSamples: 10_000,
  bootstrapSeed: 0x4b5454,
});

const moduleDir = path.dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = path.resolve(moduleDir, '..');
export const ARTIFACTS_ROOT = path.join(PROJECT_ROOT, '.artifacts', 'core-loop');

const CASE_KEYS = new Set([
  'schemaVersion', 'runId', 'gitSha', 'platform', 'nodeVersion', 'electronVersion',
  'hardwareClass', 'evidenceKind', 'actor', 'caseId', 'inputBucket', 'width',
  'height', 'frameCount', 'chosenPreset', 'extractorMode', 'timings',
  'fixesNeeded', 'scriptedFixes', 'outcome', 'failureClass', 'failures',
  'recoveryUsed', 'warnings', 'harnessVersion', 'claimEligible', 'rightsStatus',
]);

const TIMING_KEYS = new Set([
  'clock', 'markersMs', 'pipelineMs', 'timeToSourcePreviewMs', 'timeToProcessedPreviewMs',
  'createToPetReadyMs', 'systemTimeToPetMs', 'humanEndToEndTimeMs',
]);
const CLOCK_KEYS = new Set(['mode', 'calibrationUncertaintyMs']);
const CLOCK_MODES = Object.freeze([
  'main-receipt-monotonic', 'calibrated-cross-process', 'unavailable',
]);
const MARKER_KEYS = new Set(['T0', 'T1', 'T2', 'T3', 'T4', 'T5', 'T6']);
const FAILURE_KEYS = new Set([
  'class', 'stage', 'recoverable', 'supportedScope', 'errorCode', 'claimImpact',
]);
const PLATFORM_KEYS = new Set(['os', 'arch']);
const HARDWARE_KEYS = new Set(['logicalCpuBucket', 'memoryGiBBucket']);

const SUMMARY_KEYS = Object.freeze([
  'schemaVersion', 'generatedAt', 'gitSha', 'branch', 'pr', 'ciRun',
  'engineeringVerdict', 'productVerdict', 'evidenceBoundaries', 'testCommands',
  'testResults', 'packageResults', 'managerScenarios', 'corpusCounts',
  'humanTrialCounts', 'timingSummary', 'performanceSummary', 'failureCounts',
  'rightsStatus', 'nativePlatformStatus', 'remainingGates', 'commits', 'nextAction',
  'acceptanceBinding',
]);
const SUMMARY_REQUIRED_KEYS = new Set(SUMMARY_KEYS.filter(key => key !== 'acceptanceBinding'));

const TEST_RESULT_KEYS = new Set([
  'command', 'status', 'exitCode', 'passed', 'failed', 'rejected', 'total',
  'durationMs', 'evidence', 'boundary', 'firstProcess', 'restartProcess',
]);
const PHASE_RESULT_KEYS = new Set(['passed', 'failed', 'total', 'durationMs']);
const PACKAGE_RESULT_KEYS = new Set([
  'platform', 'command', 'status', 'verifyStatus', 'artifactCount',
  'noticeStatus', 'asarStatus', 'boundary',
]);
const MANAGER_SCENARIO_KEYS = new Set([
  'name', 'status', 'passed', 'total', 'timings', 'failureClass', 'boundary',
]);
const COMMIT_KEYS = new Set(['sha', 'purpose']);
const CI_RUN_KEYS = new Set(['url', 'gitSha', 'jobs']);
const CI_JOB_KEYS = new Set(['name', 'status']);
const ACCEPTANCE_BINDING_KEYS = new Set([
  'bindingVersion', 'subjectGitSha', 'reportCarrierMode',
  'ciEvidenceDigest', 'performanceEvidenceDigest',
]);
const ACCEPTANCE_EVIDENCE_KEYS = new Set(['ciBundle', 'performanceBundle']);
const ACCEPTANCE_CI_BUNDLE_KEYS = new Set(['ciRun']);
const ACCEPTANCE_PERFORMANCE_BUNDLE_KEYS = new Set([
  'evidenceBinding', 'comparisonProjection',
]);

const CORPUS_COUNT_KEYS = new Set([
  'supported', 'recovery', 'unsupported', 'rightsClearedSupported',
  'rightsClearedSupportedCompleted', 'rightsClearedSupportedCompletedWithinOneFix',
  'syntheticAuxiliary', 'syntheticByBucket',
]);
const HUMAN_TRIAL_COUNT_KEYS = new Set(['participants', 'completed', 'within60Seconds']);
const TIMING_SUMMARY_KEYS = new Set([
  'automatedPipelineOnly', 'humanEndToEndTimeMs', 'timeToPetAvailable',
]);
const NATIVE_PLATFORM_KEYS = new Set(['windows', 'macos', 'signingNotarization']);
const SYNTHETIC_BUCKET_KEYS = new Set(INPUT_BUCKETS);
const PERFORMANCE_SUMMARY_KEYS = new Set([
  'hardwareClass', 'sourceDirty', 'provenance', 'protocolQualified', 'protocol',
  'byTopology', 'soak', 'evidenceBinding',
]);
const PERFORMANCE_SUMMARY_REQUIRED_KEYS = new Set([
  'hardwareClass', 'sourceDirty', 'provenance', 'protocolQualified', 'protocol',
  'byTopology', 'soak',
]);
const PERFORMANCE_PROVENANCE_KEYS = new Set([
  'identityVersion', 'appGitSha', 'harnessGitSha', 'harnessSourceClean',
  'harnessVersion', 'performanceHarnessVersion', 'comparisonVersion', 'probeIdentity',
  'probeSourceSha256', 'fixtureIdentity', 'settingsIdentity', 'protocolIdentity',
  'environmentIdentity', 'driverNodeVersion', 'electronVersion', 'electronNodeVersion',
]);
const PERFORMANCE_PROTOCOL_KEYS = new Set([
  'petCounts', 'repetitions', 'warmupMs', 'idleMs', 'activeMs', 'recoveryMs',
  'soakPets', 'soakWarmupMs', 'soakMs', 'sampleIntervalMs',
]);
const PERFORMANCE_TOPOLOGY_KEYS = new Set([
  'samples', 'meanMainCpuPercent', 'meanRendererCpuPercent', 'peakMainMemoryMiB',
  'peakRendererMemoryMiB', 'frameIntervalP50Ms', 'frameIntervalP95Ms',
  'frameIntervalP99Ms', 'frameIntervalSampleCount', 'frameIntervalOverflowCount',
  'renderWorkP95Ms', 'activeLongFrameRate', 'eventLoopStalls', 'crashes',
  'unhandledErrors', 'postDestroyPetCountMax', 'postDestroyWindowCountMax',
  'postDestroyTimerDeltaMax', 'postDestroyListenerDeltaMax',
]);
const PERFORMANCE_SOAK_KEYS = new Set([
  'samples', 'durationMs', 'memoryTrend', 'crashes', 'unhandledErrors',
  'resourceTrend', 'comparisonToPreChange',
]);
const PERFORMANCE_COMPARISON_PROJECTION_KEYS = new Set([
  'comparisonVersion', 'status', 'claimEligible', 'regressionDetected',
  'sameMachineAttested', 'beforeGitSha', 'afterGitSha',
]);
const PERFORMANCE_EVIDENCE_BINDING_KEYS = new Set([
  'bindingVersion', 'samplesSha256', 'sampleCount', 'beforeSamplesSha256',
  'beforeSampleCount', 'afterSamplesSha256', 'afterSampleCount',
  'comparisonArtifactSha256', 'pairedBlockCount', 'metricResultCount',
  'hardCheckCount',
]);
const MEMORY_TREND_KEYS = new Set([
  'status', 'combinedMemoryTheilSenMiBPerMinute',
  'combinedMemoryTheilSenLower95MiBPerMinute', 'firstTenMinuteMedianMiB',
  'lastTenMinuteMedianMiB', 'lastMinusFirstMedianMiB', 'bootstrapSamples',
  'bootstrapSeed', 'regressionDetected',
]);
const RESOURCE_TREND_KEYS = new Set([
  'status', 'timerFirstWindowMedianDelta', 'timerLastWindowMedianDelta',
  'listenerFirstWindowMedianDelta', 'listenerLastWindowMedianDelta',
  'timerTheilSenDeltaPerMinute', 'listenerTheilSenDeltaPerMinute',
  'sustainedGrowthDetected',
]);

const ENGINEERING_VERDICTS = Object.freeze([
  'PARTIAL_VERIFIED', 'CORE_LOOP_ENGINEERING_ACCEPTED', 'NO_GO',
]);
const PRODUCT_VERDICTS = Object.freeze([
  'HUMAN_REQUIRED', 'CORE_LOOP_PRODUCT_VALIDATED', 'NO_GO',
]);
const SUMMARY_RIGHTS_STATUSES = Object.freeze([
  'RIGHTS_OR_PROVENANCE_BLOCKED', 'PARTIALLY_RIGHTS_CLEARED', 'RIGHTS_CLEARED',
]);
const RESULT_STATUSES = Object.freeze([
  'PASS', 'FAIL', 'PARTIAL', 'NOT_RUN', 'UNAVAILABLE', 'SKIPPED',
]);
const CI_JOB_STATUSES = Object.freeze([
  'PASS', 'FAIL', 'IN_PROGRESS', 'CANCELLED', 'SKIPPED',
]);
const NATIVE_EVIDENCE_STATUSES = Object.freeze([
  'UNVERIFIED', 'UNVERIFIED_FOR_THIS_MILESTONE', 'SOURCE_ELECTRON_SMOKE_ONLY',
  'HOSTED_CI_VERIFIED', 'HOSTED_PACKAGE_VERIFIED', 'NATIVE_PACKAGE_VERIFIED',
]);
const SIGNING_STATUSES = Object.freeze([
  'UNVERIFIED', 'UNSIGNED', 'SIGNED', 'SIGNED_AND_NOTARIZED', 'NOT_APPLICABLE',
]);
const ACCEPTED_TEST_COMMANDS = Object.freeze([
  'npm test', 'npm run test:manager', 'npm run test:click', 'npm run test:multi',
  'npm run test:packaging', 'npm run test:security', 'npm run test:release',
]);
const ACCEPTED_MANAGER_SCENARIOS = Object.freeze([
  'single-flight-exact-runtime', 'restart-exact-character',
  'draft-retention-recovery', 'first-frame-before-success',
]);
const ACCEPTED_CI_ROLES = Object.freeze([
  'test:ubuntu', 'test:macos', 'test:windows', 'audit',
  'package:macos', 'package:windows',
]);
const EVIDENCE_APP_COMMIT_PURPOSE = 'CORE_LOOP_EVIDENCE_APP_SHA';
const REPORT_CARRIER_COMMIT_PURPOSES = new Set([
  'DOCS_ONLY_REPORT_CARRIER_ANCESTOR_ATTESTATION',
  'DOCS_ONLY_REPORT_CARRIER_DESCENDANT_ATTESTATION',
]);
const EVIDENCE_SHA_BOUNDARY = 'SUMMARY_GIT_SHA_IS_EVIDENCE_APP_SHA_NOT_REPORT_CARRIER';

const FORBIDDEN_CASE_KEYS = new Set([
  'filename', 'fileName', 'sourceFile', 'sourceFilename', 'path', 'absolutePath',
  'home', 'homeDirectory', 'username', 'userName', 'characterName', 'image',
  'imageBytes', 'bytes', 'thumbnail', 'original', 'fileHash', 'sha256', 'exif',
  'deviceId', 'deviceIdentifier', 'ip', 'ipAddress', 'networkAddress', 'url',
]);
const NORMALIZED_FORBIDDEN_KEYS = new Set(
  [...FORBIDDEN_CASE_KEYS].map(key => key.replace(/[^a-z0-9]/gi, '').toLowerCase()),
);

const PRIVATE_STRING_PATTERNS = Object.freeze([
  { label: 'URL', pattern: /\b[a-z][a-z0-9+.-]{0,20}:\/\/|\bwww\.|\bmailto:/i },
  {
    label: 'URL',
    pattern: /\b(?:data|blob|javascript|ssh|sftp|ftp|ftps|ws|wss|tel|urn):/i,
  },
  {
    label: 'encoded image bytes',
    pattern: /\b(?:iVBORw0KGgo|R0lGOD(?:lh|dh)|UklGR|\/9j\/)[A-Za-z0-9+/=_-]*/,
  },
  { label: 'file URL', pattern: /file:\/\//i },
  { label: 'Windows path', pattern: /(?:^|[^A-Za-z0-9._~-])(?:[A-Za-z]:[\\/]|\\\\)[^\s"'`)]*/i },
  { label: 'relative path', pattern: /(?:^|[^A-Za-z0-9._~-])\.{1,2}[\\/][^\s"'`)]*/i },
  { label: 'relative path', pattern: /(?:^|[^A-Za-z0-9._~-])[^\s"'`(\\/]+\\[^\s"'`)]*/i },
  {
    label: 'relative path',
    pattern: /(?:^|[^A-Za-z0-9._~-])(?:users?|home|tmp|private|var|etc|src|tests?|tools|docs|assets|images?|photos?|inputs?|outputs?|downloads?|desktop|documents)[\\/][^\s"'`)]*/i,
  },
  { label: 'home-relative path', pattern: /(?:^|[^A-Za-z0-9._~-])~[\\/][^\s"'`)]*/i },
  { label: 'POSIX path', pattern: /(?:^|[^A-Za-z0-9._~-])\/(?!\/)[^\s"'`)]*/i },
  {
    label: 'URL',
    pattern: /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}(?::\d{1,5})?(?:\/|\b)/i,
  },
  { label: 'network address', pattern: /\blocalhost(?::\d{1,5})?\b/i },
  {
    label: 'IP address',
    pattern: /\b(?:(?:25[0-5]|2[0-4]\d|1?\d?\d)\.){3}(?:25[0-5]|2[0-4]\d|1?\d?\d)(?::\d{1,5})?\b/,
  },
  { label: 'IPv6 address', pattern: /\b(?:[0-9a-f]{1,4}:){3,7}[0-9a-f]{0,4}\b/i },
  { label: 'IPv6 address', pattern: /(?:\b[0-9a-f]{1,4})?::(?:[0-9a-f]{0,4}:?){0,7}\b/i },
  { label: 'email address', pattern: /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i },
  {
    label: 'filename',
    pattern: /(?:^|[\s"'`(])[^\s"'`()\\/]{1,160}\.[a-z][a-z0-9]{0,15}(?=$|[\s"'`),;:])/i,
  },
  {
    label: 'filename',
    pattern: /(?:^|[\s"'`(])\.[a-z][a-z0-9_.-]{0,80}(?=$|[\s"'`),;:])/i,
  },
  {
    label: 'filename',
    pattern: /(?:^|[^A-Za-z0-9._~-])[^\s"'`()\\/]{1,160}\.(?:7z|3mf|3ds)(?=$|[^A-Za-z0-9])/i,
  },
  {
    label: 'filename',
    pattern: /\b(?:file(?:name)?|sourceFile|inputFile)\s*(?:=|:|\bis\b)\s*[^\s"'`]{1,160}\b/i,
  },
  {
    label: 'username',
    pattern: /\b(?:username|login|account(?:Name)?|homeDirectory)\s*(?:(?:=|:|\bis\b)\s*)?[A-Za-z0-9_.@-]{1,128}\b|\buser\s*(?:=|:|\bis\b)\s*[A-Za-z0-9_.@-]{1,128}\b/i,
  },
  {
    label: 'username',
    pattern: /(?:用户名|账户名|登录名|主目录)\s*(?:[=：:]|是)\s*[^\s，。；;]{1,128}/,
  },
]);

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function fail(message) {
  const error = new Error(message);
  error.code = 'POPPET_CORE_LOOP_SCHEMA';
  throw error;
}

function exactKeys(value, allowed, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) fail(`${label} contains unknown key: ${key}`);
  }
}

function requireKeys(value, required, label) {
  if (!isPlainObject(value)) fail(`${label} must be an object`);
  for (const key of required) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) fail(`${label} is missing key: ${key}`);
  }
}

function exactRequiredKeys(value, keys, label) {
  exactKeys(value, keys, label);
  requireKeys(value, keys, label);
}

function finiteOrNull(value, label) {
  if (value === null) return;
  if (!Number.isFinite(value) || value < 0) fail(`${label} must be null or a non-negative number`);
}

function finiteNumberOrNull(value, label) {
  if (value === null) return;
  if (!Number.isFinite(value)) fail(`${label} must be null or a finite number`);
}

function integerInRange(value, min, max, label) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer in ${min}..${max}`);
  }
}

function enumValue(value, allowed, label) {
  if (!allowed.includes(value)) fail(`${label} is invalid: ${String(value)}`);
}

function boundedString(value, label, { min = 1, max = 256, pattern = null, nullable = false } = {}) {
  if (nullable && value === null) return;
  if (typeof value !== 'string' || value.length < min || value.length > max
      || (pattern && !pattern.test(value))) fail(`${label} is invalid`);
}

function privateStringReason(value) {
  if (typeof value !== 'string') return null;
  for (const rule of PRIVATE_STRING_PATTERNS) {
    if (rule.pattern.test(value)) return rule.label;
  }
  return null;
}

function assertPrivacySafeString(value, label, { allowEvidenceUrl = false } = {}) {
  if (typeof value !== 'string') return;
  if (allowEvidenceUrl
      && /^https:\/\/github\.com\/SioYooo\/poppet\/(?:pull|actions\/runs)\/\d+$/.test(value)) {
    return;
  }
  const reason = privateStringReason(value);
  if (reason) fail(`${label} contains a private ${reason}`);
}

function isForbiddenPrivateKey(key) {
  const normalized = String(key).replace(/[^a-z0-9]/gi, '').toLowerCase();
  return NORMALIZED_FORBIDDEN_KEYS.has(normalized);
}

function dataOnlyArrayEntries(value, label) {
  const ownKeys = Reflect.ownKeys(value);
  const entries = [];
  for (const key of ownKeys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !/^(?:0|[1-9]\d*)$/.test(key)
        || Number(key) >= value.length) {
      fail(`${label} contains a custom array property`);
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}[${key}] must be a plain data value`);
    }
  }
  for (let index = 0; index < value.length; index++) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) {
      fail(`${label} cannot contain sparse array entries`);
    }
    entries.push([index, Object.getOwnPropertyDescriptor(value, String(index)).value]);
  }
  return entries;
}

function dataOnlyObjectEntries(value, label) {
  const entries = [];
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') fail(`${label} contains a symbol property`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !descriptor.enumerable
        || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
      fail(`${label}.${key} must be an enumerable plain data value`);
    }
    entries.push([key, descriptor.value]);
  }
  return entries;
}

function canonicalJson(value, label = 'evidence bundle') {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail(`${label} contains a non-finite number`);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    const entries = dataOnlyArrayEntries(value, label);
    return `[${entries.map(([index, entry]) => canonicalJson(entry, `${label}[${index}]`)).join(',')}]`;
  }
  if (!isPlainObject(value)) fail(`${label} must contain only JSON data`);
  const entries = dataOnlyObjectEntries(value, label)
    .sort(([left], [right]) => left < right ? -1 : (left > right ? 1 : 0));
  return `{${entries.map(([key, entry]) =>
    `${JSON.stringify(key)}:${canonicalJson(entry, `${label}.${key}`)}`).join(',')}}`;
}

export function acceptanceEvidenceDigest(kind, bundle) {
  enumValue(kind, ['ci', 'performance'], 'acceptance evidence digest kind');
  return crypto.createHash('sha256')
    .update(`poppet-core-loop-${kind}-evidence-bundle-v2\0`, 'utf8')
    .update(canonicalJson(bundle, `${kind} evidence bundle`), 'utf8')
    .digest('hex');
}

export function sanitizeDiagnosticText(value) {
  const text = String(value ?? '').slice(0, 2_000);
  return privateStringReason(text)
    ? '[redacted-diagnostic]'
    : text.slice(0, 500);
}

function validateNoPrivatePayload(value, label = 'case') {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail(`${label} contains image or binary bytes`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of dataOnlyArrayEntries(value, label)) {
      validateNoPrivatePayload(entry, `${label}[${index}]`);
    }
    return;
  }
  if (typeof value === 'string') {
    assertPrivacySafeString(value, label);
    return;
  }
  if (!isPlainObject(value)) return;
  for (const [key, entry] of dataOnlyObjectEntries(value, label)) {
    if (isForbiddenPrivateKey(key)) fail(`${label} contains forbidden private key: ${key}`);
    validateNoPrivatePayload(entry, `${label}.${key}`);
  }
}

export function currentGitSha(root = PROJECT_ROOT) {
  try {
    const value = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[0-9a-f]{40}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function currentGitBranch(root = PROJECT_ROOT) {
  try {
    const value = execFileSync('git', ['branch', '--show-current'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return /^[A-Za-z0-9._/-]{1,200}$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export function currentGitDirty(root = PROJECT_ROOT) {
  try {
    const value = execFileSync('git', ['status', '--porcelain', '--untracked-files=normal'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return value.trim().length > 0;
  } catch {
    return null;
  }
}

function bucketFor(value, edges, suffix) {
  for (const [limit, label] of edges) if (value <= limit) return `${label}${suffix}`;
  return `>${edges.at(-1)[0]}${suffix}`;
}

export function summarizeHardwareClass({ logicalCpuCount, totalMemoryBytes }) {
  const logical = logicalCpuCount || 1;
  const gib = totalMemoryBytes / (1024 ** 3);
  return {
    logicalCpuBucket: bucketFor(logical, [[2, '1-2'], [4, '3-4'], [8, '5-8'], [16, '9-16'], [32, '17-32']], ''),
    memoryGiBBucket: bucketFor(gib, [[4, '0-4'], [8, '5-8'], [16, '9-16'], [32, '17-32'], [64, '33-64']], ''),
  };
}

export function coarseHardwareClass() {
  return summarizeHardwareClass({
    logicalCpuCount: os.cpus()?.length || 1,
    totalMemoryBytes: os.totalmem(),
  });
}

export function emptyTimings({ pipelineMs = null } = {}) {
  return {
    clock: { mode: 'unavailable', calibrationUncertaintyMs: null },
    markersMs: { T0: null, T1: null, T2: null, T3: null, T4: null, T5: null, T6: null },
    pipelineMs,
    timeToSourcePreviewMs: null,
    timeToProcessedPreviewMs: null,
    createToPetReadyMs: null,
    systemTimeToPetMs: null,
    humanEndToEndTimeMs: null,
  };
}

function equalDuration(actual, expected) {
  if (actual === expected) return true;
  if (!Number.isFinite(actual) || !Number.isFinite(expected)) return false;
  const scale = Math.max(1, Math.abs(actual), Math.abs(expected));
  return Math.abs(actual - expected) <= Number.EPSILON * scale * 8;
}

function validateDerivedDuration(timings, key, markerNames, derive) {
  const markers = markerNames.map(name => timings.markersMs[name]);
  const available = markers.every(Number.isFinite);
  if (!available) {
    if (timings[key] !== null) fail(`timings.${key} must be null when a required marker is missing`);
    return;
  }
  const expected = derive(...markers);
  if (!equalDuration(timings[key], expected)) {
    fail(`timings.${key} must equal its marker-derived duration`);
  }
}

function validateTimings(timings) {
  exactRequiredKeys(timings, TIMING_KEYS, 'timings');
  exactRequiredKeys(timings.clock, CLOCK_KEYS, 'timings.clock');
  enumValue(timings.clock.mode, CLOCK_MODES, 'timings.clock.mode');
  finiteOrNull(timings.clock.calibrationUncertaintyMs,
    'timings.clock.calibrationUncertaintyMs');
  if (timings.clock.mode === 'unavailable'
      && timings.clock.calibrationUncertaintyMs !== null) {
    fail('unavailable clock cannot report calibration uncertainty');
  }
  if (timings.clock.mode === 'main-receipt-monotonic'
      && timings.clock.calibrationUncertaintyMs !== 0) {
    fail('main-receipt-monotonic clock uncertainty must be 0');
  }
  if (timings.clock.mode === 'calibrated-cross-process'
      && timings.clock.calibrationUncertaintyMs === null) {
    fail('calibrated-cross-process clock requires uncertainty');
  }
  exactRequiredKeys(timings.markersMs, MARKER_KEYS, 'timings.markersMs');
  let previous = -Infinity;
  for (const key of MARKER_KEYS) {
    const value = timings.markersMs[key];
    finiteOrNull(value, `timings.markersMs.${key}`);
    if (value !== null) {
      if (value < previous) fail('timing markers must be monotonic');
      previous = value;
    }
  }
  for (const key of TIMING_KEYS) {
    if (key !== 'clock' && key !== 'markersMs') finiteOrNull(timings[key], `timings.${key}`);
  }
  if (timings.clock.mode === 'unavailable') {
    const crossProcessValues = [
      ...Object.values(timings.markersMs),
      timings.timeToSourcePreviewMs,
      timings.timeToProcessedPreviewMs,
      timings.createToPetReadyMs,
      timings.systemTimeToPetMs,
      timings.humanEndToEndTimeMs,
    ];
    if (crossProcessValues.some(value => value !== null)) {
      fail('uncalibrated cross-process timing must remain unavailable');
    }
  }
  validateDerivedDuration(timings, 'timeToSourcePreviewMs', ['T0', 'T1'],
    (T0, T1) => T1 - T0);
  validateDerivedDuration(timings, 'timeToProcessedPreviewMs', ['T0', 'T2'],
    (T0, T2) => T2 - T0);
  validateDerivedDuration(timings, 'createToPetReadyMs', ['T3', 'T5'],
    (T3, T5) => T5 - T3);
  validateDerivedDuration(timings, 'systemTimeToPetMs', ['T0', 'T2', 'T3', 'T5'],
    (T0, T2, T3, T5) => (T2 - T0) + (T5 - T3));
}

export function validateCaseRecord(record) {
  validateNoPrivatePayload(record);
  exactRequiredKeys(record, CASE_KEYS, 'case record');
  if (record.schemaVersion !== SCHEMA_VERSION) fail('case schemaVersion is unsupported');
  boundedString(record.runId, 'runId', { max: 80, pattern: /^[a-zA-Z0-9-]+$/ });
  boundedString(record.gitSha, 'gitSha', { min: 40, max: 40, pattern: /^[0-9a-f]{40}$/ });
  exactRequiredKeys(record.platform, PLATFORM_KEYS, 'platform');
  enumValue(record.platform.os, ['darwin', 'win32', 'linux'], 'platform.os');
  enumValue(record.platform.arch, NODE_ARCHES, 'platform.arch');
  boundedString(record.nodeVersion, 'nodeVersion', {
    max: 40, pattern: /^v\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/,
  });
  boundedString(record.electronVersion, 'electronVersion', {
    max: 40, pattern: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, nullable: true,
  });
  exactRequiredKeys(record.hardwareClass, HARDWARE_KEYS, 'hardwareClass');
  enumValue(record.hardwareClass.logicalCpuBucket, LOGICAL_CPU_BUCKETS, 'logicalCpuBucket');
  enumValue(record.hardwareClass.memoryGiBBucket, MEMORY_GIB_BUCKETS, 'memoryGiBBucket');
  enumValue(record.evidenceKind, EVIDENCE_KINDS, 'evidenceKind');
  enumValue(record.actor, ACTORS, 'actor');
  boundedString(record.caseId, 'caseId', { max: 64, pattern: /^[a-z0-9][a-z0-9_-]*$/ });
  enumValue(record.inputBucket, INPUT_BUCKETS, 'inputBucket');
  integerInRange(record.width, 1, 100_000, 'width');
  integerInRange(record.height, 1, 100_000, 'height');
  integerInRange(record.frameCount, 1, 10_000, 'frameCount');
  enumValue(record.chosenPreset, PIXELIZE_PRESET_NAMES, 'chosenPreset');
  if (record.extractorMode !== null) enumValue(record.extractorMode, EXTRACTOR_MODES, 'extractorMode');
  validateTimings(record.timings);
  if (record.fixesNeeded !== null) integerInRange(record.fixesNeeded, 0, 10_000, 'fixesNeeded');
  if (record.actor === 'automation' && record.fixesNeeded !== null) {
    fail('automation cannot populate fixesNeeded');
  }
  integerInRange(record.scriptedFixes, 0, 10_000, 'scriptedFixes');
  enumValue(record.outcome, OUTCOMES, 'outcome');
  if (record.failureClass !== null) enumValue(record.failureClass, FAILURE_CLASSES, 'failureClass');
  if (!Array.isArray(record.failures) || record.failures.length > 32) fail('failures is invalid');
  for (const [index, failure] of record.failures.entries()) {
    exactRequiredKeys(failure, FAILURE_KEYS, `failures[${index}]`);
    enumValue(failure.class, FAILURE_CLASSES, `failures[${index}].class`);
    boundedString(failure.stage, `failures[${index}].stage`, { max: 64, pattern: /^[a-z0-9_-]+$/i });
    if (typeof failure.recoverable !== 'boolean' || typeof failure.supportedScope !== 'boolean') {
      fail(`failures[${index}] boolean fields are invalid`);
    }
    const expectedSupportedScope = record.inputBucket !== 'unsupported';
    if (failure.supportedScope !== expectedSupportedScope) {
      fail(`failures[${index}].supportedScope must match the preregistered input bucket`);
    }
    boundedString(failure.errorCode, `failures[${index}].errorCode`, {
      max: 96, nullable: true, pattern: /^[A-Z0-9_-]+$/,
    });
    boundedString(failure.claimImpact, `failures[${index}].claimImpact`, { max: 160 });
  }
  if (record.failureClass !== (record.failures[0]?.class ?? null)) {
    fail('failureClass must match the first failure');
  }
  if (typeof record.recoveryUsed !== 'boolean' || typeof record.claimEligible !== 'boolean') {
    fail('case boolean fields are invalid');
  }
  if (!Array.isArray(record.warnings) || record.warnings.length > 32
      || record.warnings.some(value => typeof value !== 'string' || value.length > 500)) {
    fail('warnings is invalid');
  }
  if (record.harnessVersion !== HARNESS_VERSION) fail('harnessVersion is unsupported');
  enumValue(record.rightsStatus, RIGHTS_STATUSES, 'rightsStatus');
  const humanEvidence = record.evidenceKind === 'human-product';
  if ((record.actor === 'human') !== humanEvidence) {
    fail('human-product evidence and a human actor must be declared together');
  }
  const syntheticEvidence = record.evidenceKind === 'synthetic-auxiliary';
  if (syntheticEvidence !== (record.rightsStatus === 'project-synthetic')) {
    fail('synthetic-auxiliary evidence must use project-synthetic rights, and vice versa');
  }
  if (record.claimEligible
      && (record.evidenceKind !== 'human-product'
        || record.actor !== 'human'
        || record.rightsStatus !== 'rights-cleared'
        || record.fixesNeeded === null
        || !['supported', 'recovery'].includes(record.inputBucket))) {
    fail('claim-eligible product evidence requires a supported-scope human actor, rights-cleared input, and fixesNeeded');
  }
  if (record.actor === 'human' && record.scriptedFixes !== 0) {
    fail('human evidence cannot populate scriptedFixes');
  }
  if (record.actor === 'automation' && record.timings.humanEndToEndTimeMs !== null) {
    fail('automation cannot populate humanEndToEndTimeMs');
  }
  const completedHumanEvidence = record.claimEligible
    && (record.outcome === 'success' || record.outcome === 'recovered');
  if (record.timings.humanEndToEndTimeMs !== null && !completedHumanEvidence) {
    fail('humanEndToEndTimeMs is valid only for a completed claim-eligible human trial');
  }
  const humanMarkersAvailable = Number.isFinite(record.timings.markersMs.T0)
    && Number.isFinite(record.timings.markersMs.T5);
  if (record.timings.humanEndToEndTimeMs !== null) {
    if (!humanMarkersAvailable) {
      fail('timings.humanEndToEndTimeMs must be null when T0 or T5 is missing');
    }
    const expected = record.timings.markersMs.T5 - record.timings.markersMs.T0;
    if (!equalDuration(record.timings.humanEndToEndTimeMs, expected)) {
      fail('timings.humanEndToEndTimeMs must equal T5 - T0');
    }
  } else if (completedHumanEvidence && humanMarkersAvailable) {
    fail('completed claim-eligible human timing must equal T5 - T0');
  }

  const correctionCount = (record.fixesNeeded ?? 0) + record.scriptedFixes;
  if (record.outcome === 'success') {
    if (record.failures.length || record.recoveryUsed || correctionCount !== 0) {
      fail('success cannot contain failures, corrections, or recovery use');
    }
  } else if (record.outcome === 'recovered') {
    if (!record.recoveryUsed || (!record.failures.length && correctionCount === 0)
        || (record.failures.length && !record.failures.some(failure => failure.recoverable))) {
      fail('recovered requires an observed failure or correction and recovery use');
    }
  } else if (record.outcome === 'rejected') {
    if (!record.failures.length || record.recoveryUsed
        || record.inputBucket !== 'unsupported'
        || record.failures[0].supportedScope !== false) {
      fail('rejected requires a preregistered unsupported input and cannot claim recovery use');
    }
  } else if (record.outcome === 'failed') {
    if (!record.failures.length
        || record.failures[0].supportedScope !== true) {
      fail('failed requires a supported-scope failure');
    }
  }
  if (correctionCount > 0 && !record.recoveryUsed) {
    fail('recorded corrections require recoveryUsed');
  }
  if (record.recoveryUsed && !record.failures.length && correctionCount === 0) {
    fail('recoveryUsed requires an observed failure or correction');
  }
  return record;
}

export function createCaseRecord(input) {
  if (!isPlainObject(input)) fail('case input must be an object');
  if (input.failures !== undefined && !Array.isArray(input.failures)) fail('failures is invalid');
  if (input.warnings !== undefined && !Array.isArray(input.warnings)) fail('warnings is invalid');
  const failures = (input.failures || []).map(failure => ({
    class: failure.class,
    stage: failure.stage,
    recoverable: failure.recoverable,
    supportedScope: failure.supportedScope,
    errorCode: failure.errorCode ?? null,
    claimImpact: sanitizeDiagnosticText(failure.claimImpact || 'none'),
  }));
  const record = {
    schemaVersion: SCHEMA_VERSION,
    runId: input.runId,
    gitSha: input.gitSha,
    platform: input.platform || { os: process.platform, arch: process.arch },
    nodeVersion: input.nodeVersion || process.version,
    electronVersion: input.electronVersion ?? null,
    hardwareClass: input.hardwareClass || coarseHardwareClass(),
    evidenceKind: input.evidenceKind,
    actor: input.actor,
    caseId: input.caseId,
    inputBucket: input.inputBucket,
    width: input.width,
    height: input.height,
    frameCount: input.frameCount,
    chosenPreset: input.chosenPreset || 'original',
    extractorMode: input.extractorMode ?? null,
    timings: input.timings || emptyTimings(),
    fixesNeeded: input.fixesNeeded ?? null,
    scriptedFixes: input.scriptedFixes ?? 0,
    outcome: input.outcome,
    failureClass: failures[0]?.class ?? null,
    failures,
    recoveryUsed: input.recoveryUsed ?? false,
    warnings: (input.warnings || []).map(sanitizeDiagnosticText),
    harnessVersion: input.harnessVersion || HARNESS_VERSION,
    claimEligible: input.claimEligible ?? false,
    rightsStatus: input.rightsStatus,
  };
  return validateCaseRecord(record);
}

export function classifyFailure(error, stage = 'pipeline') {
  const code = typeof error?.code === 'string' ? error.code : null;
  if (code === 'POPPET_RESOURCE_LIMIT' || code === 'POPPET_PIXELIZE_LIMIT'
      || code === 'POPPET_FACE_CANDIDATE_LIMIT' || code === 'POPPET_FACE_PAIR_LIMIT') {
    return 'INPUT_BUDGET_REJECTED';
  }
  if (code?.startsWith('POPPET_EXTRACTOR_')) return 'SUBJECT_EXTRACTION_FAILURE';
  if (stage === 'pixelize') return 'PIXELIZE_FAILURE';
  if (stage === 'preview') return 'PREVIEW_FAILURE';
  if (stage === 'persistence') return 'PERSISTENCE_FAILURE';
  if (stage === 'spawn') return 'SPAWN_FAILURE';
  if (stage === 'restart') return 'RESTART_RECOVERY_FAILURE';
  if (stage === 'runtime') return 'RUNTIME_COMPOSITION_FAILURE';
  if (stage === 'fixture') return 'TEST_FIXTURE_ERROR';
  return 'SUBJECT_EXTRACTION_FAILURE';
}

export function emptyFailureCounts() {
  return Object.fromEntries(FAILURE_CLASSES.map(name => [name, 0]));
}

export function aggregateCaseRecords(records) {
  if (!Array.isArray(records)) fail('records must be an array');
  const counts = {
    total: 0,
    syntheticAuxiliary: 0,
    claimEligible: 0,
    rightsClearedSupported: 0,
    rightsClearedSupportedCompleted: 0,
    rightsClearedSupportedCompletedWithinOneFix: 0,
    byBucket: Object.fromEntries(INPUT_BUCKETS.map(name => [name, 0])),
    byOutcome: Object.fromEntries(OUTCOMES.map(name => [name, 0])),
  };
  const failureCounts = emptyFailureCounts();
  for (const record of records) {
    validateCaseRecord(record);
    counts.total++;
    counts.byBucket[record.inputBucket]++;
    counts.byOutcome[record.outcome]++;
    if (record.evidenceKind === 'synthetic-auxiliary') counts.syntheticAuxiliary++;
    if (record.claimEligible) counts.claimEligible++;
    // The locked product denominator calls both the supported and recovery
    // buckets "supported scope". Keep their raw bucket counts separate while
    // counting both here; the unsupported bucket never enters this total.
    if (record.claimEligible && record.rightsStatus === 'rights-cleared'
        && (record.inputBucket === 'supported' || record.inputBucket === 'recovery')) {
      counts.rightsClearedSupported++;
      if (record.outcome === 'success' || record.outcome === 'recovered') {
        counts.rightsClearedSupportedCompleted++;
        if (record.fixesNeeded <= 1) counts.rightsClearedSupportedCompletedWithinOneFix++;
      }
    }
    for (const failure of record.failures) failureCounts[failure.class]++;
  }
  return { counts, failureCounts };
}

export function createMilestoneSummary(overrides = {}) {
  const defaultFailureCounts = emptyFailureCounts();
  defaultFailureCounts.HUMAN_EVIDENCE_UNAVAILABLE = 1;
  defaultFailureCounts.RIGHTS_OR_PROVENANCE_BLOCKED = 1;
  const summary = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: null,
    gitSha: null,
    branch: null,
    pr: null,
    ciRun: null,
    engineeringVerdict: 'PARTIAL_VERIFIED',
    productVerdict: 'HUMAN_REQUIRED',
    evidenceBoundaries: [],
    testCommands: [],
    testResults: [],
    packageResults: [],
    managerScenarios: [],
    corpusCounts: {
      supported: 0, recovery: 0, unsupported: 0,
      rightsClearedSupported: 0, syntheticAuxiliary: 0,
    },
    humanTrialCounts: { participants: 0, completed: 0, within60Seconds: 0 },
    timingSummary: null,
    performanceSummary: null,
    failureCounts: defaultFailureCounts,
    rightsStatus: 'RIGHTS_OR_PROVENANCE_BLOCKED',
    nativePlatformStatus: {
      windows: 'UNVERIFIED', macos: 'UNVERIFIED', signingNotarization: 'UNVERIFIED',
    },
    remainingGates: [],
    commits: [],
    nextAction: null,
    acceptanceBinding: null,
    ...overrides,
  };
  if (isPlainObject(summary.failureCounts)) {
    summary.failureCounts = { ...summary.failureCounts };
    if (summary.productVerdict === 'HUMAN_REQUIRED'
        && isPlainObject(summary.humanTrialCounts)
        && Number.isSafeInteger(summary.humanTrialCounts.participants)
        && summary.humanTrialCounts.participants < 5
        && summary.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE === 0) {
      summary.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE = 1;
    }
    if (isPlainObject(summary.corpusCounts)
        && (summary.rightsStatus === 'RIGHTS_OR_PROVENANCE_BLOCKED'
          || (Number.isSafeInteger(summary.corpusCounts.rightsClearedSupported)
            && summary.corpusCounts.rightsClearedSupported < 50))
        && summary.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED === 0) {
      summary.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED = 1;
    }
  }
  return validateMilestoneSummary(summary);
}

function optionalBoundedString(value, label, options = {}) {
  if (value !== undefined) boundedString(value, label, options);
}

function validateCount(value, label) {
  integerInRange(value, 0, 1_000_000, label);
}

function validateStringList(value, label, { maxItems = 256, maxLength = 1_000 } = {}) {
  if (!Array.isArray(value) || value.length > maxItems) fail(`${label} must be an array`);
  value.forEach((entry, index) => boundedString(entry, `${label}[${index}]`, { max: maxLength }));
}

function validatePhaseResult(result, label) {
  exactKeys(result, PHASE_RESULT_KEYS, label);
  requireKeys(result, new Set(['passed', 'total']), label);
  validateCount(result.passed, `${label}.passed`);
  validateCount(result.total, `${label}.total`);
  if (result.failed !== undefined) validateCount(result.failed, `${label}.failed`);
  if (result.durationMs !== undefined) finiteOrNull(result.durationMs, `${label}.durationMs`);
  if (result.passed > result.total || (result.failed ?? 0) > result.total
      || result.passed + (result.failed ?? 0) > result.total) {
    fail(`${label} counts exceed total`);
  }
}

function validateTestResult(result, index) {
  const label = `testResults[${index}]`;
  exactKeys(result, TEST_RESULT_KEYS, label);
  requireKeys(result, new Set(['command', 'status']), label);
  boundedString(result.command, `${label}.command`, { max: 300 });
  enumValue(result.status, RESULT_STATUSES, `${label}.status`);
  if (result.exitCode !== undefined && result.exitCode !== null) {
    integerInRange(result.exitCode, 0, 255, `${label}.exitCode`);
  }
  for (const key of ['passed', 'failed', 'rejected', 'total']) {
    if (result[key] !== undefined) validateCount(result[key], `${label}.${key}`);
  }
  if (result.durationMs !== undefined) finiteOrNull(result.durationMs, `${label}.durationMs`);
  optionalBoundedString(result.evidence, `${label}.evidence`, { max: 160 });
  optionalBoundedString(result.boundary, `${label}.boundary`, { max: 1_000 });
  if (result.total !== undefined) {
    const known = (result.passed ?? 0) + (result.failed ?? 0) + (result.rejected ?? 0);
    if (known > result.total) fail(`${label} counts exceed total`);
  }
  if (result.status === 'PASS'
      && ((result.failed ?? 0) > 0 || (result.exitCode ?? 0) !== 0)) {
    fail(`${label} PASS disagrees with its failure or exit result`);
  }
  for (const phase of ['firstProcess', 'restartProcess']) {
    if (result[phase] !== undefined) validatePhaseResult(result[phase], `${label}.${phase}`);
  }
}

function validatePackageResult(result, index) {
  const label = `packageResults[${index}]`;
  exactKeys(result, PACKAGE_RESULT_KEYS, label);
  requireKeys(result, new Set(['platform', 'command', 'status']), label);
  enumValue(result.platform, ['win32', 'darwin', 'linux', 'windows', 'macos'],
    `${label}.platform`);
  boundedString(result.command, `${label}.command`, { max: 300 });
  enumValue(result.status, RESULT_STATUSES, `${label}.status`);
  for (const key of ['verifyStatus', 'noticeStatus', 'asarStatus']) {
    if (result[key] !== undefined) enumValue(result[key], RESULT_STATUSES, `${label}.${key}`);
  }
  if (result.artifactCount !== undefined) validateCount(result.artifactCount, `${label}.artifactCount`);
  optionalBoundedString(result.boundary, `${label}.boundary`, { max: 1_000 });
}

function validateManagerScenario(result, index) {
  const label = `managerScenarios[${index}]`;
  exactKeys(result, MANAGER_SCENARIO_KEYS, label);
  requireKeys(result, new Set(['name', 'status']), label);
  boundedString(result.name, `${label}.name`, { max: 160, pattern: /^[a-z0-9][a-z0-9_-]*$/i });
  enumValue(result.status, RESULT_STATUSES, `${label}.status`);
  for (const key of ['passed', 'total']) {
    if (result[key] !== undefined) validateCount(result[key], `${label}.${key}`);
  }
  if (result.passed !== undefined && result.total !== undefined && result.passed > result.total) {
    fail(`${label} passed exceeds total`);
  }
  if (result.timings !== undefined && result.timings !== null) validateTimings(result.timings);
  if (result.failureClass !== undefined && result.failureClass !== null) {
    enumValue(result.failureClass, FAILURE_CLASSES, `${label}.failureClass`);
  }
  optionalBoundedString(result.boundary, `${label}.boundary`, { max: 1_000 });
}

function validateCorpusCounts(corpus) {
  exactKeys(corpus, CORPUS_COUNT_KEYS, 'corpusCounts');
  requireKeys(corpus, new Set([
    'supported', 'recovery', 'unsupported', 'rightsClearedSupported', 'syntheticAuxiliary',
  ]), 'corpusCounts');
  for (const key of [
    'supported', 'recovery', 'unsupported', 'rightsClearedSupported', 'syntheticAuxiliary',
  ]) validateCount(corpus[key], `corpusCounts.${key}`);
  if (corpus.rightsClearedSupported > corpus.supported + corpus.recovery) {
    fail('corpusCounts.rightsClearedSupported exceeds supported-scope denominator');
  }
  const completionKeys = [
    'rightsClearedSupportedCompleted',
    'rightsClearedSupportedCompletedWithinOneFix',
  ];
  const completionKeysPresent = completionKeys.filter(key => corpus[key] !== undefined);
  if (completionKeysPresent.length !== 0 && completionKeysPresent.length !== completionKeys.length) {
    fail('corpusCounts rights-cleared completion metrics must be declared together');
  }
  if (completionKeysPresent.length === completionKeys.length) {
    for (const key of completionKeys) validateCount(corpus[key], `corpusCounts.${key}`);
    if (corpus.rightsClearedSupportedCompleted > corpus.rightsClearedSupported
        || corpus.rightsClearedSupportedCompletedWithinOneFix
          > corpus.rightsClearedSupportedCompleted) {
      fail('corpusCounts rights-cleared completion metrics exceed their denominator');
    }
  }
  if (corpus.syntheticAuxiliary > 0 && corpus.syntheticByBucket === undefined) {
    fail('corpusCounts.syntheticByBucket is required when synthetic evidence is recorded');
  }
  if (corpus.syntheticByBucket !== undefined) {
    exactRequiredKeys(corpus.syntheticByBucket, SYNTHETIC_BUCKET_KEYS, 'corpusCounts.syntheticByBucket');
    for (const key of INPUT_BUCKETS) {
      validateCount(corpus.syntheticByBucket[key], `corpusCounts.syntheticByBucket.${key}`);
    }
    const syntheticTotal = INPUT_BUCKETS.reduce((sum, key) => sum + corpus.syntheticByBucket[key], 0);
    if (syntheticTotal !== corpus.syntheticAuxiliary) {
      fail('corpusCounts.syntheticByBucket must sum to syntheticAuxiliary');
    }
  }
}

function validateHumanTrialCounts(counts) {
  exactRequiredKeys(counts, HUMAN_TRIAL_COUNT_KEYS, 'humanTrialCounts');
  for (const key of HUMAN_TRIAL_COUNT_KEYS) validateCount(counts[key], `humanTrialCounts.${key}`);
  if (counts.completed > counts.participants || counts.within60Seconds > counts.completed) {
    fail('humanTrialCounts must satisfy within60Seconds <= completed <= participants');
  }
}

function validateTimingSummary(timingSummary, humanTrialCounts) {
  if (timingSummary === null) return;
  exactRequiredKeys(timingSummary, TIMING_SUMMARY_KEYS, 'timingSummary');
  if (typeof timingSummary.automatedPipelineOnly !== 'boolean'
      || typeof timingSummary.timeToPetAvailable !== 'boolean') {
    fail('timingSummary boolean field is invalid');
  }
  finiteOrNull(timingSummary.humanEndToEndTimeMs, 'timingSummary.humanEndToEndTimeMs');
  if ((timingSummary.automatedPipelineOnly || !timingSummary.timeToPetAvailable)
      && timingSummary.humanEndToEndTimeMs !== null) {
    fail('timingSummary cannot report human time without human Time-to-Pet evidence');
  }
  if (timingSummary.humanEndToEndTimeMs !== null && humanTrialCounts.completed === 0) {
    fail('timingSummary human time requires a completed human trial');
  }
}

function performanceProtocolIdentity(protocol) {
  const canonical = {
    petCounts: PERFORMANCE_PROTOCOL.petCounts,
    repetitions: protocol.repetitions,
    warmupMs: protocol.warmupMs,
    idleMs: protocol.idleMs,
    activeMs: protocol.activeMs,
    recoveryMs: protocol.recoveryMs,
    soakPets: PERFORMANCE_PROTOCOL.soakPets,
    soakWarmupMs: protocol.soakWarmupMs,
    soakMs: protocol.soakMs,
    sampleIntervalMs: protocol.sampleIntervalMs,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical), 'utf8').digest('hex');
}

function validatePerformanceProtocol(protocol, qualified) {
  exactRequiredKeys(protocol, PERFORMANCE_PROTOCOL_KEYS, 'performanceSummary.protocol');
  if (!Array.isArray(protocol.petCounts)
      || JSON.stringify(protocol.petCounts) !== JSON.stringify(PERFORMANCE_PROTOCOL.petCounts)) {
    fail('performanceSummary.protocol.petCounts must be the exact 1/3/6 matrix');
  }
  for (const key of [
    'repetitions', 'warmupMs', 'idleMs', 'activeMs', 'recoveryMs', 'soakPets',
    'soakWarmupMs', 'soakMs', 'sampleIntervalMs',
  ]) integerInRange(protocol[key], 1, 24 * 60 * 60_000, `performanceSummary.protocol.${key}`);
  if (protocol.soakPets !== PERFORMANCE_PROTOCOL.soakPets) {
    fail('performanceSummary.protocol.soakPets must be 6');
  }
  const locked = protocol.repetitions === PERFORMANCE_PROTOCOL.repetitions
    && protocol.warmupMs === PERFORMANCE_PROTOCOL.warmupMs
    && protocol.idleMs === PERFORMANCE_PROTOCOL.idleMs
    && protocol.activeMs === PERFORMANCE_PROTOCOL.activeMs
    && protocol.recoveryMs === PERFORMANCE_PROTOCOL.recoveryMs
    && protocol.soakWarmupMs === PERFORMANCE_PROTOCOL.soakWarmupMs
    && protocol.soakMs === PERFORMANCE_PROTOCOL.soakMs
    && protocol.sampleIntervalMs === PERFORMANCE_PROTOCOL.sampleIntervalMs;
  if (qualified && !locked) fail('qualified performance protocol differs from the locked protocol');
}

function validatePerformanceProvenance(provenance, performanceSummary, summaryGitSha) {
  exactRequiredKeys(provenance, PERFORMANCE_PROVENANCE_KEYS, 'performanceSummary.provenance');
  if (provenance.identityVersion !== 'core-loop-performance-run-identity-v1'
      || provenance.harnessVersion !== HARNESS_VERSION
      || provenance.performanceHarnessVersion !== 'core-loop-performance-harness-v3'
      || provenance.comparisonVersion !== 'core-loop-performance-comparison-v2') {
    fail('performanceSummary.provenance version identity is invalid');
  }
  boundedString(provenance.appGitSha, 'performanceSummary.provenance.appGitSha', {
    min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
  });
  boundedString(provenance.harnessGitSha, 'performanceSummary.provenance.harnessGitSha', {
    min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
  });
  if (provenance.appGitSha !== summaryGitSha) {
    fail('performanceSummary provenance must use the exact summary gitSha');
  }
  if (typeof provenance.harnessSourceClean !== 'boolean') {
    fail('performanceSummary.provenance.harnessSourceClean must be boolean');
  }
  boundedString(provenance.probeIdentity, 'performanceSummary.provenance.probeIdentity', {
    max: 80, pattern: /^[a-z0-9][a-z0-9_-]*$/,
  });
  for (const key of [
    'probeSourceSha256', 'fixtureIdentity', 'settingsIdentity', 'environmentIdentity',
  ]) {
    boundedString(provenance[key], `performanceSummary.provenance.${key}`, {
      min: 64, max: 64, pattern: /^[0-9a-f]{64}$/, nullable: true,
    });
  }
  boundedString(provenance.protocolIdentity, 'performanceSummary.provenance.protocolIdentity', {
    min: 64, max: 64, pattern: /^[0-9a-f]{64}$/,
  });
  if (provenance.protocolIdentity !== performanceProtocolIdentity(performanceSummary.protocol)) {
    fail('performanceSummary.provenance.protocolIdentity does not match protocol');
  }
  for (const key of ['driverNodeVersion', 'electronVersion', 'electronNodeVersion']) {
    boundedString(provenance[key], `performanceSummary.provenance.${key}`, {
      max: 40, pattern: /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/, nullable: key !== 'driverNodeVersion',
    });
  }
  if (performanceSummary.protocolQualified
      && (performanceSummary.sourceDirty !== false
        || provenance.harnessSourceClean !== true
        || provenance.probeIdentity !== 'poppet-core-loop-electron-probe-v4'
        || provenance.probeSourceSha256 === null
        || provenance.fixtureIdentity === null
        || provenance.settingsIdentity === null
        || provenance.environmentIdentity === null
        || provenance.electronVersion === null
        || provenance.electronNodeVersion === null)) {
    fail('qualified performance summary lacks clean default-probe provenance');
  }
}

function validatePerformanceTopology(row, topology) {
  const label = `performanceSummary.byTopology.${topology}`;
  exactRequiredKeys(row, PERFORMANCE_TOPOLOGY_KEYS, label);
  for (const key of [
    'samples', 'frameIntervalSampleCount', 'frameIntervalOverflowCount', 'eventLoopStalls',
    'crashes', 'unhandledErrors', 'postDestroyPetCountMax', 'postDestroyWindowCountMax',
    'postDestroyTimerDeltaMax', 'postDestroyListenerDeltaMax',
  ]) validateCount(row[key], `${label}.${key}`);
  for (const key of [
    'meanMainCpuPercent', 'meanRendererCpuPercent', 'peakMainMemoryMiB',
    'peakRendererMemoryMiB', 'frameIntervalP50Ms', 'frameIntervalP95Ms',
    'frameIntervalP99Ms', 'renderWorkP95Ms',
  ]) finiteOrNull(row[key], `${label}.${key}`);
  finiteOrNull(row.activeLongFrameRate, `${label}.activeLongFrameRate`);
  if (row.activeLongFrameRate !== null && row.activeLongFrameRate > 1) {
    fail(`${label}.activeLongFrameRate must be in 0..1`);
  }
  if (row.frameIntervalOverflowCount > row.frameIntervalSampleCount) {
    fail(`${label} frame overflow exceeds frame sample count`);
  }
  const quantiles = [row.frameIntervalP50Ms, row.frameIntervalP95Ms, row.frameIntervalP99Ms];
  const available = quantiles.filter(Number.isFinite);
  if (available.length !== 0 && (available.length !== 3
      || quantiles[0] > quantiles[1] || quantiles[1] > quantiles[2])) {
    fail(`${label} frame quantiles are inconsistent`);
  }
}

function validateMemoryTrend(trend) {
  exactRequiredKeys(trend, MEMORY_TREND_KEYS, 'performanceSummary.soak.memoryTrend');
  enumValue(trend.status, ['AVAILABLE', 'UNAVAILABLE'],
    'performanceSummary.soak.memoryTrend.status');
  for (const key of [
    'combinedMemoryTheilSenMiBPerMinute', 'combinedMemoryTheilSenLower95MiBPerMinute',
    'firstTenMinuteMedianMiB', 'lastTenMinuteMedianMiB', 'lastMinusFirstMedianMiB',
  ]) finiteNumberOrNull(trend[key], `performanceSummary.soak.memoryTrend.${key}`);
  if (trend.bootstrapSamples !== PERFORMANCE_PROTOCOL.bootstrapSamples
      || trend.bootstrapSeed !== PERFORMANCE_PROTOCOL.bootstrapSeed) {
    fail('performanceSummary.soak.memoryTrend bootstrap contract is invalid');
  }
  if (trend.status === 'AVAILABLE') {
    if (trend.regressionDetected !== true && trend.regressionDetected !== false) {
      fail('available memory trend requires a boolean regression result');
    }
    if ([
      trend.combinedMemoryTheilSenMiBPerMinute,
      trend.combinedMemoryTheilSenLower95MiBPerMinute,
      trend.firstTenMinuteMedianMiB,
      trend.lastTenMinuteMedianMiB,
      trend.lastMinusFirstMedianMiB,
    ].some(value => !Number.isFinite(value))) fail('available memory trend requires all metrics');
    const expectedDelta = trend.lastTenMinuteMedianMiB - trend.firstTenMinuteMedianMiB;
    if (!equalDuration(trend.lastMinusFirstMedianMiB, expectedDelta)) {
      fail('memory trend last-minus-first metric is inconsistent');
    }
    const expectedRegression = trend.combinedMemoryTheilSenLower95MiBPerMinute > 1
      && expectedDelta > 20;
    if (trend.regressionDetected !== expectedRegression) {
      fail('memory trend regression verdict is inconsistent with its metrics');
    }
  } else if (trend.regressionDetected !== null || [
    trend.combinedMemoryTheilSenMiBPerMinute,
    trend.combinedMemoryTheilSenLower95MiBPerMinute,
    trend.firstTenMinuteMedianMiB,
    trend.lastTenMinuteMedianMiB,
    trend.lastMinusFirstMedianMiB,
  ].some(value => value !== null)) {
    fail('unavailable memory trend metrics must be null');
  }
}

function validateResourceTrend(trend) {
  exactRequiredKeys(trend, RESOURCE_TREND_KEYS, 'performanceSummary.soak.resourceTrend');
  enumValue(trend.status, ['AVAILABLE', 'UNAVAILABLE'],
    'performanceSummary.soak.resourceTrend.status');
  const metricKeys = [
    'timerFirstWindowMedianDelta', 'timerLastWindowMedianDelta',
    'listenerFirstWindowMedianDelta', 'listenerLastWindowMedianDelta',
    'timerTheilSenDeltaPerMinute', 'listenerTheilSenDeltaPerMinute',
  ];
  for (const key of metricKeys) {
    finiteNumberOrNull(trend[key], `performanceSummary.soak.resourceTrend.${key}`);
  }
  if (trend.status === 'AVAILABLE') {
    if (trend.sustainedGrowthDetected !== true && trend.sustainedGrowthDetected !== false) {
      fail('available resource trend requires a boolean growth result');
    }
    if (metricKeys.some(key => !Number.isFinite(trend[key]))) {
      fail('available resource trend requires all metrics');
    }
    const expectedGrowth = (trend.timerLastWindowMedianDelta
        > trend.timerFirstWindowMedianDelta && trend.timerTheilSenDeltaPerMinute > 0)
      || (trend.listenerLastWindowMedianDelta
        > trend.listenerFirstWindowMedianDelta && trend.listenerTheilSenDeltaPerMinute > 0);
    if (trend.sustainedGrowthDetected !== expectedGrowth) {
      fail('resource trend growth verdict is inconsistent with its metrics');
    }
  } else if (trend.sustainedGrowthDetected !== null
      || metricKeys.some(key => trend[key] !== null)) {
    fail('unavailable resource trend metrics must be null');
  }
}

function validatePerformanceComparisonProjection(projection, summaryGitSha) {
  if (projection === null) return;
  exactRequiredKeys(projection, PERFORMANCE_COMPARISON_PROJECTION_KEYS,
    'performanceSummary.soak.comparisonToPreChange');
  if (projection.comparisonVersion !== 'core-loop-performance-comparison-v2') {
    fail('performance comparison projection version is invalid');
  }
  enumValue(projection.status, ['REGRESSION', 'NO_REGRESSION_DETECTED', 'SMOKE_ONLY'],
    'performance comparison projection status');
  for (const key of ['claimEligible', 'regressionDetected', 'sameMachineAttested']) {
    if (typeof projection[key] !== 'boolean') {
      fail(`performance comparison projection ${key} must be boolean`);
    }
  }
  for (const key of ['beforeGitSha', 'afterGitSha']) {
    boundedString(projection[key], `performance comparison projection ${key}`, {
      min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
    });
  }
  if (projection.afterGitSha !== summaryGitSha) {
    fail('performance comparison afterGitSha must equal the summary gitSha');
  }
  if (projection.beforeGitSha === projection.afterGitSha) {
    fail('performance comparison requires distinct before and after Git SHAs');
  }
  const expectedStatus = projection.regressionDetected
    ? 'REGRESSION' : (projection.claimEligible ? 'NO_REGRESSION_DETECTED' : 'SMOKE_ONLY');
  if (projection.status !== expectedStatus) {
    fail('performance comparison projection verdict fields are inconsistent');
  }
  if (projection.claimEligible && !projection.sameMachineAttested) {
    fail('claim-eligible performance comparison requires same-machine attestation');
  }
}

function validatePerformanceEvidenceBindingShape(binding) {
  exactRequiredKeys(binding, PERFORMANCE_EVIDENCE_BINDING_KEYS,
    'performanceSummary.evidenceBinding');
  if (binding.bindingVersion !== 'core-loop-performance-evidence-binding-v2') {
    fail('performanceSummary.evidenceBinding version is invalid');
  }
  for (const key of [
    'samplesSha256', 'beforeSamplesSha256', 'afterSamplesSha256',
    'comparisonArtifactSha256',
  ]) {
    boundedString(binding[key], `performanceSummary.evidenceBinding.${key}`, {
      min: 64, max: 64, pattern: /^[0-9a-f]{64}$/,
    });
  }
  for (const key of [
    'sampleCount', 'beforeSampleCount', 'afterSampleCount', 'pairedBlockCount',
    'metricResultCount', 'hardCheckCount',
  ]) {
    integerInRange(binding[key], 1, 10_000_000,
      `performanceSummary.evidenceBinding.${key}`);
  }
}

export function performanceEvidenceBindingDigest(binding) {
  validatePerformanceEvidenceBindingShape(binding);
  const canonical = Object.fromEntries([...PERFORMANCE_EVIDENCE_BINDING_KEYS]
    .map(key => [key, binding[key]]));
  return crypto.createHash('sha256')
    .update('poppet-core-loop-performance-evidence-binding-v2\0', 'utf8')
    .update(JSON.stringify(canonical), 'utf8')
    .digest('hex');
}

function validatePerformanceEvidenceBinding(binding, performanceSummary) {
  if (binding === undefined || binding === null) return;
  validatePerformanceEvidenceBindingShape(binding);
  const aggregateSampleCount = performanceSummary.soak.samples
    + Object.values(performanceSummary.byTopology).reduce((sum, row) => sum + row.samples, 0);
  if (binding.sampleCount !== aggregateSampleCount
      || binding.afterSampleCount !== aggregateSampleCount
      || binding.samplesSha256 !== binding.afterSamplesSha256) {
    fail('performance evidence binding disagrees with the final aggregate sample coverage');
  }
  if (binding.beforeSamplesSha256 === binding.afterSamplesSha256) {
    fail('performance evidence binding requires distinct before and after raw sample digests');
  }
}

function validatePerformanceSoak(soak, protocol, summaryGitSha) {
  exactRequiredKeys(soak, PERFORMANCE_SOAK_KEYS, 'performanceSummary.soak');
  for (const key of ['samples', 'crashes', 'unhandledErrors']) {
    validateCount(soak[key], `performanceSummary.soak.${key}`);
  }
  integerInRange(soak.durationMs, 1, 24 * 60 * 60_000, 'performanceSummary.soak.durationMs');
  if (soak.durationMs !== protocol.soakMs) {
    fail('performanceSummary.soak.durationMs must match protocol.soakMs');
  }
  validateMemoryTrend(soak.memoryTrend);
  validateResourceTrend(soak.resourceTrend);
  validatePerformanceComparisonProjection(soak.comparisonToPreChange, summaryGitSha);
}

function validatePerformanceSummary(performanceSummary, summaryGitSha) {
  if (performanceSummary === null) return;
  exactKeys(performanceSummary, PERFORMANCE_SUMMARY_KEYS, 'performanceSummary');
  requireKeys(performanceSummary, PERFORMANCE_SUMMARY_REQUIRED_KEYS, 'performanceSummary');
  exactRequiredKeys(performanceSummary.hardwareClass, HARDWARE_KEYS,
    'performanceSummary.hardwareClass');
  enumValue(performanceSummary.hardwareClass.logicalCpuBucket, LOGICAL_CPU_BUCKETS,
    'performanceSummary.hardwareClass.logicalCpuBucket');
  enumValue(performanceSummary.hardwareClass.memoryGiBBucket, MEMORY_GIB_BUCKETS,
    'performanceSummary.hardwareClass.memoryGiBBucket');
  if (performanceSummary.sourceDirty !== null && typeof performanceSummary.sourceDirty !== 'boolean') {
    fail('performanceSummary.sourceDirty must be null or boolean');
  }
  if (typeof performanceSummary.protocolQualified !== 'boolean') {
    fail('performanceSummary.protocolQualified must be boolean');
  }
  if (!summaryGitSha) fail('performanceSummary requires summary gitSha');
  validatePerformanceProtocol(performanceSummary.protocol, performanceSummary.protocolQualified);
  validatePerformanceProvenance(performanceSummary.provenance, performanceSummary, summaryGitSha);
  exactRequiredKeys(performanceSummary.byTopology, new Set(['1', '3', '6']),
    'performanceSummary.byTopology');
  for (const topology of PERFORMANCE_PROTOCOL.petCounts) {
    validatePerformanceTopology(performanceSummary.byTopology[topology], topology);
  }
  validatePerformanceSoak(performanceSummary.soak, performanceSummary.protocol, summaryGitSha);
  validatePerformanceEvidenceBinding(performanceSummary.evidenceBinding, performanceSummary);
}

function validateCiRun(ciRun, summaryGitSha) {
  if (ciRun === null) return;
  exactRequiredKeys(ciRun, CI_RUN_KEYS, 'ciRun');
  boundedString(ciRun.url, 'ciRun.url', {
    max: 200,
    pattern: /^https:\/\/github\.com\/SioYooo\/poppet\/actions\/runs\/\d+$/,
  });
  boundedString(ciRun.gitSha, 'ciRun.gitSha', {
    min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
  });
  if (!summaryGitSha || ciRun.gitSha !== summaryGitSha) {
    fail('ciRun must be for the exact summary gitSha');
  }
  if (!Array.isArray(ciRun.jobs) || ciRun.jobs.length > 100) fail('ciRun.jobs must be an array');
  const names = new Set();
  ciRun.jobs.forEach((job, index) => {
    const label = `ciRun.jobs[${index}]`;
    exactRequiredKeys(job, CI_JOB_KEYS, label);
    boundedString(job.name, `${label}.name`, { max: 160 });
    enumValue(job.status, CI_JOB_STATUSES, `${label}.status`);
    const normalized = job.name.toLowerCase();
    if (names.has(normalized)) fail('ciRun.jobs contains duplicate job names');
    names.add(normalized);
  });
}

function validateAcceptanceBinding(binding, summaryGitSha) {
  if (binding === undefined || binding === null) return;
  exactRequiredKeys(binding, ACCEPTANCE_BINDING_KEYS, 'acceptanceBinding');
  if (binding.bindingVersion !== 'core-loop-acceptance-binding-v1') {
    fail('acceptanceBinding version is invalid');
  }
  boundedString(binding.subjectGitSha, 'acceptanceBinding.subjectGitSha', {
    min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
  });
  if (binding.subjectGitSha !== summaryGitSha) {
    fail('acceptanceBinding.subjectGitSha must equal the evidence app gitSha');
  }
  enumValue(binding.reportCarrierMode, [
    'DETACHED_ARTIFACT', 'DOCS_ONLY_DESCENDANT_OF_SUBJECT',
  ], 'acceptanceBinding.reportCarrierMode');
  for (const key of ['ciEvidenceDigest', 'performanceEvidenceDigest']) {
    boundedString(binding[key], `acceptanceBinding.${key}`, {
      min: 64, max: 64, pattern: /^[0-9a-f]{64}$/,
    });
  }
  if (binding.ciEvidenceDigest === binding.performanceEvidenceDigest) {
    fail('acceptanceBinding CI and performance evidence digests must be distinct');
  }
}

function validateAcceptanceEvidence(summary, acceptanceEvidence) {
  if (!acceptanceEvidence) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED validation requires external CI/performance evidence bundles');
  }
  exactRequiredKeys(acceptanceEvidence, ACCEPTANCE_EVIDENCE_KEYS, 'acceptance evidence');
  exactRequiredKeys(acceptanceEvidence.ciBundle, ACCEPTANCE_CI_BUNDLE_KEYS,
    'acceptance evidence CI bundle');
  exactRequiredKeys(acceptanceEvidence.performanceBundle,
    ACCEPTANCE_PERFORMANCE_BUNDLE_KEYS, 'acceptance evidence performance bundle');
  const expectedCiBundle = { ciRun: summary.ciRun };
  const expectedPerformanceBundle = {
    evidenceBinding: summary.performanceSummary.evidenceBinding,
    comparisonProjection: summary.performanceSummary.soak.comparisonToPreChange,
  };
  if (canonicalJson(acceptanceEvidence.ciBundle)
      !== canonicalJson(expectedCiBundle)) {
    fail('external CI evidence bundle does not match the milestone projection');
  }
  if (canonicalJson(acceptanceEvidence.performanceBundle)
      !== canonicalJson(expectedPerformanceBundle)) {
    fail('external performance evidence bundle does not match the raw/comparison manifest');
  }
  if (summary.acceptanceBinding.ciEvidenceDigest
      !== acceptanceEvidenceDigest('ci', acceptanceEvidence.ciBundle)) {
    fail('acceptanceBinding CI evidence digest does not match its external bundle');
  }
  if (summary.acceptanceBinding.performanceEvidenceDigest
      !== acceptanceEvidenceDigest('performance', acceptanceEvidence.performanceBundle)) {
    fail('acceptanceBinding performance evidence digest does not match its external bundle');
  }
}

function canonicalCiRole(name) {
  const exactWorkflowDisplayNames = new Map([
    ['test (ubuntu-latest)', 'test:ubuntu'],
    ['test (macos-latest)', 'test:macos'],
    ['test (windows-latest)', 'test:windows'],
    ['audit', 'audit'],
    ['package (macos, macos-latest, npm run pack:mac)', 'package:macos'],
    ['package (windows, windows-latest, npm run pack:win)', 'package:windows'],
  ]);
  return exactWorkflowDisplayNames.get(name) ?? null;
}

function validateAcceptedLocalEvidence(summary, acceptanceEvidence) {
  for (const command of ACCEPTED_TEST_COMMANDS) {
    const matches = summary.testResults.filter(result => result.command === command);
    if (!summary.testCommands.includes(command)
        || matches.length === 0 || matches.some(result => result.status !== 'PASS'
        || result.exitCode !== 0)) {
      fail(`CORE_LOOP_ENGINEERING_ACCEPTED requires a successful ${command} test result`);
    }
  }

  const managerTest = summary.testResults.find(result => result.command === 'npm run test:manager'
    && ['firstProcess', 'restartProcess'].every(phase => {
      const value = result[phase];
      return value && Number.isInteger(value.total) && value.total > 0
        && Number.isInteger(value.passed) && value.passed === value.total
        && (value.failed ?? 0) === 0;
    }));
  for (const phase of ['firstProcess', 'restartProcess']) {
    const result = managerTest?.[phase];
    if (!result) {
      fail(`CORE_LOOP_ENGINEERING_ACCEPTED requires complete Manager ${phase} evidence`);
    }
  }

  for (const name of ACCEPTED_MANAGER_SCENARIOS) {
    const matches = summary.managerScenarios.filter(result => result.name === name);
    if (matches.length === 0 || matches.some(result => result.status !== 'PASS'
        || !Number.isInteger(result.total) || result.total < 1
        || !Number.isInteger(result.passed) || result.passed !== result.total)) {
      fail(`CORE_LOOP_ENGINEERING_ACCEPTED requires a passing ${name} Manager scenario`);
    }
  }
  const calibratedScenario = summary.managerScenarios.find(result =>
    result.name === 'first-frame-before-success'
      && result.status === 'PASS'
      && result.timings
      && result.timings.clock.mode !== 'unavailable'
      && [...MARKER_KEYS].every(marker => Number.isFinite(result.timings.markersMs[marker])));
  if (!calibratedScenario) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED requires calibrated T0-T6 first-frame Manager timings');
  }

  for (const [platform, aliases] of [
    ['macOS', new Set(['macos', 'darwin'])],
    ['Windows', new Set(['windows', 'win32'])],
  ]) {
    const matches = summary.packageResults.filter(result => aliases.has(result.platform));
    if (matches.length === 0 || matches.some(result => result.status !== 'PASS'
        || result.verifyStatus !== 'PASS' || result.noticeStatus !== 'PASS'
        || result.asarStatus !== 'PASS' || !Number.isInteger(result.artifactCount)
        || result.artifactCount < 1)) {
      fail(`CORE_LOOP_ENGINEERING_ACCEPTED requires verified ${platform} package evidence`);
    }
  }

  const nativePackageStatuses = new Set(['HOSTED_PACKAGE_VERIFIED', 'NATIVE_PACKAGE_VERIFIED']);
  if (!nativePackageStatuses.has(summary.nativePlatformStatus.windows)
      || !nativePackageStatuses.has(summary.nativePlatformStatus.macos)) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED requires hosted-package-or-better Windows and macOS evidence');
  }

  if (!summary.acceptanceBinding) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED requires detached acceptance evidence binding');
  }

  const appEvidenceCommits = summary.commits.filter(commit =>
    commit.purpose === EVIDENCE_APP_COMMIT_PURPOSE);
  if (appEvidenceCommits.length !== 1 || appEvidenceCommits[0].sha !== summary.gitSha
      || !summary.evidenceBoundaries.includes(EVIDENCE_SHA_BOUNDARY)) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED must identify summary.gitSha as the evidence app SHA, not the report carrier');
  }
  for (const commit of summary.commits) {
    if (REPORT_CARRIER_COMMIT_PURPOSES.has(commit.purpose) && commit.sha === summary.gitSha) {
      fail('docs-only report carrier attestation cannot masquerade as the evidence app SHA');
    }
  }

  const performance = summary.performanceSummary;
  const minimumSeriesSamples = durationMs => Math.max(1,
    Math.floor(durationMs / performance.protocol.sampleIntervalMs) - 1);
  const minimumScenarioSamples = topology => performance.protocol.repetitions * (
    (topology + 1) * minimumSeriesSamples(performance.protocol.idleMs)
    + (topology + 1) * minimumSeriesSamples(performance.protocol.activeMs)
    + minimumSeriesSamples(performance.protocol.recoveryMs)
  );
  for (const topology of performance.protocol.petCounts) {
    const row = performance.byTopology[topology];
    if (row.samples < minimumScenarioSamples(topology)) {
      fail(`CORE_LOOP_ENGINEERING_ACCEPTED lacks locked-protocol ${topology}-pet sample density`);
    }
    for (const key of [
      'meanMainCpuPercent', 'meanRendererCpuPercent', 'peakMainMemoryMiB',
      'peakRendererMemoryMiB', 'frameIntervalP50Ms', 'frameIntervalP95Ms',
      'frameIntervalP99Ms', 'renderWorkP95Ms', 'activeLongFrameRate',
    ]) {
      if (!Number.isFinite(row[key])) {
        fail(`CORE_LOOP_ENGINEERING_ACCEPTED lacks ${topology}-pet ${key} evidence`);
      }
    }
  }
  const minimumSoakSamples = (performance.protocol.soakPets + 1)
    * minimumSeriesSamples(performance.protocol.soakMs);
  if (performance.soak.samples < minimumSoakSamples) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED lacks locked-protocol soak sample density');
  }
  if (!performance.evidenceBinding) {
    fail('CORE_LOOP_ENGINEERING_ACCEPTED requires immutable raw-sample and comparison evidence binding');
  }
  validateAcceptanceEvidence(summary, acceptanceEvidence);
}

function validatePerformanceFailureCounts(summary) {
  const performance = summary.performanceSummary;
  if (!performance) return;
  const projection = performance.soak.comparisonToPreChange;
  const regressionDetected = performance.soak.memoryTrend.regressionDetected === true
    || performance.soak.resourceTrend.sustainedGrowthDetected === true
    || performance.soak.crashes > 0
    || performance.soak.unhandledErrors > 0
    || projection?.regressionDetected === true
    || Object.values(performance.byTopology).some(row => row.crashes > 0
      || row.unhandledErrors > 0 || row.postDestroyPetCountMax > 0
      || row.postDestroyWindowCountMax > 0 || row.postDestroyTimerDeltaMax > 0
      || row.postDestroyListenerDeltaMax > 0);
  if (performance.protocolQualified && regressionDetected
      && summary.failureCounts.PERFORMANCE_REGRESSION < 1) {
    fail('detected performance regressions require PERFORMANCE_REGRESSION');
  }
  if (performance.protocolQualified
      && (performance.soak.memoryTrend.status !== 'AVAILABLE'
        || performance.soak.resourceTrend.status !== 'AVAILABLE')
      && summary.failureCounts.ENVIRONMENT_FAILURE < 1) {
    fail('unavailable qualified performance evidence requires ENVIRONMENT_FAILURE');
  }
}

function validateAcceptedVerdicts(summary, acceptanceEvidence) {
  if (summary.engineeringVerdict === 'CORE_LOOP_ENGINEERING_ACCEPTED') {
    if (!summary.generatedAt || !summary.gitSha || summary.branch !== 'main' || !summary.ciRun) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED requires a generated final main SHA and same-SHA CI');
    }
    const roleCounts = new Map(ACCEPTED_CI_ROLES.map(role => [role, 0]));
    for (const job of summary.ciRun.jobs) {
      const role = canonicalCiRole(job.name);
      if (roleCounts.has(role)) roleCounts.set(role, roleCounts.get(role) + 1);
    }
    if (summary.ciRun.jobs.some(job => job.status !== 'PASS')
        || [...roleCounts.values()].some(count => count !== 1)) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED requires all required same-SHA CI jobs to pass');
    }
    const comparison = summary.performanceSummary?.soak?.comparisonToPreChange;
    if (!comparison
        || comparison.comparisonVersion !== 'core-loop-performance-comparison-v2'
        || comparison.status !== 'NO_REGRESSION_DETECTED'
        || comparison.claimEligible !== true
        || comparison.regressionDetected !== false
        || comparison.sameMachineAttested !== true
        || comparison.afterGitSha !== summary.gitSha
        || comparison.beforeGitSha === comparison.afterGitSha) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED requires a claim-eligible same-machine no-regression comparison');
    }
    if (!summary.performanceSummary
        || summary.performanceSummary.sourceDirty !== false
        || summary.performanceSummary.protocolQualified !== true
        || summary.performanceSummary.soak.memoryTrend.status !== 'AVAILABLE'
        || summary.performanceSummary.soak.memoryTrend.regressionDetected !== false
        || summary.performanceSummary.soak.resourceTrend.status !== 'AVAILABLE'
        || summary.performanceSummary.soak.resourceTrend.sustainedGrowthDetected !== false
        || summary.performanceSummary.soak.crashes !== 0
        || summary.performanceSummary.soak.unhandledErrors !== 0
        || Object.values(summary.performanceSummary.byTopology).some(row =>
          row.samples < 1 || row.frameIntervalSampleCount < 1
          || row.crashes !== 0 || row.unhandledErrors !== 0
          || row.postDestroyPetCountMax !== 0 || row.postDestroyWindowCountMax !== 0
          || row.postDestroyTimerDeltaMax !== 0 || row.postDestroyListenerDeltaMax !== 0)) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED requires a clean, qualified performance run');
    }
    if (summary.performanceSummary.soak.samples < 1) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED requires non-empty qualified soak evidence');
    }
    validateAcceptedLocalEvidence(summary, acceptanceEvidence);
    // Corpus cases may legitimately record supported, rejected, or recovered
    // product-path failures. Only milestone gate failures are incompatible
    // with engineering acceptance at the aggregate level.
    const engineeringFailures = [
      'CI_SOURCE_CONTRACT', 'CI_HOST_LAYOUT_ASSUMPTION',
      'PACKAGED_NOTICE_MISSING', 'PACKAGED_NOTICE_STALE', 'ASAR_MANIFEST_DRIFT',
      'PERFORMANCE_REGRESSION', 'TEST_FIXTURE_ERROR', 'ENVIRONMENT_FAILURE',
    ];
    if (engineeringFailures.some(name => summary.failureCounts[name] !== 0)) {
      fail('CORE_LOOP_ENGINEERING_ACCEPTED cannot contain engineering failures');
    }
  }
  if (summary.productVerdict === 'CORE_LOOP_PRODUCT_VALIDATED') {
    if (summary.corpusCounts.rightsClearedSupported < 50
        || !Number.isSafeInteger(summary.corpusCounts.rightsClearedSupportedCompleted)
        || !Number.isSafeInteger(
          summary.corpusCounts.rightsClearedSupportedCompletedWithinOneFix)
        || summary.corpusCounts.rightsClearedSupportedCompletedWithinOneFix * 10
          < summary.corpusCounts.rightsClearedSupported * 9
        || summary.humanTrialCounts.participants < 5
        || summary.humanTrialCounts.completed < 4
        || summary.humanTrialCounts.completed * 5
          < summary.humanTrialCounts.participants * 4
        || summary.humanTrialCounts.within60Seconds * 2 <= summary.humanTrialCounts.completed
        || summary.rightsStatus !== 'RIGHTS_CLEARED') {
      fail('CORE_LOOP_PRODUCT_VALIDATED requires qualifying corpus, human, timing, and rights evidence');
    }
    if (summary.engineeringVerdict !== 'CORE_LOOP_ENGINEERING_ACCEPTED') {
      fail('CORE_LOOP_PRODUCT_VALIDATED requires CORE_LOOP_ENGINEERING_ACCEPTED');
    }
    if (!summary.timingSummary?.timeToPetAvailable
        || summary.timingSummary.automatedPipelineOnly !== false
        || !Number.isFinite(summary.timingSummary.humanEndToEndTimeMs)
        || summary.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE !== 0
        || summary.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED !== 0) {
      fail('CORE_LOOP_PRODUCT_VALIDATED conflicts with unavailable product evidence');
    }
  }
}

export function validateMilestoneSummary(summary, { acceptanceEvidence = null } = {}) {
  assertSummaryPrivacySafe(summary);
  exactKeys(summary, new Set(SUMMARY_KEYS), 'milestone summary');
  requireKeys(summary, SUMMARY_REQUIRED_KEYS, 'milestone summary');
  if (summary.schemaVersion !== SCHEMA_VERSION) fail('summary schemaVersion is unsupported');
  if (summary.generatedAt !== null) {
    boundedString(summary.generatedAt, 'generatedAt', {
      max: 30, pattern: /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    });
    const parsed = Date.parse(summary.generatedAt);
    if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== summary.generatedAt) {
      fail('generatedAt must be null or canonical ISO time');
    }
  }
  if (summary.gitSha !== null) boundedString(summary.gitSha, 'summary gitSha', {
    min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
  });
  if (summary.branch !== null) {
    boundedString(summary.branch, 'summary branch', {
      max: 200, pattern: /^(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._/-]+$/,
    });
  }
  if (summary.pr !== null) boundedString(summary.pr, 'summary pr', {
    max: 200,
    pattern: /^https:\/\/github\.com\/SioYooo\/poppet\/pull\/\d+$/,
  });
  enumValue(summary.engineeringVerdict, ENGINEERING_VERDICTS, 'engineeringVerdict');
  enumValue(summary.productVerdict, PRODUCT_VERDICTS, 'productVerdict');
  validateStringList(summary.evidenceBoundaries, 'evidenceBoundaries', { maxLength: 300 });
  validateStringList(summary.testCommands, 'testCommands', { maxLength: 300 });
  if (!Array.isArray(summary.testResults) || summary.testResults.length > 500
      || !Array.isArray(summary.packageResults) || summary.packageResults.length > 100
      || !Array.isArray(summary.managerScenarios) || summary.managerScenarios.length > 500
      || !Array.isArray(summary.commits) || summary.commits.length > 100) {
    fail('summary result list field is invalid');
  }
  summary.testResults.forEach(validateTestResult);
  summary.packageResults.forEach(validatePackageResult);
  summary.managerScenarios.forEach(validateManagerScenario);
  summary.commits.forEach((commit, index) => {
    const label = `commits[${index}]`;
    exactRequiredKeys(commit, COMMIT_KEYS, label);
    boundedString(commit.sha, `${label}.sha`, {
      min: 40, max: 40, pattern: /^[0-9a-f]{40}$/,
    });
    boundedString(commit.purpose, `${label}.purpose`, { max: 500 });
  });
  validateCiRun(summary.ciRun, summary.gitSha);
  validateAcceptanceBinding(summary.acceptanceBinding, summary.gitSha);
  exactRequiredKeys(summary.failureCounts, new Set(FAILURE_CLASSES), 'failureCounts');
  for (const name of FAILURE_CLASSES) integerInRange(summary.failureCounts[name], 0, 1_000_000, `failureCounts.${name}`);
  validateCorpusCounts(summary.corpusCounts);
  validateHumanTrialCounts(summary.humanTrialCounts);
  validateTimingSummary(summary.timingSummary, summary.humanTrialCounts);
  validatePerformanceSummary(summary.performanceSummary, summary.gitSha);
  validatePerformanceFailureCounts(summary);
  enumValue(summary.rightsStatus, SUMMARY_RIGHTS_STATUSES, 'rightsStatus');
  if (summary.rightsStatus === 'RIGHTS_CLEARED'
      && summary.corpusCounts.rightsClearedSupported < 50) {
    fail('RIGHTS_CLEARED requires at least 50 rights-cleared supported-scope cases');
  }
  if (summary.rightsStatus === 'PARTIALLY_RIGHTS_CLEARED'
      && summary.corpusCounts.rightsClearedSupported === 0) {
    fail('PARTIALLY_RIGHTS_CLEARED requires rights-cleared supported-scope cases');
  }
  if (summary.productVerdict === 'HUMAN_REQUIRED'
      && summary.humanTrialCounts.participants < 5
      && summary.failureCounts.HUMAN_EVIDENCE_UNAVAILABLE < 1) {
    fail('HUMAN_REQUIRED with fewer than five participants requires HUMAN_EVIDENCE_UNAVAILABLE');
  }
  if ((summary.rightsStatus === 'RIGHTS_OR_PROVENANCE_BLOCKED'
      || summary.corpusCounts.rightsClearedSupported < 50)
      && summary.failureCounts.RIGHTS_OR_PROVENANCE_BLOCKED < 1) {
    fail('insufficient rights-cleared corpus requires RIGHTS_OR_PROVENANCE_BLOCKED');
  }
  exactRequiredKeys(summary.nativePlatformStatus, NATIVE_PLATFORM_KEYS, 'nativePlatformStatus');
  enumValue(summary.nativePlatformStatus.windows, NATIVE_EVIDENCE_STATUSES,
    'nativePlatformStatus.windows');
  enumValue(summary.nativePlatformStatus.macos, NATIVE_EVIDENCE_STATUSES,
    'nativePlatformStatus.macos');
  enumValue(summary.nativePlatformStatus.signingNotarization, SIGNING_STATUSES,
    'nativePlatformStatus.signingNotarization');
  validateStringList(summary.remainingGates, 'remainingGates', { maxLength: 1_000 });
  if (summary.nextAction !== null) boundedString(summary.nextAction, 'nextAction', { max: 1_000 });
  validateAcceptedVerdicts(summary, acceptanceEvidence);
  return summary;
}

function assertSummaryPrivacySafe(value, location = 'summary') {
  if (Buffer.isBuffer(value) || ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    fail(`${location} contains binary bytes`);
  }
  if (Array.isArray(value)) {
    for (const [index, entry] of dataOnlyArrayEntries(value, location)) {
      assertSummaryPrivacySafe(entry, `${location}[${index}]`);
    }
    return;
  }
  if (isPlainObject(value)) {
    for (const [key, entry] of dataOnlyObjectEntries(value, location)) {
      const explicitlyAllowedEvidenceKey = key === 'url' && location === 'summary.ciRun';
      if (isForbiddenPrivateKey(key) && !explicitlyAllowedEvidenceKey) {
        fail(`${location} contains forbidden private key: ${key}`);
      }
      assertSummaryPrivacySafe(entry, `${location}.${key}`);
    }
    return;
  }
  if (typeof value !== 'string') return;
  const allowedEvidenceUrl = (location === 'summary.pr' || location === 'summary.ciRun.url')
    && /^https:\/\/github\.com\/SioYooo\/poppet\/(?:pull|actions\/runs)\/\d+$/.test(value);
  assertPrivacySafeString(value, location, { allowEvidenceUrl: allowedEvidenceUrl });
}

function validateExistingAncestors(root, target) {
  const rootStat = fs.lstatSync(root);
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    fail(`artifact trust root is not a regular directory: ${root}`);
  }
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('artifact path escapes its project trust root');
  }
  const parts = relative ? relative.split(path.sep) : [];
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    if (!fs.existsSync(current)) break;
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) fail(`artifact path is not a regular directory: ${current}`);
  }
}

export function resolveArtifactDirectory(requested = null, {
  artifactsRoot = ARTIFACTS_ROOT,
  projectRoot = PROJECT_ROOT,
  label = 'run',
  now = new Date(),
} = {}) {
  const trustRoot = path.resolve(projectRoot);
  const root = path.resolve(artifactsRoot);
  const rootRelative = path.relative(trustRoot, root);
  if (!rootRelative || rootRelative.startsWith('..') || path.isAbsolute(rootRelative)) {
    fail('artifact root must be a child of the project root');
  }
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const target = path.resolve(requested || path.join(root, `${stamp}-${label}`));
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    fail('artifact output must be a child of .artifacts/core-loop');
  }
  // Start at the project trust root so a symlink or file at `.artifacts`,
  // `core-loop`, or any other existing ancestor cannot be hidden by choosing
  // an apparently safe artifactsRoot below it.
  validateExistingAncestors(trustRoot, target);
  return { root, target };
}

export function writeLocalArtifacts({ directory, records, summary, markdown }) {
  const { root, target } = resolveArtifactDirectory(directory);
  if (!Array.isArray(records)) fail('records must be an array');
  for (const record of records) validateCaseRecord(record);
  validateMilestoneSummary(summary);
  if (typeof markdown !== 'string') fail('markdown artifact must be a string');
  const markdownText = markdown.trim();
  assertPrivacySafeString(markdownText, 'markdown artifact');
  const serializedRecords = records.map((record, index) => {
    let serialized;
    let snapshot;
    try {
      serialized = JSON.stringify(record);
      snapshot = JSON.parse(serialized);
    } catch {
      fail(`records[${index}] cannot be serialized as JSON data`);
    }
    validateCaseRecord(snapshot);
    return serialized;
  });
  let serializedSummary;
  let summarySnapshot;
  try {
    serializedSummary = JSON.stringify(summary, null, 2);
    summarySnapshot = JSON.parse(serializedSummary);
  } catch {
    fail('summary cannot be serialized as JSON data');
  }
  validateMilestoneSummary(summarySnapshot);
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target, { recursive: false });
  const jsonl = serializedRecords.join('\n');
  fs.writeFileSync(path.join(target, 'cases.jsonl'), jsonl ? `${jsonl}\n` : '');
  fs.writeFileSync(path.join(target, 'summary.json'), `${serializedSummary}\n`);
  fs.writeFileSync(path.join(target, 'report.md'), `${markdownText}\n`);
  return path.relative(PROJECT_ROOT, target).split(path.sep).join('/');
}

export function renderLocalRunMarkdown({ title, summary, auxiliaryNote = null }) {
  validateMilestoneSummary(summary);
  boundedString(title, 'markdown title', { max: 200 });
  assertPrivacySafeString(title, 'markdown title');
  if (auxiliaryNote !== null) {
    boundedString(auxiliaryNote, 'markdown auxiliary note', { max: 1_000 });
    assertPrivacySafeString(auxiliaryNote, 'markdown auxiliary note');
  }
  const corpus = summary.corpusCounts;
  const markdown = [
    `# ${title}`,
    '',
    `Generated: ${summary.generatedAt || 'NOT_RUN'}`,
    `Git SHA: ${summary.gitSha || 'UNRECORDED'}`,
    `Engineering verdict: \`${summary.engineeringVerdict}\``,
    `Product verdict: \`${summary.productVerdict}\``,
    '',
    '## Evidence boundary',
    '',
    auxiliaryNote || 'Developer-only local evidence; no human or hosted claim.',
    '',
    '## Corpus counts',
    '',
    `- Supported: ${corpus.supported ?? 0}`,
    `- Recovery: ${corpus.recovery ?? 0}`,
    `- Unsupported: ${corpus.unsupported ?? 0}`,
    `- Rights-cleared supported claim cases: ${corpus.rightsClearedSupported ?? 0}`,
    `- Synthetic auxiliary cases: ${corpus.syntheticAuxiliary ?? 0}`,
    '',
    '## Failures',
    '',
    ...FAILURE_CLASSES.filter(name => summary.failureCounts[name] > 0)
      .map(name => `- ${name}: ${summary.failureCounts[name]}`),
    ...(FAILURE_CLASSES.every(name => summary.failureCounts[name] === 0) ? ['- None recorded'] : []),
    '',
    '## Next action',
    '',
    summary.nextAction || 'Not set.',
  ].join('\n');
  assertPrivacySafeString(markdown, 'rendered markdown');
  return markdown;
}
