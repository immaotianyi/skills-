import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeHarvest } from './normalize.mjs';
import { analyze } from './analysis.mjs';
import { makeIntegrity, verifyIntegrity, IntegrityError } from './integrity.mjs';
import { HarvestValidationError, validateHarvestInput, validateNormalizedHarvest } from './validation.mjs';

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/u;
const SNAPSHOT_SCOPE_V1='xhs-harvest-snapshot-evidence-v1';
const SNAPSHOT_SCOPE_V2='xhs-research-studio-snapshot-record-v2';
const projectMutationQueues = new Map();

export function makeId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function assertSafeId(value, label='id') {
  if (!SAFE_ID_RE.test(String(value || ''))) throw new HarvestValidationError(`Invalid ${label}.`, [{path:label,message:'Only letters, numbers, dot, underscore and dash are allowed.'}], 400);
}

function validateSecret(key, pathLabel) {
  if(key && Buffer.byteLength(key,'utf8')<32) {
    throw new IntegrityError(`${pathLabel} must be at least 32 UTF-8 bytes.`,[{path:`environment.${pathLabel}`,message:'Use a high-entropy secret of at least 32 bytes.'}]);
  }
  return key;
}

function currentIntegrityOptions() {
  const key=validateSecret(String(process.env.XHS_STUDIO_INTEGRITY_KEY||''),'XHS_STUDIO_INTEGRITY_KEY');
  return {key,keyId:String(process.env.XHS_STUDIO_INTEGRITY_KEY_ID||'local-v1')};
}

function integrityKeyring() {
  const raw=String(process.env.XHS_STUDIO_INTEGRITY_KEYRING||'').trim();
  if(!raw) return {};
  let parsed;
  try {
    parsed=JSON.parse(raw);
  } catch {
    throw new IntegrityError('XHS_STUDIO_INTEGRITY_KEYRING must be valid JSON.',[{path:'environment.XHS_STUDIO_INTEGRITY_KEYRING',message:'Expected a JSON object mapping key IDs to historical HMAC secrets.'}]);
  }
  if(!parsed || typeof parsed!=='object' || Array.isArray(parsed)) {
    throw new IntegrityError('XHS_STUDIO_INTEGRITY_KEYRING must be a JSON object.',[{path:'environment.XHS_STUDIO_INTEGRITY_KEYRING',message:'Expected a JSON object mapping key IDs to historical HMAC secrets.'}]);
  }
  const out={};
  for(const [rawKeyId,rawKey] of Object.entries(parsed)) {
    const keyId=String(rawKeyId||'').trim();
    const key=String(rawKey??'');
    if(!keyId) throw new IntegrityError('Integrity keyring contains an empty key ID.',[{path:'environment.XHS_STUDIO_INTEGRITY_KEYRING',message:'Every historical key requires a non-empty key ID.'}]);
    validateSecret(key,'XHS_STUDIO_INTEGRITY_KEYRING');
    if(!key) throw new IntegrityError(`Integrity keyring entry ${keyId} is empty.`,[{path:'environment.XHS_STUDIO_INTEGRITY_KEYRING',message:`Historical key ${keyId} must not be empty.`}]);
    out[keyId]=key;
  }
  return out;
}

function verificationIntegrityOptions(integrity) {
  const current=currentIntegrityOptions();
  if(integrity?.algorithm!=='hmac-sha256') return current;
  const keyId=String(integrity.keyId||'').trim();
  if(current.key && current.keyId===keyId) return current;
  const key=keyId ? integrityKeyring()[keyId]||'' : '';
  return {key,keyId};
}

function snapshotRecordValue(snapshot) {
  return {
    id:snapshot.id,
    projectId:snapshot.projectId,
    createdAt:snapshot.createdAt,
    harvest:snapshot.harvest,
    analysis:snapshot.analysis,
    validation:snapshot.validation,
  };
}

