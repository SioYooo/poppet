// Developer-only, network-free finalizer for detached Core-loop acceptance
// evidence. Inputs must already be privacy-safe aggregates; raw metric samples
// are re-read only to verify their binding and are never copied into output.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  PROJECT_ROOT,
  acceptanceEvidenceDigest,
  performanceEvidenceBindingDigest,
  resolveArtifactDirectory,
  validateMilestoneSummary,
} from './core-loop-contract.mjs';
import {
  projectVerifiedPerformanceEvidence,
  verifyPerformanceEvidenceBinding,
} from './core-loop-performance-compare.mjs';

export const ACCEPTANCE_BINDING_VERSION = 'core-loop-acceptance-binding-v1';
export const DEFAULT_REPORT_CARRIER_MODE = 'DETACHED_ARTIFACT';

const modulePath = fileURLToPath(import.meta.url);
const REPORT_CARRIER_MODES = new Set([
  'DETACHED_ARTIFACT',
  'DOCS_ONLY_DESCENDANT_OF_SUBJECT',
]);

function finalizationError(message) {
  const error = new Error(message);
  error.code = 'POPPET_CORE_LOOP_ACCEPTANCE_FINALIZATION';
  throw error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, expected, label) {
  if (!isPlainObject(value)) finalizationError(`${label} must be an object`);
  const actual = Object.keys(value);
  for (const key of actual) {
    if (!expected.has(key)) finalizationError(`${label} contains unknown key: ${key}`);
  }
  for (const key of expected) {
    if (!Object.prototype.hasOwnProperty.call(value, key)) {
      finalizationError(`${label} is missing key: ${key}`);
    }
  }
}

function jsonSnapshot(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    finalizationError(`${label} must contain serializable JSON data`);
  }
}

function sameJson(left, right) {
  const canonical = value => {
    if (Array.isArray(value)) return value.map(canonical);
    if (isPlainObject(value)) return Object.fromEntries(Object.keys(value).sort()
      .map(key => [key, canonical(value[key])]));
    return value;
  };
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

function assertProjectFile(file, label) {
  const root = path.resolve(PROJECT_ROOT);
  const target = path.resolve(file);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    finalizationError(`${label} must be a file inside the project trust root`);
  }
  let current = root;
  const parts = relative.split(path.sep);
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      finalizationError(`${label} does not exist`);
    }
    if (stat.isSymbolicLink()) finalizationError(`${label} cannot traverse a symbolic link`);
    const finalPart = index === parts.length - 1;
    if (finalPart ? !stat.isFile() : !stat.isDirectory()) {
      finalizationError(`${label} must be a regular file`);
    }
  }
  return target;
}

