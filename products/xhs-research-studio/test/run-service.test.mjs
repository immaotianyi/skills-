import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunService } from '../lib/run-service.mjs';
import { mutateProjects, getProjects, listSnapshots } from '../lib/storage.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=path.join(root,'public','demo-harvest.json');
const mock=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitRun(service,projectId,runId,states=['completed','manual_action_required','failed','cancelled'],timeout=7000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    const run=await service.run(projectId,runId);
    if(states.includes(run?.state))return run;
    await sleep(25);
  }
  throw new Error('run did not reach terminal state');
}

async function withEnv(values,fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){previous[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=String(value)}
  try{return await fn()}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

async function seedProject(dataDir,id='prj_service'){
  const project={id,slug:id,name:'Run Service',client:'Test',category:'防晒',keywords:['防晒'],competitors:['A'],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await mutateProjects(dataDir,rows=>{rows.push(project);return project});
  return project;
}

test('RunService launches executor, ingests snapshot, and records completion',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-service-'));
  try{
    const project=await seedProject(dataDir);
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'success',
    },async()=>{
      const service=new RunService(dataDir,{schedulerTickMs:60_000});
      const queued=await service.launch(project,{budget:{maxNotes:50,maxSeconds:60}});
      const run=await waitRun(service,project.id,queued.id);
      assert.equal(run.state,'completed');
      assert.ok(run.snapshotId);
      assert.equal(run.counts.notes,3);
      assert.equal((await listSnapshots(dataDir,project.id)).length,1);
      const persisted=(await getProjects(dataDir)).find(x=>x.id===project.id);
      assert.ok(persisted.lastSnapshotAt);
    });
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('RunService never auto-ingests manual platform hard stops',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-service-stop-'));
  try{
    const project=await seedProject(dataDir,'prj_stop');
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'manual',
    },async()=>{
      const service=new RunService(dataDir);
      const queued=await service.launch(project);
      const run=await waitRun(service,project.id,queued.id);
      assert.equal(run.state,'manual_action_required');
      assert.equal(run.riskState,'CAPTCHA');
      assert.equal((await listSnapshots(dataDir,project.id)).length,0);
    });
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('RunService cancellation aborts executor and never ingests a snapshot',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-service-cancel-'));
  try{
    const project=await seedProject(dataDir,'prj_cancel');
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_MODE:'hang',
    },async()=>{
      const service=new RunService(dataDir);
      const queued=await service.launch(project,{budget:{maxSeconds:60}});
      const until=Date.now()+2000;
      while(Date.now()<until){const row=await service.run(project.id,queued.id);if(row?.state==='running')break;await sleep(10)}
      const cancelled=await service.cancel(project,queued.id);
      assert.equal(cancelled.state,'cancelled');
      const final=await waitRun(service,project.id,queued.id,['cancelled']);
      assert.equal(final.state,'cancelled');
      assert.equal((await listSnapshots(dataDir,project.id)).length,0);
    });
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('RunService schedule tick claims due schedule and produces a scheduled snapshot',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-service-schedule-'));
  try{
    const project=await seedProject(dataDir,'prj_scheduled');
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'success',
    },async()=>{
      const service=new RunService(dataDir,{schedulerTickMs:60_000});
      const schedule=await service.createSchedule(project.id,{intervalMinutes:60,startAt:new Date(Date.now()-1000).toISOString()});
      const claimed=await service.tick();
      assert.equal(claimed,1);
      let runs=[];
      const until=Date.now()+7000;
      while(Date.now()<until){runs=await service.runs(project.id);if(runs[0]?.state==='completed')break;await sleep(25)}
      assert.equal(runs.length,1);
      assert.equal(runs[0].trigger,'schedule');
      assert.equal(runs[0].scheduleId,schedule.id);
      assert.equal(runs[0].state,'completed');
      const updated=await service.schedule(schedule.id);
      assert.equal(updated.lastRunId,runs[0].id);
      assert.equal(updated.lastRunState,'completed');
      assert.ok(Date.parse(updated.nextRunAt)>Date.now());
    });
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('restart recovery fails closed for interrupted running executor state',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-recover-'));
  try{
    const project=await seedProject(dataDir,'prj_recover');
    const service=new RunService(dataDir);
    const run=await (await import('../lib/runs.mjs')).createRun(dataDir,project);
    await (await import('../lib/runs.mjs')).transitionRun(dataDir,project.id,run.id,'running');
    await service.recover();
    const recovered=await service.run(project.id,run.id);
    assert.equal(recovered.state,'failed');
    assert.equal(recovered.error.code,'SERVER_RESTART');
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});
