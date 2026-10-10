import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RunService } from '../lib/run-service.mjs';
import { mutateProjects, listSnapshots } from '../lib/storage.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const mock=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function withEnv(values,fn){
  const previous={};
  for(const [key,value] of Object.entries(values)){previous[key]=process.env[key];if(value===undefined)delete process.env[key];else process.env[key]=String(value)}
  try{return await fn()}finally{for(const [key,value] of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value}}
}

test('RunService.stop waits for an aborted executor to persist a terminal run state',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-shutdown-'));
  try{
    const project={id:'prj_shutdown',slug:'shutdown',name:'Shutdown Gate',keywords:['防晒'],competitors:[],createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
    await mutateProjects(dataDir,rows=>{rows.push(project);return project});
    await withEnv({
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_MODE:'hang',
    },async()=>{
      const service=new RunService(dataDir);
      const queued=await service.launch(project,{budget:{maxSeconds:60}});
      const until=Date.now()+2000;
      while(Date.now()<until){
        const run=await service.run(project.id,queued.id);
        if(run?.state==='running')break;
        await sleep(10);
      }
      const result=await service.stop({timeoutMs:2000});
      assert.equal(result.settled,true);
      assert.equal(result.active,0);
      const final=await service.run(project.id,queued.id);
      assert.equal(final.state,'failed');
      assert.equal(final.error.code,'EXECUTOR_CANCELLED');
      assert.equal((await listSnapshots(dataDir,project.id)).length,0);
    });
  }finally{
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
