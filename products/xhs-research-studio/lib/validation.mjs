const CAPTURE_METHODS = new Set(['initial_state','rendered_dom','ocr','mixed','unknown']);
const RISK_STATES = new Set(['NORMAL','THROTTLED','LOGIN_REQUIRED','CAPTCHA','ACCESS_DENIED','BLOCKED']);
const ENTRIES = new Set(['search','profile','note','shortlink','topic','feed','mixed','unknown']);

function isObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

function isValidDateTime(v) {
  return typeof v === 'string' && v.trim() !== '' && Number.isFinite(Date.parse(v));
}

function isNonNegativeInteger(v) {
  return Number.isInteger(v) && v >= 0;
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

  if (raw.source != null && !isObject(raw.source)) pathError(errors, '$.source', 'source must be an object.');
  if (strictV2 && !isObject(raw.source)) pathError(errors, '$.source', 'Harvest v2 requires a source object.');
  if (isObject(raw.source)) {
    if (strictV2 && raw.source.platform !== 'xiaohongshu') {
      pathError(errors, '$.source.platform', 'Harvest v2 source.platform must be "xiaohongshu".');
    }
    if (strictV2 && !isValidDateTime(raw.source.capturedAt)) {
      pathError(errors, '$.source.capturedAt', 'Harvest v2 source.capturedAt must be a parseable date-time string.');
    } else if (raw.source.capturedAt != null && !isValidDateTime(raw.source.capturedAt)) {
      pathWarning(warnings, '$.source.capturedAt', 'capturedAt is not a parseable date-time and will be normalized.');
    }
    const entry = String(raw.source.entry ?? '');
    if (strictV2 && !ENTRIES.has(entry)) pathError(errors, '$.source.entry', 'Harvest v2 source.entry must be a known entry type.');
    else if (raw.source.entry != null && !ENTRIES.has(entry)) pathWarning(warnings, '$.source.entry', `Unknown entry "${raw.source.entry}" will be normalized to "unknown".`);

    const method = String(raw.source.captureMethod ?? '');
    if (strictV2 && !CAPTURE_METHODS.has(method)) pathError(errors, '$.source.captureMethod', 'Harvest v2 source.captureMethod is required and must be a known capture method.');
    else if (raw.source.captureMethod != null && !CAPTURE_METHODS.has(method)) pathWarning(warnings, '$.source.captureMethod', `Unknown captureMethod "${raw.source.captureMethod}" will be normalized to "unknown".`);
  }

  const arrayFields = ['notes','comments','authors','queries'];
  for (const field of arrayFields) {
    if (raw[field] != null && !Array.isArray(raw[field])) pathError(errors, `$.${field}`, `${field} must be an array when provided.`);
    if (strictV2 && !Array.isArray(raw[field])) pathError(errors, `$.${field}`, `Harvest v2 requires ${field} as an array.`);
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
    if (isObject(note.stats) && strictV2) {
      for (const key of ['likes','collects','comments','shares']) {
        if (!isNonNegativeInteger(note.stats[key])) pathError(errors, `${p}.stats.${key}`, `${key} must be a non-negative integer in strict Harvest v2.`);
      }
    }
    if (note.author != null && !isObject(note.author)) pathError(errors, `${p}.author`, 'author must be an object.');
    if (strictV2 && !isObject(note.author)) pathError(errors, `${p}.author`, 'author is required for Harvest v2 notes.');
    if (note.comments != null && !Array.isArray(note.comments)) pathError(errors, `${p}.comments`, 'nested comments must be an array.');

    const method = String(note.captureMethod ?? '');
    if (strictV2 && !CAPTURE_METHODS.has(method)) pathError(errors, `${p}.captureMethod`, 'captureMethod is required and must be known for strict Harvest v2 notes.');
    else if (note.captureMethod != null && !CAPTURE_METHODS.has(method)) pathWarning(warnings, `${p}.captureMethod`, `Unknown captureMethod "${note.captureMethod}" will be normalized to "unknown".`);

    if (strictV2 && note.confidence == null) pathError(errors, `${p}.confidence`, 'confidence is required for strict Harvest v2 notes.');
    if (note.confidence != null) {
      const confidence = Number(note.confidence);
      if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) pathError(errors, `${p}.confidence`, 'confidence must be between 0 and 1.');
    }
  });

  comments.forEach((comment, i) => {
    const p = `$.comments[${i}]`;
    if (!isObject(comment)) {
      pathError(errors, p, 'Each comment must be an object.');
      return;
    }
    if (strictV2 && !String(comment.content ?? '').trim()) pathError(errors, `${p}.content`, 'content is required for Harvest v2 comments.');
    if (comment.likes != null && !isNonNegativeInteger(comment.likes)) pathError(errors, `${p}.likes`, 'likes must be a non-negative integer when provided.');
  });

  queries.forEach((query, i) => {
    const p = `$.queries[${i}]`;
    if (!isObject(query)) {
      pathError(errors, p, 'Each query must be an object.');
      return;
    }
    if (strictV2 && !String(query.keyword ?? '').trim()) pathError(errors, `${p}.keyword`, 'keyword is required for Harvest v2 queries.');
    if (strictV2 && !isValidDateTime(query.capturedAt)) pathError(errors, `${p}.capturedAt`, 'capturedAt is required and must be a parseable date-time in strict Harvest v2 queries.');
    if (query.results != null && !Array.isArray(query.results)) {
      pathError(errors, `${p}.results`, 'query.results must be an array.');
      return;
    }
    if (strictV2 && !Array.isArray(query.results)) pathError(errors, `${p}.results`, 'query.results is required in strict Harvest v2.');
    for (const [j, result] of (query.results || []).entries()) {
      const rp = `${p}.results[${j}]`;
      if (!isObject(result)) {
        pathError(errors, rp, 'Each query result must be an object.');
        continue;
      }
      if (strictV2 && result.rankingPosition == null) pathError(errors, `${rp}.rankingPosition`, 'rankingPosition is required in strict Harvest v2 query results.');
      if (result.rankingPosition != null) {
        const rank = Number(result.rankingPosition);
        if (!Number.isInteger(rank) || rank < 1) pathError(errors, `${rp}.rankingPosition`, 'rankingPosition must be a positive integer.');
      }
    }
  });

  if (raw.meta != null && !isObject(raw.meta)) pathError(errors, '$.meta', 'meta must be an object.');
  if (strictV2 && !isObject(raw.meta)) pathError(errors, '$.meta', 'Harvest v2 requires a meta object.');
  if (isObject(raw.meta)) {
    if (strictV2 && !Array.isArray(raw.meta.gaps)) pathError(errors, '$.meta.gaps', 'Harvest v2 meta.gaps must be an array.');
    if (strictV2 && typeof raw.meta.loginRequired !== 'boolean') pathError(errors, '$.meta.loginRequired', 'Harvest v2 meta.loginRequired must be boolean.');
    if (strictV2 && !RISK_STATES.has(String(raw.meta.riskState ?? ''))) pathError(errors, '$.meta.riskState', 'Harvest v2 meta.riskState is required and must be known.');
    else if (raw.meta.riskState != null && !RISK_STATES.has(String(raw.meta.riskState))) pathError(errors, '$.meta.riskState', `Unknown riskState "${raw.meta.riskState}".`);
    if (raw.meta.collected != null && !isNonNegativeInteger(raw.meta.collected)) pathError(errors, '$.meta.collected', 'collected must be a non-negative integer.');
    if (raw.meta.deduped != null && !isNonNegativeInteger(raw.meta.deduped)) pathError(errors, '$.meta.deduped', 'deduped must be a non-negative integer.');
    if (raw.meta.sampleBudget != null && !isNonNegativeInteger(raw.meta.sampleBudget)) pathError(errors, '$.meta.sampleBudget', 'sampleBudget must be a non-negative integer or null.');
    if (raw.meta.loginRequired === true && raw.meta.riskState === 'NORMAL') pathWarning(warnings, '$.meta', 'loginRequired=true conflicts with riskState=NORMAL. Prefer LOGIN_REQUIRED.');
    if (raw.meta.riskState === 'CAPTCHA' && raw.meta.loginRequired === false) pathWarning(warnings, '$.meta', 'CAPTCHA state should be treated as a hard collection stop regardless of loginRequired.');
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
