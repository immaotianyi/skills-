import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunService } from '../lib/run-service.mjs';
import { mutateProjects, listSnapshots } from '../lib/storage.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const fixture=path.join(root,'public','demo-harvest.json');
const mock=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function withEnv(values,fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){previous[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=String(value)}
  try{return await fn()}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

async function waitTerminal(service,projectId,runId){
  const until=Date.now()+7000;
  while(Date.now()<until){
    const run=await service.run(projectId,runId);
    if(['completed','failed','manual_action_required','cancelled'].includes(run?.state))return run;
    await sleep(25);
  }
  throw new Error('run did not become terminal');
}

async function seed(dataDir,id){
  const project={id,slug:id,name:'Executor Contract Gate',keywords:['防晒'],competitors:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
  await mutateProjects(dataDir,rows=>{rows.push(project);return project});
  return project;
}

async function runFixture(dataDir,project,mode,budget={maxNotes:80,maxComments:2000,maxSeconds:30}){
  return withEnv({
    XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
    XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
    XHS_EXECUTOR_FIXTURE_PATH:fixture,
    XHS_EXECUTOR_MODE:mode,
  },async()=>{
    const service=new RunService(dataDir);
    const queued=await service.launch(project,{budget});
    return waitTerminal(service,project.id,queued.id);
  });
}

test('executor note/comment budget is enforced before snapshot commit',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-budget-'));
  try{
    const project=await seed(dataDir,'prj_budget');
    const run=await runFixture(dataDir,project,'success',{maxNotes:1,maxComments:2000,maxSeconds:30});
    assert.equal(run.state,'failed');
    assert.equal(run.error.code,'RUN_BUDGET_EXCEEDED');
    assert.match(run.error.message,/notes 3 > maxNotes 1/);
    assert.equal((await listSnapshots(dataDir,project.id)).length,0,'over-budget executor result must not be committed');
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});

test('automatic executor must emit strict Harvest v2 even though manual ingest supports legacy input',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-v2-'));
  try{
    const project=await seed(dataDir,'prj_strict_v2');
    const run=await runFixture(dataDir,project,'legacy');
    assert.equal(run.state,'failed');
    assert.equal(run.error.code,'EXECUTOR_INVALID_HARVEST');
    assert.match(run.error.message,/schemaVersion/);
    assert.equal((await listSnapshots(dataDir,project.id)).length,0,'legacy executor output must not be auto-ingested');
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
