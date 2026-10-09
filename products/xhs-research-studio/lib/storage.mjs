import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { normalizeHarvest } from './normalize.mjs';
import { analyze } from './analysis.mjs';

export function makeId(prefix='id') {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(3).toString('hex')}`;
}

export async function ensureData(dataDir) {
  await fs.mkdir(dataDir, {recursive:true});
  await fs.mkdir(path.join(dataDir,'snapshots'), {recursive:true});
  const projects = path.join(dataDir,'projects.json');
  try { await fs.access(projects); } catch { await fs.writeFile(projects, '[]\n'); }
}

async function readJson(file, fallback=null) {
  try { return JSON.parse(await fs.readFile(file,'utf8')); } catch { return fallback; }
}

async function writeJson(file, data) {
  await fs.mkdir(path.dirname(file), {recursive:true});
  await fs.writeFile(file, JSON.stringify(data,null,2) + '\n');
}

export async function getProjects(dataDir) {
  await ensureData(dataDir);
  return await readJson(path.join(dataDir,'projects.json'), []);
}

export async function saveProjects(dataDir, projects) {
  await writeJson(path.join(dataDir,'projects.json'), projects);
}

export async function getProject(dataDir, id) {
  return (await getProjects(dataDir)).find(p => p.id === id) || null;
}

export async function listSnapshots(dataDir, projectId) {
  const dir = path.join(dataDir,'snapshots',projectId);
  try {
    const files = (await fs.readdir(dir)).filter(x => x.endsWith('.json')).sort();
    const out = [];
    for (const f of files) {
      const s = await readJson(path.join(dir,f));
      if (s) out.push({id:s.id, createdAt:s.createdAt, source:s.harvest?.source, analysis:s.analysis});
    }
    return out;
  } catch { return []; }
}

export async function loadSnapshot(dataDir, projectId, snapshotId) {
  return await readJson(path.join(dataDir,'snapshots',projectId,`${snapshotId}.json`));
}

export async function saveSnapshot(dataDir, projectId, raw) {
  const harvest = normalizeHarvest(raw);
  const snapshot = {
    id: makeId('snap'),
    projectId,
    createdAt: harvest.source.capturedAt || new Date().toISOString(),
    harvest,
  };
  snapshot.analysis = analyze(harvest);
  await writeJson(path.join(dataDir,'snapshots',projectId,`${snapshot.id}.json`), snapshot);
  return snapshot;
}
