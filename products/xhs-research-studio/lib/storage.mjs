import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeHarvest } from './normalize.mjs';
import { analyze } from './analysis.mjs';
import { HarvestValidationError, validateNormalizedHarvest } from './validation.mjs';

const SAFE_ID_RE = /^[A-Za-z0-9._-]+$/u;

export function makeId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

function assertSafeId(value, label='id') {
  if (!SAFE_ID_RE.test(String(value || ''))) throw new HarvestValidationError(`Invalid ${label}.`, [{path:label,message:'Only letters, numbers, dot, underscore and dash are allowed.'}], 400);
}

function hydrateSnapshot(snapshot) {
  if (!snapshot || !snapshot.harvest) return snapshot;
  const analysis = snapshot.analysis;
  const stale = !analysis
    || !analysis.methodology
    || !analysis.quality
    || !analysis.engagement?.model
    || !Array.isArray(analysis.evidenceClusters);
  if (!stale) return snapshot;
  return {
    ...snapshot,
    analysis: analyze(snapshot.harvest),
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
    const snapshot = hydrateSnapshot(await readJson(path.join(dir,file)));
    if (!snapshot) continue;
    out.push({
      id:snapshot.id,
      createdAt:snapshot.createdAt,
      source:snapshot.harvest?.source,
      quality:snapshot.analysis?.quality,
      coverage:snapshot.analysis?.coverage,
    });
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
  const harvest = normalizeHarvest(raw);
  const validation = validateNormalizedHarvest(harvest);
  if (!validation.ok) throw new HarvestValidationError('Normalized Harvest payload failed v2 validation.', validation.errors, 400);
  const snapshot = {
    id: makeId('snap'),
    projectId,
    createdAt: harvest.source.capturedAt || new Date().toISOString(),
    harvest,
    validation: { warnings: validation.warnings },
  };
  snapshot.analysis = analyze(harvest);
  await writeJsonAtomic(path.join(dataDir,'snapshots',projectId,`${snapshot.id}.json`), snapshot);
  return snapshot;
}
