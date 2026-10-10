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

export function hmacSha256Hex(value, key) {
  const secret = String(key ?? '');
  if (!secret) throw new TypeError('HMAC integrity key is required');
  return crypto.createHmac('sha256', secret).update(canonicalJson(value), 'utf8').digest('hex');
}

function safeDigestEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (!/^[a-f0-9]{64}$/u.test(a) || !/^[a-f0-9]{64}$/u.test(b)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
}

export function makeIntegrity(value, scope, options = {}) {
  if (!scope || typeof scope !== 'string') throw new TypeError('integrity scope is required');
  const key = String(options.key ?? '');
  if (key) {
    return Object.freeze({
      algorithm: 'hmac-sha256',
      canonicalization: 'sorted-json-v1',
      scope,
      authenticated: true,
      keyId: String(options.keyId || 'default'),
      digest: hmacSha256Hex(value, key),
    });
  }
  return Object.freeze({
    algorithm: 'sha256',
    canonicalization: 'sorted-json-v1',
    scope,
    authenticated: false,
    digest: sha256Hex(value),
  });
}

export function verifyIntegrity(value, integrity, expectedScope = '', options = {}) {
  const errors = [];
  if (!integrity || typeof integrity !== 'object') {
    errors.push({path:'integrity',message:'integrity metadata is missing'});
    return {ok:false, authenticated:false, errors, actualDigest:sha256Hex(value)};
  }
  if (integrity.canonicalization !== 'sorted-json-v1') errors.push({path:'integrity.canonicalization',message:'unsupported canonicalization'});
  if (expectedScope && integrity.scope !== expectedScope) errors.push({path:'integrity.scope',message:`expected ${expectedScope}`});
  if (typeof integrity.digest !== 'string' || !/^[a-f0-9]{64}$/u.test(integrity.digest)) {
    errors.push({path:'integrity.digest',message:'digest must be a lowercase SHA-256 hex string'});
  }

  let actualDigest = null;
  let authenticated = false;
  if (integrity.algorithm === 'sha256') {
    actualDigest = sha256Hex(value);
    if (integrity.authenticated === true) errors.push({path:'integrity.authenticated',message:'plain SHA-256 cannot be marked authenticated'});
  } else if (integrity.algorithm === 'hmac-sha256') {
    const key = String(options.key ?? '');
    if (!key) {
      errors.push({path:'integrity.key',message:'HMAC verification key is unavailable'});
    } else {
      actualDigest = hmacSha256Hex(value, key);
      authenticated = true;
    }
    if (integrity.authenticated !== true) errors.push({path:'integrity.authenticated',message:'HMAC metadata must be marked authenticated'});
    if (!String(integrity.keyId || '').trim()) errors.push({path:'integrity.keyId',message:'HMAC metadata requires keyId'});
    if (options.keyId && integrity.keyId !== options.keyId) errors.push({path:'integrity.keyId',message:`expected keyId ${options.keyId}`});
  } else {
    errors.push({path:'integrity.algorithm',message:'supported algorithms are sha256 and hmac-sha256'});
  }

  if (actualDigest && typeof integrity.digest === 'string' && /^[a-f0-9]{64}$/u.test(integrity.digest) && !safeDigestEqual(actualDigest, integrity.digest)) {
    errors.push({path:'integrity.digest',message:'digest does not match canonical content'});
  }
  return {
    ok:errors.length===0,
    authenticated:errors.length===0 && authenticated,
    checksumOnly:errors.length===0 && integrity.algorithm==='sha256',
    errors,
    actualDigest,
  };
}

export function assertIntegrity(value, integrity, expectedScope = '', options = {}) {
  const result = verifyIntegrity(value, integrity, expectedScope, options);
  if (!result.ok) throw new IntegrityError('Evidence integrity verification failed.', result.errors);
  return result;
}
