import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync=promisify(execFile);
const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath=path.join(root,'server.mjs');
const cliPath=path.join(root,'cli.mjs');
const demoPath=path.join(root,'public','demo-harvest.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitForHealth(base) {
  for(let i=0;i<80;i++) {
    try {
      const response=await fetch(`${base}/api/health`);
      if(response.ok) return;
    } catch {}
    await sleep(50);
  }
  throw new Error('server did not become healthy');
}

test('CLI/API covers delivery flow, run safety, schedules, concurrent writes, and request limits', {timeout:25000}, async () => {
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-cli-e2e-'));
  const outDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-cli-out-'));
  const port=56000+Math.floor(Math.random()*500);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{
    env:{...process.env,PORT:String(port),XHS_STUDIO_DATA:dataDir,XHS_STUDIO_MAX_BODY:'20000'},
    stdio:['ignore','pipe','pipe'],
  });
  const run=async (...args)=>{
    const {stdout,stderr}=await execFileAsync(process.execPath,[cliPath,...args,'--base',base],{encoding:'utf8',maxBuffer:10_000_000});
    assert.equal(stderr,'');
    return stdout.trim();
  };
  try {
    await waitForHealth(base);
    const health=JSON.parse(await run('health'));
    assert.equal(health.ok,true);
    const runSystem=JSON.parse(await run('run-system'));
    assert.equal(runSystem.executorConfigured,false);

    const validation=JSON.parse(await run('validate',demoPath));
    assert.equal(validation.ok,true);
    assert.equal(validation.summary.notes,3);

    const project=JSON.parse(await run('create','--name','CLI E2E','--keywords','防晒,敏感肌','--competitors','A,B'));
    assert.ok(project.id);

    const launch=JSON.parse(await run('run',project.id,'--max-notes','20','--max-comments','100','--max-seconds','30'));
    assert.ok(launch.run.id);
    let manualRun=null;
    for(let i=0;i<80;i++){
      manualRun=JSON.parse(await run('run-get',project.id,launch.run.id)).run;
      if(manualRun.state==='manual_action_required')break;
      await sleep(25);
    }
    assert.equal(manualRun.state,'manual_action_required');
    assert.equal(manualRun.riskState,'EXECUTOR_NOT_CONFIGURED');
    assert.equal(manualRun.snapshotId,null);
    const runList=JSON.parse(await run('runs',project.id));
    assert.ok(runList.runs.some(row=>row.id===launch.run.id));

    const schedule=JSON.parse(await run('schedule-create',project.id,'--interval-minutes','60','--start-at',new Date(Date.now()+3600_000).toISOString(),'--max-notes','25')).schedule;
    assert.equal(schedule.intervalMinutes,60);
    const schedules=JSON.parse(await run('schedules',project.id));
    assert.ok(schedules.schedules.some(row=>row.id===schedule.id));
    const disabled=JSON.parse(await run('schedule-update',project.id,schedule.id,'--enabled','false')).schedule;
    assert.equal(disabled.enabled,false);

    const ingest=JSON.parse(await run('ingest',project.id,demoPath));
    assert.equal(ingest.analysis.coverage.notes,3);

    const reportPath=path.join(outDir,'report.md');
    const packPath=path.join(outDir,'pack-v1.1.json');
    const packV12Path=path.join(outDir,'pack-v1.2.json');
    const csvPath=path.join(outDir,'evidence.csv');
    assert.equal(await run('report',project.id,'--out',reportPath),reportPath);
    assert.equal(await run('pack',project.id,'--out',packPath),packPath);
    assert.equal(await run('pack',project.id,'--version','1.2','--out',packV12Path),packV12Path);
    assert.equal(await run('csv',project.id,'--out',csvPath),csvPath);
    assert.match(await fs.readFile(reportPath,'utf8'),/Methodology \/ interpretation limits/);
    const pack=JSON.parse(await fs.readFile(packPath,'utf8'));
    assert.equal(pack.schemaVersion,'xhs-evidence-pack/1.1');
    const packV12=JSON.parse(await fs.readFile(packV12Path,'utf8'));
    assert.equal(packV12.schemaVersion,'xhs-evidence-pack/1.2');
    assert.equal(packV12.integrity.algorithm,'sha256');
    assert.equal(packV12.integrity.authenticated,false);
    assert.match(await fs.readFile(csvPath,'utf8'),/noteId,title,author/);

    const concurrentCount=24;
    const created=await Promise.all(Array.from({length:concurrentCount},async(_,index)=>{
      const response=await fetch(`${base}/api/projects`,{
        method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({name:`Concurrent ${index}`}),
      });
      assert.equal(response.status,201);
      return response.json();
    }));
    assert.equal(new Set(created.map(x=>x.id)).size,concurrentCount);
    const projects=await fetch(`${base}/api/projects`).then(r=>r.json());
    for(let index=0;index<concurrentCount;index++) {
      assert.ok(projects.projects.some(x=>x.name===`Concurrent ${index}`),`missing concurrent project ${index}`);
    }

    const oversized=await fetch(`${base}/api/analyze`,{
      method:'POST',
      headers:{'content-type':'application/json'},
      body:JSON.stringify({padding:'x'.repeat(25000)}),
    });
    assert.equal(oversized.status,413);
    assert.match((await oversized.json()).error,/exceeds/);
  } finally {
    child.kill('SIGTERM');
    await Promise.all([
      fs.rm(dataDir,{recursive:true,force:true}),
      fs.rm(outDir,{recursive:true,force:true}),
    ]);
  }
});