function verifySnapshotEvidence(snapshot) {
  if (!snapshot?.harvest) return {verified:false,unsigned:false,authenticated:false,checksumOnly:false,recordProtected:false,errors:[{path:'harvest',message:'snapshot harvest is missing'}]};
  if (!snapshot.integrity) return {verified:false,unsigned:true,authenticated:false,checksumOnly:false,recordProtected:false,errors:[]};

  let target;
  let recordProtected=false;
  if(snapshot.integrity.scope===SNAPSHOT_SCOPE_V2){
    target=snapshotRecordValue(snapshot);
    recordProtected=true;
  } else if(snapshot.integrity.scope===SNAPSHOT_SCOPE_V1){
    target=snapshot.harvest;
  } else {
    throw new IntegrityError('Stored snapshot uses an unsupported integrity scope.',[{path:'integrity.scope',message:`Unsupported scope ${snapshot.integrity.scope||'(missing)'}.`}]);
  }

  const result=verifyIntegrity(target,snapshot.integrity,snapshot.integrity.scope,verificationIntegrityOptions(snapshot.integrity));
  if(!result.ok) throw new IntegrityError('Stored snapshot evidence failed integrity verification.',result.errors);
  return {
    verified:true,
    unsigned:false,
    authenticated:result.authenticated,
    checksumOnly:result.checksumOnly,
    recordProtected,
    errors:[],
    digest:result.actualDigest,
    keyId:snapshot.integrity.keyId||null,
    scope:snapshot.integrity.scope,
  };
}

function currentAnalysisShape(analysis) {
  return Boolean(analysis)
    && Boolean(analysis.methodology)
    && Boolean(analysis.quality)
    && Boolean(analysis.engagement?.model)
    && Array.isArray(analysis.evidenceClusters);
}

function hydrateSnapshot(snapshot) {
  if (!snapshot || !snapshot.harvest) return snapshot;
  const integrityStatus=verifySnapshotEvidence(snapshot);
  const mustRecompute=!integrityStatus.recordProtected || !currentAnalysisShape(snapshot.analysis);
  if (!mustRecompute) return {...snapshot,integrityStatus};
  return {
    ...snapshot,
    analysis: analyze(snapshot.harvest),
    integrityStatus,
    migration: {
      ...(snapshot.migration || {}),
      analysisRecomputedInMemory: true,
      reason:integrityStatus.recordProtected?'stale-analysis-shape':'derived-analysis-not-covered-by-record-integrity',
    },
  };
}

export async function ensureData(dataDir) {
  await fs.mkdir(dataDir, {recursive:true});
  await fs.mkdir(path.join(dataDir,'snapshots'), {recursive:true});
  const projects = path.join(dataDir,'projects.json');
  try {
    await fs.access(projects);
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    await fs.writeFile(projects, '[]\n', {encoding:'utf8',flag:'wx'}).catch(async writeErr => {
      if (writeErr?.code !== 'EEXIST') throw writeErr;
    });
  }
}

async function readJson(file, fallback=undefined) {
  let text;
  try {
    text = await fs.readFile(file,'utf8');
  } catch (err) {
    if (err?.code === 'ENOENT' && fallback !== undefined) return fallback;
    throw err;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`Corrupt JSON storage file: ${file}: ${err.message}`);
  }
}

async function writeJsonAtomic(file, data) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(data,null,2) + '\n', 'utf8');
    await fs.rename(tmp, file);
  } finally {
    await fs.rm(tmp, {force:true}).catch(()=>{});
  }
}

export async function getProjects(dataDir) {
  await ensureData(dataDir);
  const projects = await readJson(path.join(dataDir,'projects.json'), []);
  if (!Array.isArray(projects)) throw new Error('Corrupt projects.json: root must be an array.');
  return projects;
}

export async function saveProjects(dataDir, projects) {
  if (!Array.isArray(projects)) throw new TypeError('projects must be an array');
  await writeJsonAtomic(path.join(dataDir,'projects.json'), projects);
}

