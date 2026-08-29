'use strict';

const {
  STUDIO_CONTRACT_VERSION,
  STUDIO_ERROR_CODES,
  isPlainRecord,
  unavailableError,
} = require('./contracts');

const DISABLED_CAPABILITIES = Object.freeze({
  schemaVersion: STUDIO_CONTRACT_VERSION,
  available: false,
  operations: Object.freeze([]),
  reason: 'not-configured',
});

function invalidConfiguration() {
  const error = new Error('Studio configuration is unsupported until a provider is explicitly implemented.');
  error.code = STUDIO_ERROR_CODES.INVALID_INPUT;
  return error;
}

function rejectUnavailable() {
  return Promise.reject(unavailableError());
}

// The only current client is intentionally inert. It owns no timers, performs
// no I/O, reads no credentials and accepts no endpoint. Adding a real provider
// requires a separate reviewed implementation; passing configuration here must
// never silently turn Core into a networked application.
function createStudioClient(options = {}) {
  if (!isPlainRecord(options) || Object.keys(options).length) throw invalidConfiguration();

  return Object.freeze({
    isAvailable: () => false,
    getCapabilities: () => DISABLED_CAPABILITIES,
    createPoppet: rejectUnavailable,
    getJob: rejectUnavailable,
    cancelJob: rejectUnavailable,
  });
}

module.exports = {
  DISABLED_CAPABILITIES,
  createStudioClient,
};
