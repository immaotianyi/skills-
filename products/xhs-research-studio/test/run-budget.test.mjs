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

test('executor note/comment budget is enforced before snapshot commit',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-budget-'));
  try{
    const project={id:'prj_budget',slug:'budget',name:'Budget Gate',keywords:['防晒'],competitors:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await mutateProjects(dataDir,rows=>{rows.push(project);return project});
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'success',
    },async()=>{
      const service=new RunService(dataDir);
      const queued=await service.launch(project,{budget:{maxNotes:1,maxComments:2000,maxSeconds:30}});
      const run=await waitTerminal(service,project.id,queued.id);
      assert.equal(run.state,'failed');
      assert.equal(run.error.code,'RUN_BUDGET_EXCEEDED');
      assert.match(run.error.message,/notes 3 > maxNotes 1/);
      assert.equal((await listSnapshots(dataDir,project.id)).length,0,'over-budget executor result must not be committed');
    });
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
