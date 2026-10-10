import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvidencePack } from '../lib/evidence-pack.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath=path.join(root,'server.mjs');
const demoPath=path.join(root,'public','demo-harvest.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const snapshotKey='api-v12-snapshot-integrity-key-at-least-32-bytes-2026';
const packKey='api-v12-pack-integrity-key-at-least-32-bytes-2026';

async function waitForHealth(base,{child,diagnostics}={}){
  for(let i=0;i<200;i++){
    if(child?.exitCode!==null||child?.signalCode!==null)break;
    try{const r=await fetch(`${base}/api/health`);if(r.ok)return}catch{}
    await sleep(50);
  }
  throw new Error(`server did not become healthy\n${diagnostics?.()||''}`);
}

async function createProjectAndIngest(base){
  const projectResponse=await fetch(`${base}/api/projects`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Evidence Pack API v1.2'}),
  });
  assert.equal(projectResponse.status,201);
  const project=await projectResponse.json();
  const demo=JSON.parse(await fs.readFile(demoPath,'utf8'));
  const ingestResponse=await fetch(`${base}/api/projects/${project.id}/ingest`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(demo),
  });
  assert.equal(ingestResponse.status,201);
  return {project, snapshot:await ingestResponse.json()};
}

async function runServer(env,fn){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-api-v12-'));
  const port=57000+Math.floor(Math.random()*500);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{
    env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir,...env},
    stdio:['ignore','pipe','pipe'],
  });
  let logs='';
  child.stdout.on('data',chunk=>{logs=(logs+chunk.toString('utf8')).slice(-12000)});
  child.stderr.on('data',chunk=>{logs=(logs+chunk.toString('utf8')).slice(-12000)});
  const diagnostics=()=>`server exitCode=${child.exitCode} signal=${child.signalCode}\n--- server logs ---\n${logs}`;
  try{
    await waitForHealth(base,{child,diagnostics});
    await fn(base);
  } finally {
    if(child.exitCode===null&&child.signalCode===null){
      const exited=new Promise(resolve=>child.once('exit',resolve));
      child.kill('SIGTERM');
      await Promise.race([exited,sleep(2000)]);
    }
    await fs.rm(dataDir,{recursive:true,force:true});
  }
}

test('HTTP Evidence Pack keeps v1.1 compatibility and offers authenticated v1.2 with explicit negotiation',{timeout:30000},async()=>{
  await runServer({
    XHS_STUDIO_INTEGRITY_KEY:snapshotKey,
    XHS_STUDIO_INTEGRITY_KEY_ID:'snapshot-api-v1',
    XHS_STUDIO_PACK_INTEGRITY_KEY:packKey,
    XHS_STUDIO_PACK_INTEGRITY_KEY_ID:'pack-api-v1',
  },async base=>{
    const {project,snapshot}=await createProjectAndIngest(base);
    assert.equal(snapshot.integrityStatus.authenticated,true);

    const legacyResponse=await fetch(`${base}/api/projects/${project.id}/evidence-pack`);
    assert.equal(legacyResponse.status,200);
    const legacy=await legacyResponse.json();
    assert.equal(legacy.schemaVersion,'xhs-evidence-pack/1.1');

    const forbiddenDowngrade=await fetch(`${base}/api/projects/${project.id}/evidence-pack?requireAuthenticated=1`);
    assert.equal(forbiddenDowngrade.status,409);
    assert.match((await forbiddenDowngrade.json()).error,/version 1\.2/i);

    const modernResponse=await fetch(`${base}/api/projects/${project.id}/evidence-pack?version=1.2&requireAuthenticated=1`);
    assert.equal(modernResponse.status,200);
    assert.equal(modernResponse.headers.get('x-xhs-evidence-pack-version'),'1.2');
    assert.equal(modernResponse.headers.get('x-xhs-evidence-pack-authenticated'),'true');
    const modern=await modernResponse.json();
    assert.equal(modern.schemaVersion,'xhs-evidence-pack/1.2');
    assert.equal(modern.snapshot.integrityStatus.authenticated,true);
    assert.equal(modern.integrity.algorithm,'hmac-sha256');
    const verification=verifyEvidencePack(modern,{key:packKey,keyId:'pack-api-v1'});
    assert.equal(verification.ok,true);
    assert.equal(verification.authenticated,true);

    const unsupported=await fetch(`${base}/api/projects/${project.id}/evidence-pack?version=9.9`);
    assert.equal(unsupported.status,400);
    assert.match((await unsupported.json()).error,/unsupported evidence pack version/i);
  });
});

test('HTTP v1.2 authenticated mode fails closed when snapshot or pack authentication is unavailable',{timeout:30000},async()=>{
  await runServer({},async base=>{
    const {project}=await createProjectAndIngest(base);
    const response=await fetch(`${base}/api/projects/${project.id}/evidence-pack?version=1.2&requireAuthenticated=1`);
    assert.equal(response.status,409);
    assert.match((await response.json()).error,/authenticated evidence pack requires/i);

    const checksumResponse=await fetch(`${base}/api/projects/${project.id}/evidence-pack?version=1.2`);
    assert.equal(checksumResponse.status,200);
    assert.equal(checksumResponse.headers.get('x-xhs-evidence-pack-authenticated'),'false');
    const checksumPack=await checksumResponse.json();
    assert.equal(checksumPack.integrity.algorithm,'sha256');
    assert.equal(verifyEvidencePack(checksumPack).ok,true);
  });
});
