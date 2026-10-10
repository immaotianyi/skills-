import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { RunService } from '../lib/run-service.mjs';
import { createRun, transitionRun } from '../lib/runs.mjs';
import { createSchedule, getSchedule, recordScheduleRun } from '../lib/schedules.mjs';
import { mutateProjects } from '../lib/storage.mjs';

async function setup(){
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-schedule-reconcile-'));
  const project={id:'prj_reconcile',slug:'reconcile',name:'Reconcile',keywords:['防晒'],competitors:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await mutateProjects(dataDir,rows=>{rows.push(project);return project});
  return {dataDir,project};
}

test('schedule reads authoritative run terminal state and restart recovery persists lagging metadata',async()=>{
  const {dataDir,project}=await setup();
  try{
    const schedule=await createSchedule(dataDir,project.id,{intervalMinutes:60,startAt:new Date(Date.now()+3600_000).toISOString()});
    const run=await createRun(dataDir,project,{trigger:'schedule',scheduleId:schedule.id});
    await transitionRun(dataDir,project.id,run.id,'running');
    await recordScheduleRun(dataDir,schedule.id,{runId:run.id,state:'running'});
    await transitionRun(dataDir,project.id,run.id,'completed',{counts:{notes:3,comments:8,queries:2}});

    const stale=await getSchedule(dataDir,schedule.id);
    assert.equal(stale.lastRunState,'running','fixture must model a crash window before schedule metadata is finalized');

    const service=new RunService(dataDir,{schedulerTickMs:60_000});
    const reconciled=await service.schedule(schedule.id);
    assert.equal(reconciled.lastRunId,run.id);
    assert.equal(reconciled.lastRunState,'completed','observable schedule state must follow the authoritative run record');

    await service.recover();
    const persisted=await getSchedule(dataDir,schedule.id);
    assert.equal(persisted.lastRunId,run.id);
    assert.equal(persisted.lastRunState,'completed','restart recovery must persist the repaired schedule state');
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