function readJsonFile(file, label) {
  const target = assertProjectFile(file, label);
  let value;
  try {
    value = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch (error) {
    if (error?.code === 'POPPET_CORE_LOOP_ACCEPTANCE_FINALIZATION') throw error;
    finalizationError(`${label} must contain valid JSON`);
  }
  return value;
}

function validateAcceptanceSidecar(summary, acceptanceEvidence) {
  exactKeys(acceptanceEvidence, new Set(['ciBundle', 'performanceBundle']),
    'acceptance sidecar');
  exactKeys(acceptanceEvidence.ciBundle, new Set(['ciRun']),
    'acceptance sidecar ciBundle');
  exactKeys(acceptanceEvidence.performanceBundle,
    new Set(['evidenceBinding', 'comparisonProjection']),
    'acceptance sidecar performanceBundle');
  const expectedPerformanceBundle = {
    evidenceBinding: summary.performanceSummary.evidenceBinding,
    comparisonProjection: summary.performanceSummary.soak.comparisonToPreChange,
  };
  if (!sameJson(acceptanceEvidence.ciBundle, { ciRun: summary.ciRun })) {
    finalizationError('acceptance sidecar CI bundle disagrees with the finalized summary');
  }
  if (!sameJson(acceptanceEvidence.performanceBundle, expectedPerformanceBundle)) {
    finalizationError('acceptance sidecar performance bundle disagrees with the finalized summary');
  }
  if (summary.acceptanceBinding.ciEvidenceDigest
      !== acceptanceEvidenceDigest('ci', acceptanceEvidence.ciBundle)) {
    finalizationError('acceptance CI digest disagrees with the exact sidecar bundle');
  }
  if (summary.acceptanceBinding.performanceEvidenceDigest
      !== acceptanceEvidenceDigest('performance', acceptanceEvidence.performanceBundle)) {
    finalizationError('acceptance performance digest disagrees with the exact sidecar bundle');
  }
}

export function finalizeCoreLoopAcceptance({
  afterSummary,
  verifiedPerformanceEvidence,
  ciBundle,
  reportCarrierMode = DEFAULT_REPORT_CARRIER_MODE,
} = {}) {
  exactKeys(ciBundle, new Set(['ciRun']), 'sanitized CI bundle');
  if (!REPORT_CARRIER_MODES.has(reportCarrierMode)) {
    finalizationError('reportCarrierMode is invalid');
  }
  const {
    comparisonProjection,
    evidenceBinding,
    afterRunSummary,
  } = projectVerifiedPerformanceEvidence(verifiedPerformanceEvidence);
  // Validate the binding shape independently before it is projected into the
  // summary. The digest is deliberately used only as validation here; the
  // acceptance digest covers the complete detached performance bundle.
  performanceEvidenceBindingDigest(evidenceBinding);

  const summary = jsonSnapshot(afterSummary, 'after summary');
  if (!isPlainObject(summary.performanceSummary)
      || !isPlainObject(summary.performanceSummary.soak)) {
    finalizationError('after summary is missing performanceSummary soak evidence');
  }
  if (summary.gitSha !== afterRunSummary.gitSha) {
    finalizationError('after summary Git SHA disagrees with the verified after run');
  }
  const normalizedPerformance = value => {
    const performance = jsonSnapshot(value, 'performance summary');
    delete performance.evidenceBinding;
    performance.soak.comparisonToPreChange = null;
    return performance;
  };
  if (!sameJson(normalizedPerformance(summary.performanceSummary),
    normalizedPerformance(afterRunSummary.performanceSummary))) {
    finalizationError('after summary performance evidence disagrees with the verified after run');
  }
  summary.ciRun = jsonSnapshot(ciBundle.ciRun, 'sanitized CI run');
  summary.performanceSummary.evidenceBinding =
    jsonSnapshot(evidenceBinding, 'performance evidence binding');
  summary.performanceSummary.soak.comparisonToPreChange =
    jsonSnapshot(comparisonProjection, 'performance comparison projection');

  const acceptanceEvidence = {
    ciBundle: { ciRun: jsonSnapshot(summary.ciRun, 'sanitized CI run') },
    performanceBundle: {
      evidenceBinding: jsonSnapshot(
        summary.performanceSummary.evidenceBinding, 'performance evidence binding'),
      comparisonProjection: jsonSnapshot(
        summary.performanceSummary.soak.comparisonToPreChange,
        'performance comparison projection'),
    },
  };
  summary.acceptanceBinding = {
    bindingVersion: ACCEPTANCE_BINDING_VERSION,
    subjectGitSha: summary.gitSha,
    reportCarrierMode,
    ciEvidenceDigest: acceptanceEvidenceDigest('ci', acceptanceEvidence.ciBundle),
    performanceEvidenceDigest: acceptanceEvidenceDigest(
      'performance', acceptanceEvidence.performanceBundle),
  };

  validateAcceptanceSidecar(summary, acceptanceEvidence);
  // Passing the detached sidecar is essential: for an engineering-accepted
  // summary this activates every strict CI, package, Manager, performance,
  // density, SHA, and digest gate in the contract.
  validateMilestoneSummary(summary, { acceptanceEvidence });
  return { summary, acceptanceEvidence };
}

export function finalizeCoreLoopAcceptanceFromFiles({
  afterSummaryFile,
  beforeRunDirectory,
  afterRunDirectory,
  comparisonDirectory,
  ciBundleFile,
  reportCarrierMode = DEFAULT_REPORT_CARRIER_MODE,
} = {}) {
  const afterSummary = readJsonFile(afterSummaryFile, 'after summary file');
  const ciBundle = readJsonFile(ciBundleFile, 'sanitized CI bundle file');
  const verifiedPerformanceEvidence = verifyPerformanceEvidenceBinding({
    beforeDirectory: beforeRunDirectory,
    afterDirectory: afterRunDirectory,
    comparisonDirectory,
  });
  return finalizeCoreLoopAcceptance({
    afterSummary,
    verifiedPerformanceEvidence,
    ciBundle,
    reportCarrierMode,
  });
}

export function writeCoreLoopAcceptanceArtifacts({
  directory,
  summary,
  acceptanceEvidence,
} = {}) {
  validateAcceptanceSidecar(summary, acceptanceEvidence);
  validateMilestoneSummary(summary, { acceptanceEvidence });
  const { root, target } = resolveArtifactDirectory(directory, {
    label: 'core-loop-acceptance',
  });
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(target, { recursive: false });
  fs.writeFileSync(path.join(target, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(path.join(target, 'acceptance-evidence.json'),
    `${JSON.stringify(acceptanceEvidence, null, 2)}\n`);
  return path.relative(PROJECT_ROOT, target).split(path.sep).join('/');
}

function stringArg(args, flag) {
  const index = args.indexOf(flag);
  if (index < 0) return null;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) finalizationError(`${flag} requires a value`);
  return value;
}

export function parseAcceptanceFinalizeArgs(args = process.argv.slice(2)) {
  const valueFlags = new Set([
    '--after-summary', '--before-run', '--after-run', '--comparison', '--ci-bundle',
    '--output', '--report-carrier-mode',
  ]);
  for (let index = 0; index < args.length; index++) {
    if (!valueFlags.has(args[index])) {
      finalizationError(`Unknown acceptance finalization option: ${args[index]}`);
    }
    if (args[index + 1] === undefined || args[index + 1].startsWith('--')) {
      finalizationError(`${args[index]} requires a value`);
    }
    index++;
  }
  const afterSummaryFile = stringArg(args, '--after-summary');
  const beforeRunDirectory = stringArg(args, '--before-run');
  const afterRunDirectory = stringArg(args, '--after-run');
  const comparisonDirectory = stringArg(args, '--comparison');
  const ciBundleFile = stringArg(args, '--ci-bundle');
  const output = stringArg(args, '--output');
  if (!afterSummaryFile || !beforeRunDirectory || !afterRunDirectory
      || !comparisonDirectory || !ciBundleFile) {
    finalizationError('--after-summary, --before-run, --after-run, --comparison, and --ci-bundle are required');
  }
  return {
    afterSummaryFile,
    beforeRunDirectory,
    afterRunDirectory,
    comparisonDirectory,
    ciBundleFile,
    output,
    reportCarrierMode: stringArg(args, '--report-carrier-mode')
      || DEFAULT_REPORT_CARRIER_MODE,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(modulePath)) {
  try {
    const args = parseAcceptanceFinalizeArgs();
    const finalized = finalizeCoreLoopAcceptanceFromFiles(args);
    const { target } = resolveArtifactDirectory(args.output, {
      label: 'core-loop-acceptance',
    });
    const relative = writeCoreLoopAcceptanceArtifacts({
      directory: target,
      ...finalized,
    });
    console.log(`[core-loop-acceptance-finalize] validated artifacts: ${relative}`);
  } catch (error) {
    console.error(`[core-loop-acceptance-finalize] ${error?.code || 'ENVIRONMENT_FAILURE'}: ${error?.message || error}`);
    process.exit(1);
  }
}
