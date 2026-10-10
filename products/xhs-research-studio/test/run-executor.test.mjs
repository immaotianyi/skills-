import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRun, getRun, listRuns, transitionRun, requeueRun, RUN_STATES, normalizeRunBudget } from '../lib/runs.mjs';
import { buildExecutorPlan, runConfiguredExecutor, ExecutorError } from '../lib/executor.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=path.join(root,'public','demo-harvest.json');
const mock=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const project={id:'prj_run_test',name:'Name; touch /tmp/should-not-exist',client:'Client',category:'护肤',keywords:['防晒'],competitors:['A']};

async function withEnv(values,fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){previous[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=String(value)}
  try{return await fn()}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

test('run state machine persists runs and rejects invalid transitions',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-runs-'));
  try{
    const run=await createRun(dataDir,project,{budget:{maxNotes:900,maxComments:-5,maxSeconds:2}});
    assert.equal(run.state,RUN_STATES.QUEUED);
    assert.deepEqual(run.budget,{maxNotes:500,maxComments:0,maxSeconds:15});
    const running=await transitionRun(dataDir,project.id,run.id,RUN_STATES.RUNNING);
    assert.equal(running.attempt,1);
    await assert.rejects(()=>transitionRun(dataDir,project.id,run.id,RUN_STATES.QUEUED),/invalid run transition/);
    const manual=await transitionRun(dataDir,project.id,run.id,RUN_STATES.MANUAL_ACTION_REQUIRED,{riskState:'CAPTCHA'});
    assert.equal(manual.riskState,'CAPTCHA');
    const queued=await requeueRun(dataDir,project.id,run.id);
    assert.equal(queued.state,RUN_STATES.QUEUED);
    assert.equal((await listRuns(dataDir,project.id)).length,1);
    assert.equal((await getRun(dataDir,project.id,run.id)).id,run.id);
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('executor plan hard-codes non-bypass safety rules and bounded budget',async()=>{
  const run={id:'run_plan',budget:normalizeRunBudget({maxNotes:70,maxComments:500,maxSeconds:120})};
  const plan=buildExecutorPlan(project,run);
  assert.equal(plan.safety.bypassCaptcha,false);
  assert.equal(plan.safety.bypassLogin,false);
  assert.equal(plan.safety.bypassAccessControls,false);
  assert.equal(plan.safety.bypassRateLimits,false);
  assert.equal(plan.safety.onBlockedState,'manual_action_required');
  assert.equal(plan.budget.maxNotes,70);
});

test('configured executor uses fixed no-shell command and returns Harvest payload',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-exec-'));
  try{
    const run=await createRun(dataDir,project);
    const sentinel='/tmp/should-not-exist';
    await fs.rm(sentinel,{force:true}).catch(()=>{});
    const result=await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'success',
    },()=>runConfiguredExecutor(project,run,{timeoutMs:5_000}));
    assert.equal(result.status,'completed');
    assert.ok(result.harvest.notes?.length>0);
    await assert.rejects(()=>fs.access(sentinel));
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('executor converts explicit and embedded platform hard stops to manual action',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-exec-stop-'));
  try{
    const run=await createRun(dataDir,project);
    for(const mode of ['manual','unsafe-harvest']){
      const result=await withEnv({
        XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
        XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
        XHS_EXECUTOR_FIXTURE_PATH:fixture,
        XHS_EXECUTOR_MODE:mode,
      },()=>runConfiguredExecutor(project,run,{timeoutMs:5_000}));
      assert.equal(result.status,'manual_action_required');
      assert.ok(['CAPTCHA','LOGIN_REQUIRED'].includes(result.riskState));
    }
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('executor fails closed on timeout and output-size abuse',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-exec-limits-'));
  try{
    const run=await createRun(dataDir,project);
    await assert.rejects(
      ()=>withEnv({XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),XHS_EXECUTOR_MODE:'hang'},()=>runConfiguredExecutor(project,run,{timeoutMs:100})),
      err=>err instanceof ExecutorError&&err.code==='EXECUTOR_TIMEOUT'
    );
    await assert.rejects(
      ()=>withEnv({XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),XHS_EXECUTOR_MODE:'huge'},()=>runConfiguredExecutor(project,run,{timeoutMs:5_000,maxOutputBytes:4_096})),
      err=>err instanceof ExecutorError&&err.code==='EXECUTOR_OUTPUT_LIMIT'
    );
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('executor cancellation kills active child and reports EXECUTOR_CANCELLED',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-exec-cancel-'));
  try{
    const run=await createRun(dataDir,project);
    const controller=new AbortController();
    const promise=withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_MODE:'hang',
    },()=>runConfiguredExecutor(project,run,{timeoutMs:5_000,signal:controller.signal}));
    setTimeout(()=>controller.abort(),75);
    await assert.rejects(promise,err=>err instanceof ExecutorError&&err.code==='EXECUTOR_CANCELLED');
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});

test('missing executor becomes manual action instead of pretending success',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-no-exec-'));
  try{
    const run=await createRun(dataDir,project);
    const result=await withEnv({XHS_STUDIO_HARVEST_EXECUTOR:undefined},()=>runConfiguredExecutor(project,run));
    assert.equal(result.status,'manual_action_required');
    assert.equal(result.riskState,'EXECUTOR_NOT_CONFIGURED');
  }finally{await fs.rm(dataDir,{recursive:true,force:true})}
});
