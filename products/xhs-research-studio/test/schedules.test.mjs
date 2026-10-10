import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSchedule, getSchedule, listSchedules, updateSchedule, claimDueSchedules, recordScheduleRun } from '../lib/schedules.mjs';

const projectId='prj_schedule_test';

test('schedule storage enforces bounded cadence and persists run metadata',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-schedules-'));
  try{
    await assert.rejects(()=>createSchedule(dataDir,projectId,{intervalMinutes:10}),/between 60/);
    const schedule=await createSchedule(dataDir,projectId,{intervalMinutes:60,startAt:'2026-10-10T00:00:00.000Z',budget:{maxNotes:120,maxComments:3000,maxSeconds:180}});
    assert.equal(schedule.intervalMinutes,60);
    assert.equal(schedule.budget.maxNotes,120);
    assert.equal((await listSchedules(dataDir,projectId)).length,1);
    const updated=await updateSchedule(dataDir,schedule.id,{enabled:false,intervalMinutes:120});
    assert.equal(updated.enabled,false);
    assert.equal(updated.intervalMinutes,120);
    const fetched=await getSchedule(dataDir,schedule.id);
    assert.equal(fetched.id,schedule.id);
    const recorded=await recordScheduleRun(dataDir,schedule.id,{runId:'run_schedule_1',state:'completed',at:'2026-10-10T01:00:00.000Z'});
    assert.equal(recorded.lastRunId,'run_schedule_1');
    assert.equal(recorded.lastRunState,'completed');
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('claimDueSchedules claims once and advances nextRunAt to prevent restart duplication',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-schedule-claim-'));
  try{
    const schedule=await createSchedule(dataDir,projectId,{intervalMinutes:60,startAt:'2026-10-10T00:00:00.000Z'});
    const now=new Date('2026-10-10T00:30:00.000Z');
    const first=await claimDueSchedules(dataDir,{now});
    assert.equal(first.length,1);
    assert.equal(first[0].id,schedule.id);
    assert.equal(first[0].nextRunAt,'2026-10-10T01:30:00.000Z');
    const second=await claimDueSchedules(dataDir,{now});
    assert.equal(second.length,0);
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});
