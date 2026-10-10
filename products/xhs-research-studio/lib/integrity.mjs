import crypto from 'node:crypto';

export class IntegrityError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'IntegrityError';
    this.statusCode = 409;
    this.details = details;
  }
}

function canonicalValue(value) {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) return null;
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    const item = value[key];
    if (item === undefined) continue;
    out[key] = canonicalValue(item);
  }
  return out;
}

export function canonicalJson(value) {
  return JSON.stringify(canonicalValue(value));
}

export function sha256Hex(value) {
  return crypto.createHash('sha256').update(canonicalJson(value), 'utf8').digest('hex');
}

export function makeIntegrity(value, scope) {
  if (!scope || typeof scope !== 'string') throw new TypeError('integrity scope is required');
  return Object.freeze({
    algorithm: 'sha256',
    canonicalization: 'sorted-json-v1',
    scope,
    digest: sha256Hex(value),
  });
}

export function verifyIntegrity(value, integrity, expectedScope = '') {
  const errors = [];
  if (!integrity || typeof integrity !== 'object') {
    errors.push({path:'integrity',message:'integrity metadata is missing'});
    return {ok:false, errors, actualDigest:sha256Hex(value)};
  }
  if (integrity.algorithm !== 'sha256') errors.push({path:'integrity.algorithm',message:'only sha256 is supported'});
  if (integrity.canonicalization !== 'sorted-json-v1') errors.push({path:'integrity.canonicalization',message:'unsupported canonicalization'});
  if (expectedScope && integrity.scope !== expectedScope) errors.push({path:'integrity.scope',message:`expected ${expectedScope}`});
  const actualDigest = sha256Hex(value);
  if (typeof integrity.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(integrity.digest)) {
    errors.push({path:'integrity.digest',message:'digest must be a lowercase SHA-256 hex string'});
  } else if (actualDigest !== integrity.digest) {
    errors.push({path:'integrity.digest',message:'digest does not match canonical content'});
  }
  return {ok:errors.length===0, errors, actualDigest};
}

export function assertIntegrity(value, integrity, expectedScope = '') {
  const result = verifyIntegrity(value, integrity, expectedScope);
  if (!result.ok) throw new IntegrityError('Evidence integrity verification failed.', result.errors);
  return result;
}
