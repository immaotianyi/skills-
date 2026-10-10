const CAPTURE_METHODS = new Set(['initial_state','rendered_dom','ocr','mixed','unknown']);
const RISK_STATES = new Set(['NORMAL','THROTTLED','LOGIN_REQUIRED','CAPTCHA','ACCESS_DENIED','BLOCKED']);
const ENTRIES = new Set(['search','profile','note','shortlink','topic','feed','mixed','unknown']);

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isValidDateTime(v) {
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v));
}

function pathError(errors, path, message) {
  errors.push({ path, message });
}

function pathWarning(warnings, path, message) {
  warnings.push({ path, message });
}

export class HarvestValidationError extends Error {
  constructor(message, details = [], statusCode = 400) {
    super(message);
    this.name = 'HarvestValidationError';
    this.details = details;
    this.statusCode = statusCode;
  }
}

export function validateHarvestInput(raw, options = {}) {
  const errors = [];
  const warnings = [];
  const strictV2 = options.strictV2 ?? raw?.schemaVersion === '2.0';
  const maxNotes = options.maxNotes ?? 20_000;
  const maxComments = options.maxComments ?? 200_000;
  const maxQueries = options.maxQueries ?? 5_000;

  if (!isObject(raw)) {
    pathError(errors, '$', 'Harvest payload must be a JSON object.');
    return { ok: false, errors, warnings };
  }

  if (raw.schemaVersion != null && typeof raw.schemaVersion !== 'string') {
    pathError(errors, '$.schemaVersion', 'schemaVersion must be a string when provided.');
  }
  if (strictV2 && raw.schemaVersion !== '2.0') {
    pathError(errors, '$.schemaVersion', 'Strict Harvest v2 input must use schemaVersion "2.0".');
  }

  if (raw.source != null && !isObject(raw.source)) {
    pathError(errors, '$.source', 'source must be an object.');
  }
  if (strictV2 && !isObject(raw.source)) {
    pathError(errors, '$.source', 'Harvest v2 requires a source object.');
  }
  if (isObject(raw.source)) {
    if (strictV2 && raw.source.platform !== 'xiaohongshu') {
      pathError(errors, '$.source.platform', 'Harvest v2 source.platform must be "xiaohongshu".');
    }
    if (strictV2 && !isValidDateTime(raw.source.capturedAt)) {
      pathError(errors, '$.source.capturedAt', 'Harvest v2 source.capturedAt must be a parseable date-time string.');
    } else if (raw.source.capturedAt != null && !isValidDateTime(raw.source.capturedAt)) {
      pathWarning(warnings, '$.source.capturedAt', 'capturedAt is not a parseable date-time and will be normalized.');
    }
    if (raw.source.entry != null && !ENTRIES.has(String(raw.source.entry))) {
      pathWarning(warnings, '$.source.entry', `Unknown entry "${raw.source.entry}" will be normalized to "unknown".`);
    }
    if (raw.source.captureMethod != null && !CAPTURE_METHODS.has(String(raw.source.captureMethod))) {
      pathWarning(warnings, '$.source.captureMethod', `Unknown captureMethod "${raw.source.captureMethod}" will be normalized to "unknown".`);
    }
  }

  const arrayFields = ['notes','comments','authors','queries'];
  for (const field of arrayFields) {
    if (raw[field] != null && !Array.isArray(raw[field])) {
      pathError(errors, `$.${field}`, `${field} must be an array when provided.`);
    }
    if (strictV2 && !Array.isArray(raw[field])) {
      pathError(errors, `$.${field}`, `Harvest v2 requires ${field} as an array.`);
    }
  }

  const notes = Array.isArray(raw.notes) ? raw.notes : [];
  const comments = Array.isArray(raw.comments) ? raw.comments : [];
  const queries = Array.isArray(raw.queries) ? raw.queries : [];
  if (notes.length > maxNotes) pathError(errors, '$.notes', `Too many notes: ${notes.length}; limit is ${maxNotes}.`);
  if (comments.length > maxComments) pathError(errors, '$.comments', `Too many comments: ${comments.length}; limit is ${maxComments}.`);
  if (queries.length > maxQueries) pathError(errors, '$.queries', `Too many queries: ${queries.length}; limit is ${maxQueries}.`);

  notes.forEach((note, i) => {
    const p = `$.notes[${i}]`;
    if (!isObject(note)) {
      pathError(errors, p, 'Each note must be an object.');
      return;
    }
    if (strictV2 && !String(note.noteId ?? '').trim()) pathError(errors, `${p}.noteId`, 'noteId is required for Harvest v2 notes.');
    if (note.stats != null && !isObject(note.stats)) pathError(errors, `${p}.stats`, 'stats must be an object.');
    if (strictV2 && !isObject(note.stats)) pathError(errors, `${p}.stats`, 'stats is required for Harvest v2 notes.');
    if (note.author != null && !isObject(note.author)) pathError(errors, `${p}.author`, 'author must be an object.');
    if (strictV2 && !isObject(note.author)) pathError(errors, `${p}.author`, 'author is required for Harvest v2 notes.');
    if (note.comments != null && !Array.isArray(note.comments)) pathError(errors, `${p}.comments`, 'nested comments must be an array.');
    if (note.confidence != null) {
      const c = Number(note.confidence);
      if (!Number.isFinite(c) || c < 0 || c > 1) pathError(errors, `${p}.confidence`, 'confidence must be between 0 and 1.');
    }
    if (note.captureMethod != null && !CAPTURE_METHODS.has(String(note.captureMethod))) {
      pathWarning(warnings, `${p}.captureMethod`, `Unknown captureMethod "${note.captureMethod}" will be normalized to "unknown".`);
    }
  });

  comments.forEach((comment, i) => {
    const p = `$.comments[${i}]`;
    if (!isObject(comment)) {
      pathError(errors, p, 'Each comment must be an object.');
      return;
    }
    if (strictV2 && !String(comment.content ?? '').trim()) pathError(errors, `${p}.content`, 'content is required for Harvest v2 comments.');
  });

  queries.forEach((query, i) => {
    const p = `$.queries[${i}]`;
    if (!isObject(query)) {
      pathError(errors, p, 'Each query must be an object.');
      return;
    }
    if (strictV2 && !String(query.keyword ?? '').trim()) pathError(errors, `${p}.keyword`, 'keyword is required for Harvest v2 queries.');
    if (query.results != null && !Array.isArray(query.results)) {
      pathError(errors, `${p}.results`, 'query.results must be an array.');
      return;
    }
    for (const [j, result] of (query.results || []).entries()) {
      const rp = `${p}.results[${j}]`;
      if (!isObject(result)) {
        pathError(errors, rp, 'Each query result must be an object.');
        continue;
      }
      if (result.rankingPosition != null) {
        const rank = Number(result.rankingPosition);
        if (!Number.isInteger(rank) || rank < 1) pathError(errors, `${rp}.rankingPosition`, 'rankingPosition must be a positive integer.');
      }
    }
  });

  if (raw.meta != null && !isObject(raw.meta)) pathError(errors, '$.meta', 'meta must be an object.');
  if (strictV2 && !isObject(raw.meta)) pathError(errors, '$.meta', 'Harvest v2 requires a meta object.');
  if (isObject(raw.meta)) {
    if (raw.meta.riskState != null && !RISK_STATES.has(String(raw.meta.riskState))) {
      pathError(errors, '$.meta.riskState', `Unknown riskState "${raw.meta.riskState}".`);
    }
    if (raw.meta.loginRequired === true && raw.meta.riskState === 'NORMAL') {
      pathWarning(warnings, '$.meta', 'loginRequired=true conflicts with riskState=NORMAL. Prefer LOGIN_REQUIRED.');
    }
    if (raw.meta.riskState === 'CAPTCHA' && raw.meta.loginRequired === false) {
      pathWarning(warnings, '$.meta', 'CAPTCHA state should be treated as a hard collection stop regardless of loginRequired.');
    }
  }

  return { ok: errors.length === 0, errors, warnings };
}

export function assertHarvestInput(raw, options = {}) {
  const result = validateHarvestInput(raw, options);
  if (!result.ok) throw new HarvestValidationError('Invalid Harvest payload.', result.errors, 400);
  return result;
}

export function validateNormalizedHarvest(raw) {
  return validateHarvestInput(raw, { strictV2: true });
}

export const validationConstants = Object.freeze({
  captureMethods: [...CAPTURE_METHODS],
  riskStates: [...RISK_STATES],
  entries: [...ENTRIES],
});
