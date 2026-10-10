import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { spawn } from 'node:child_process';
import net from 'node:net';
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

async function getFreePort(){
  return new Promise((resolve,reject)=>{
    const probe=net.createServer();
    probe.unref();
    probe.once('error',reject);
    probe.listen(0,'127.0.0.1',()=>{
      const address=probe.address();
      const port=typeof address==='object'&&address?address.port:0;
      probe.close(error=>error?reject(error):resolve(port));
    });
  });
}

async function waitForHealth(base,child,diagnostic){
  const deadline=Date.now()+10_000;
  let lastError=null;
  while(Date.now()<deadline){
    if(child.exitCode!==null||child.signalCode!==null){
      throw new Error(`server exited before becoming healthy (exit=${child.exitCode}, signal=${child.signalCode})\n${diagnostic()}`);
    }
    try{
      const response=await fetch(`${base}/api/health`);
      if(response.ok)return;
      lastError=new Error(`health returned HTTP ${response.status}`);
    }catch(error){lastError=error}
    await sleep(50);
  }
  throw new Error(`server did not become healthy within 10s${lastError?`: ${lastError.message}`:''}\n${diagnostic()}`);
}

async function terminate(child){
  if(child.exitCode!==null||child.signalCode!==null)return;
  const exited=new Promise(resolve=>child.once('exit',resolve));
  child.kill('SIGTERM');
  await Promise.race([exited,sleep(1500)]);
  if(child.exitCode===null&&child.signalCode===null){
    child.kill('SIGKILL');
    await Promise.race([exited,sleep(1500)]);
  }
}

async function createProjectAndIngest(base,{name='Evidence Pack API v1.2'}={}){
  const projectResponse=await fetch(`${base}/api/projects`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name}),
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

function assertUnicodeDisposition(response){
  const disposition=response.headers.get('content-disposition')||'';
  assert.match(disposition,/^attachment; filename="[\x20-\x7e]+"; filename\*=UTF-8''/u);
  assert.match(disposition,/%E8%AF%81%E6%8D%AE%E5%8C%85/u);
  assert.equal(/[^\x00-\x7f]/u.test(disposition),false);
}

async function runServer(env,fn){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-api-v12-'));
  const port=await getFreePort();
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{
    env:{...process.env,PORT:String(port),HOST:'127.0.0.1',XHS_STUDIO_DATA:dataDir,...env},
    stdio:['ignore','pipe','pipe'],
  });
  let logs='';
  const capture=chunk=>{logs=(logs+chunk.toString()).slice(-12_000)};
  child.stdout.on('data',capture);
  child.stderr.on('data',capture);
  try{
    await waitForHealth(base,child,()=>logs);
    await fn(base);
  } finally {
    await terminate(child);
    await fs.rm(dataDir,{recursive:true,force:true,maxRetries:5,retryDelay:100});
  }
}

test('HTTP Evidence Pack keeps v1.1 compatibility, Unicode-safe downloads, and authenticated v1.2 negotiation',{timeout:30000},async()=>{
  await runServer({
    XHS_STUDIO_INTEGRITY_KEY:snapshotKey,
    XHS_STUDIO_INTEGRITY_KEY_ID:'snapshot-api-v1',
    XHS_STUDIO_PACK_INTEGRITY_KEY:packKey,
    XHS_STUDIO_PACK_INTEGRITY_KEY_ID:'pack-api-v1',
  },async base=>{
    const {project,snapshot}=await createProjectAndIngest(base,{name:'证据包 API v1.2'});
    assert.equal(snapshot.integrityStatus.authenticated,true);

    const csvResponse=await fetch(`${base}/api/projects/${project.id}/export.csv`);
    assert.equal(csvResponse.status,200);
    assertUnicodeDisposition(csvResponse);
    assert.match(await csvResponse.text(),/noteId,title,author/u);

    const legacyResponse=await fetch(`${base}/api/projects/${project.id}/evidence-pack`);
    assert.equal(legacyResponse.status,200);
    assertUnicodeDisposition(legacyResponse);
    const legacy=await legacyResponse.json();
    assert.equal(legacy.schemaVersion,'xhs-evidence-pack/1.1');

    const forbiddenDowngrade=await fetch(`${base}/api/projects/${project.id}/evidence-pack?requireAuthenticated=1`);
    assert.equal(forbiddenDowngrade.status,409);
    assert.match((await forbiddenDowngrade.json()).error,/version 1\.2/i);

    const modernResponse=await fetch(`${base}/api/projects/${project.id}/evidence-pack?version=1.2&requireAuthenticated=1`);
    assert.equal(modernResponse.status,200);
    assertUnicodeDisposition(modernResponse);
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
