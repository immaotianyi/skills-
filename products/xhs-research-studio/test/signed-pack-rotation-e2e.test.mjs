import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyEvidencePack } from '../lib/evidence-pack.mjs';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath=path.join(root,'server.mjs');
const exporterPath=path.join(root,'export-signed-pack.mjs');
const demoPath=path.join(root,'public','demo-harvest.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const oldKey='rotation-old-snapshot-key-at-least-32-bytes-2026';
const newKey='rotation-new-snapshot-key-at-least-32-bytes-2026';
const packKey='rotation-pack-key-at-least-32-bytes-2026';

async function waitForHealth(base){
  for(let i=0;i<80;i++){
    try{const response=await fetch(`${base}/api/health`);if(response.ok)return}catch{}
    await sleep(50);
  }
  throw new Error(`server did not become healthy at ${base}`);
}

function startServer(dataDir,port,extraEnv){
  return spawn(process.execPath,[serverPath],{
    env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir,...extraEnv},
    stdio:['ignore','pipe','pipe'],
  });
}

async function stopServer(child){
  if(!child || child.exitCode!==null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve=>child.once('exit',resolve)),
    sleep(2000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL')}),
  ]);
}

test('historical HMAC snapshot remains exportable after key rotation only while its old key is present in the verification keyring',{timeout:20000},async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-rotation-data-'));
  const outDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-pack-rotation-out-'));
  const basePort=57000+Math.floor(Math.random()*200);
  let child=null;
  try{
    const oldBase=`http://127.0.0.1:${basePort}`;
    child=startServer(dataDir,basePort,{
      XHS_STUDIO_INTEGRITY_KEY:oldKey,
      XHS_STUDIO_INTEGRITY_KEY_ID:'snapshot-old-v1',
      XHS_STUDIO_INTEGRITY_KEYRING:'',
    });
    await waitForHealth(oldBase);

    const projectResponse=await fetch(`${oldBase}/api/projects`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Rotation Export E2E'}),
    });
    assert.equal(projectResponse.status,201);
    const project=await projectResponse.json();
    const demo=JSON.parse(await fs.readFile(demoPath,'utf8'));
    const ingestResponse=await fetch(`${oldBase}/api/projects/${project.id}/ingest`,{
      method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(demo),
    });
    assert.equal(ingestResponse.status,201);
    const oldSnapshot=await ingestResponse.json();
    assert.equal(oldSnapshot.integrity.keyId,'snapshot-old-v1');
    await stopServer(child);

    const rotatedPort=basePort+1;
    const rotatedBase=`http://127.0.0.1:${rotatedPort}`;
    child=startServer(dataDir,rotatedPort,{
      XHS_STUDIO_INTEGRITY_KEY:newKey,
      XHS_STUDIO_INTEGRITY_KEY_ID:'snapshot-new-v2',
      XHS_STUDIO_INTEGRITY_KEYRING:JSON.stringify({'snapshot-old-v1':oldKey}),
    });
    await waitForHealth(rotatedBase);

    const historicalResponse=await fetch(`${rotatedBase}/api/projects/${project.id}/snapshots/${oldSnapshot.id}`);
    assert.equal(historicalResponse.status,200);
    const historical=await historicalResponse.json();
    assert.equal(historical.integrityStatus.verified,true);
    assert.equal(historical.integrityStatus.authenticated,true);
    assert.equal(historical.integrityStatus.keyId,'snapshot-old-v1');

    const outFile=path.join(outDir,'rotated-signed-pack.json');
    const exported=await execFileAsync(process.execPath,[exporterPath,project.id,'--snapshot',oldSnapshot.id,'--base',rotatedBase,'--out',outFile],{
      encoding:'utf8',
      env:{...process.env,XHS_STUDIO_PACK_INTEGRITY_KEY:packKey,XHS_STUDIO_PACK_INTEGRITY_KEY_ID:'pack-rotation-v1'},
    });
    assert.equal(exported.stderr,'');
    assert.equal(exported.stdout.trim(),outFile);
    const pack=JSON.parse(await fs.readFile(outFile,'utf8'));
    assert.equal(pack.snapshot.integrity.keyId,'snapshot-old-v1');
    assert.equal(pack.snapshot.integrityStatus.authenticated,true);
    const verified=verifyEvidencePack(pack,{key:packKey,keyId:'pack-rotation-v1'});
    assert.equal(verified.ok,true);
    assert.equal(verified.authenticated,true);
    await stopServer(child);

    const noRingPort=basePort+2;
    const noRingBase=`http://127.0.0.1:${noRingPort}`;
    child=startServer(dataDir,noRingPort,{
      XHS_STUDIO_INTEGRITY_KEY:newKey,
      XHS_STUDIO_INTEGRITY_KEY_ID:'snapshot-new-v2',
      XHS_STUDIO_INTEGRITY_KEYRING:'',
    });
    await waitForHealth(noRingBase);
    const unavailable=await fetch(`${noRingBase}/api/projects/${project.id}/snapshots/${oldSnapshot.id}`);
    assert.equal(unavailable.status,409);
  } finally {
    await stopServer(child);
    await Promise.all([fs.rm(dataDir,{recursive:true,force:true}),fs.rm(outDir,{recursive:true,force:true})]);
  }
});
