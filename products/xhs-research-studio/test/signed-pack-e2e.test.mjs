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
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function waitForHealth(base){
  for(let i=0;i<80;i++){
    try{const r=await fetch(`${base}/api/health`);if(r.ok)return}catch{}
    await sleep(50);
  }
  throw new Error('server did not become healthy');
}

test('signed-pack exporter produces a self-verifying v1.2 deliverable from a persisted signed snapshot',{timeout:15000},async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-signed-pack-data-'));
  const outDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-signed-pack-out-'));
  const port=56600+Math.floor(Math.random()*300);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir},stdio:['ignore','pipe','pipe']});
  try{
    await waitForHealth(base);
    const projectResponse=await fetch(`${base}/api/projects`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:'Signed Pack E2E'})});
    assert.equal(projectResponse.status,201);
    const project=await projectResponse.json();
    const demo=JSON.parse(await fs.readFile(demoPath,'utf8'));
    const ingestResponse=await fetch(`${base}/api/projects/${project.id}/ingest`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(demo)});
    assert.equal(ingestResponse.status,201);
    const ingested=await ingestResponse.json();
    assert.ok(ingested.integrity?.digest);
    assert.equal(ingested.integrityStatus?.verified,true);

    const outFile=path.join(outDir,'signed-pack.json');
    const {stdout,stderr}=await execFileAsync(process.execPath,[exporterPath,project.id,'--base',base,'--out',outFile],{encoding:'utf8'});
    assert.equal(stderr,'');
    assert.equal(stdout.trim(),outFile);
    const pack=JSON.parse(await fs.readFile(outFile,'utf8'));
    assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.2');
    assert.ok(pack.snapshot.integrity?.digest);
    assert.ok(pack.integrity?.digest);
    assert.equal(verifyEvidencePack(pack).ok,true);
  } finally {
    child.kill('SIGTERM');
    await Promise.all([fs.rm(dataDir,{recursive:true,force:true}),fs.rm(outDir,{recursive:true,force:true})]);
  }
});
