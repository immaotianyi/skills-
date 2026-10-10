import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeHarvest } from './normalize.mjs';
import { analyze } from './analysis.mjs';
import { makeIntegrity, verifyIntegrity, IntegrityError } from './integrity.mjs';
import { HarvestValidationError, validateHarvestInput, validateNormalizedHarvest } from './validation.mjs';

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/u;
const SNAPSHOT_SCOPE='xhs-harvest-snapshot-evidence-v1';
const projectMutationQueues = new Map();

export function makeId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function assertSafeId(value, label='id') {
  if (!SAFE_ID_RE.test(String(value || ''))) throw new HarvestValidationError(`Invalid ${label}.`, [{path:label,message:'Only letters, numbers, dot, underscore and dash are allowed.'}], 400);
}

function integrityOptions() {
  const key=String(process.env.XHS_STUDIO_INTEGRITY_KEY||'');
  if(key && Buffer.byteLength(key,'utf8')<32) throw new IntegrityError('XHS_STUDIO_INTEGRITY_KEY must be at least 32 UTF-8 bytes.',[{path:'environment.XHS_STUDIO_INTEGRITY_KEY',message:'Use a high-entropy secret of at least 32 bytes.'}]);
  return {key,keyId:String(process.env.XHS_STUDIO_INTEGRITY_KEY_ID||'local-v1')};
}

function verifySnapshotEvidence(snapshot) {
  if (!snapshot?.harvest) return {verified:false,unsigned:false,authenticated:false,checksumOnly:false,errors:[{path:'harvest',message:'snapshot harvest is missing'}]};
  if (!snapshot.integrity) return {verified:false,unsigned:true,authenticated:false,checksumOnly:false,errors:[]};
  const result=verifyIntegrity(snapshot.harvest,snapshot.integrity,SNAPSHOT_SCOPE,integrityOptions());
  if(!result.ok) throw new IntegrityError('Stored snapshot evidence failed integrity verification.',result.errors);
  return {
    verified:true,
    unsigned:false,
    authenticated:result.authenticated,
    checksumOnly:result.checksumOnly,
    errors:[],
    digest:result.actualDigest,
    keyId:snapshot.integrity.keyId||null,
  };
}

function hydrateSnapshot(snapshot) {
  if (!snapshot || !snapshot.harvest) return snapshot;
  const integrityStatus=verifySnapshotEvidence(snapshot);
  const analysis = snapshot.analysis;
  const stale = !analysis
    || !analysis.methodology
    || !analysis.quality
    || !analysis.engagement?.model
    || !Array.isArray(analysis.evidenceClusters);
  if (!stale) return {...snapshot,integrityStatus};
  return {
    ...snapshot,
    analysis: analyze(snapshot.harvest),
    integrityStatus,
    migration: {
      ...(snapshot.migration || {}),
      analysisRecomputedInMemory: true,
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
    try {
      const snapshot = hydrateSnapshot(await readJson(path.join(dir,file)));
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
      out.push({id:path.basename(file,'.json'),createdAt:null,integrityStatus:{verified:false,unsigned:false,authenticated:false,checksumOnly:false,errors:err.details}});
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
    integrity:makeIntegrity(harvest,SNAPSHOT_SCOPE,integrityOptions()),
    validation: { inputWarnings:inputValidation.warnings, warnings: validation.warnings },
  };
  snapshot.analysis = analyze(harvest);
  await writeJsonAtomic(path.join(dataDir,'snapshots',projectId,`${snapshot.id}.json`), snapshot);
  return hydrateSnapshot(snapshot);
}

export const storageIntegrity = Object.freeze({snapshotScope:SNAPSHOT_SCOPE});