export async function mutateProjects(dataDir, mutator) {
  if (typeof mutator !== 'function') throw new TypeError('mutator must be a function');
  const key = path.resolve(dataDir);
  const previous = projectMutationQueues.get(key) || Promise.resolve();
  const run = previous.catch(()=>{}).then(async () => {
    const projects = await getProjects(dataDir);
    const result = await mutator(projects);
    if (!Array.isArray(projects)) throw new TypeError('project mutator must preserve the projects array');
    await saveProjects(dataDir, projects);
    return result;
  });
  projectMutationQueues.set(key, run.then(()=>undefined,()=>undefined));
  return run;
}

export async function getProject(dataDir, id) {
  assertSafeId(id, 'projectId');
  return (await getProjects(dataDir)).find(p => p.id === id) || null;
}

export async function listSnapshots(dataDir, projectId) {
  assertSafeId(projectId, 'projectId');
  const dir = path.join(dataDir,'snapshots',projectId);
  let files;
  try {
    files = (await fs.readdir(dir)).filter(x => x.endsWith('.json'));
  } catch (err) {
    if (err?.code === 'ENOENT') return [];
    throw err;
  }
  const out = [];
  for (const file of files) {
    const raw=await readJson(path.join(dir,file));
    try {
      const snapshot = hydrateSnapshot(raw);
      if (!snapshot) continue;
      out.push({
        id:snapshot.id,
        createdAt:snapshot.createdAt,
        source:snapshot.harvest?.source,
        quality:snapshot.analysis?.quality,
        coverage:snapshot.analysis?.coverage,
        integrity:snapshot.integrity||null,
        integrityStatus:snapshot.integrityStatus,
      });
    } catch(err) {
      if(!(err instanceof IntegrityError)) throw err;
      out.push({
        id:raw?.id||path.basename(file,'.json'),
        createdAt:raw?.createdAt||raw?.harvest?.source?.capturedAt||null,
        source:raw?.harvest?.source,
        integrity:raw?.integrity||null,
        integrityStatus:{verified:false,unsigned:false,authenticated:false,checksumOnly:false,recordProtected:false,errors:err.details},
      });
    }
  }
  out.sort((a,b) => {
    const at = Date.parse(a.createdAt || '') || 0;
    const bt = Date.parse(b.createdAt || '') || 0;
    return at - bt || String(a.id).localeCompare(String(b.id));
  });
  return out;
}

export async function loadSnapshot(dataDir, projectId, snapshotId) {
  assertSafeId(projectId, 'projectId');
  assertSafeId(snapshotId, 'snapshotId');
  return hydrateSnapshot(await readJson(path.join(dataDir,'snapshots',projectId,`${snapshotId}.json`), null));
}

export async function saveSnapshot(dataDir, projectId, raw) {
  assertSafeId(projectId, 'projectId');
  const inputValidation=validateHarvestInput(raw);
  if (!inputValidation.ok) throw new HarvestValidationError('Invalid Harvest payload.', inputValidation.errors, 400);
  const harvest = normalizeHarvest(raw);
  const validation = validateNormalizedHarvest(harvest);
  if (!validation.ok) throw new HarvestValidationError('Normalized Harvest payload failed v2 validation.', validation.errors, 400);
  const snapshot = {
    id: makeId('snap'),
    projectId,
    createdAt: harvest.source.capturedAt || new Date().toISOString(),
    harvest,
    validation: { inputWarnings:inputValidation.warnings, warnings: validation.warnings },
  };
  snapshot.analysis = analyze(harvest);
  snapshot.integrity=makeIntegrity(snapshotRecordValue(snapshot),SNAPSHOT_SCOPE_V2,currentIntegrityOptions());
  await writeJsonAtomic(path.join(dataDir,'snapshots',projectId,`${snapshot.id}.json`), snapshot);
  return hydrateSnapshot(snapshot);
}

export const storageIntegrity = Object.freeze({snapshotScopeV1:SNAPSHOT_SCOPE_V1,snapshotScopeV2:SNAPSHOT_SCOPE_V2});
