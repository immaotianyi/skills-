import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const serverPath=path.join(root,'server.mjs');
const mock=path.join(root,'test','fixtures','mock-harvest-executor.mjs');
const fixture=path.join(root,'public','demo-harvest.json');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function jsonFetch(url,options={}){
  const response=await fetch(url,options);
  const text=await response.text();
  let body=null;
  try{body=text?JSON.parse(text):null}catch{body=text}
  return {response,body};
}

async function waitHealth(base,timeout=7000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    try{const {response}=await jsonFetch(`${base}/api/health`);if(response.ok)return}
    catch{}
    await sleep(50);
  }
  throw new Error('server did not become healthy');
}

async function waitRun(base,projectId,runId,terminal=['completed','manual_action_required','failed','cancelled'],timeout=7000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    const {response,body}=await jsonFetch(`${base}/api/projects/${projectId}/runs/${runId}`);
    if(response.ok&&terminal.includes(body?.run?.state))return body.run;
    await sleep(30);
  }
  throw new Error(`run ${runId} did not reach terminal state`);
}

test('HTTP run API executes Harvest, ingests snapshots, and scheduled monitoring repeats it',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-run-api-'));
  const port=57000+Math.floor(Math.random()*2000);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{
    cwd:root,
    stdio:['ignore','pipe','pipe'],
    env:{
      ...process.env,
      HOST:'127.0.0.1',PORT:String(port),XHS_STUDIO_DATA:dataDir,
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_FIXTURE_PATH:fixture,
      XHS_EXECUTOR_MODE:'success',
      XHS_STUDIO_SCHEDULER_TICK_MS:'250',
    },
  });
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString()});
  try{
    await waitHealth(base);
    const system=await jsonFetch(`${base}/api/run-system`);
    assert.equal(system.response.status,200);
    assert.equal(system.body.executorConfigured,true);
    assert.equal(system.body.schedulerTickMs,250);

    const projectResponse=await jsonFetch(`${base}/api/projects`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({name:'API Harvest Run',keywords:['防晒'],competitors:['A']}),
    });
    assert.equal(projectResponse.response.status,201);
    const project=projectResponse.body;

    const launch=await jsonFetch(`${base}/api/projects/${project.id}/runs`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({budget:{maxNotes:40,maxComments:500,maxSeconds:30}}),
    });
    assert.equal(launch.response.status,202);
    const first=await waitRun(base,project.id,launch.body.run.id);
    assert.equal(first.state,'completed');
    assert.ok(first.snapshotId);
    assert.equal(first.counts.notes,3);

    const snapshots1=await jsonFetch(`${base}/api/projects/${project.id}/snapshots`);
    assert.equal(snapshots1.body.snapshots.length,1);

    const scheduleResponse=await jsonFetch(`${base}/api/projects/${project.id}/schedules`,{
      method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({intervalMinutes:60,startAt:new Date(Date.now()-1000).toISOString(),budget:{maxNotes:30,maxSeconds:30}}),
    });
    assert.equal(scheduleResponse.response.status,201);
    const schedule=scheduleResponse.body.schedule;

    let runs=[];
    const until=Date.now()+8000;
    while(Date.now()<until){
      const response=await jsonFetch(`${base}/api/projects/${project.id}/runs`);
      runs=response.body.runs||[];
      if(runs.some(run=>run.trigger==='schedule'&&run.state==='completed'))break;
      await sleep(50);
    }
    const scheduled=runs.find(run=>run.trigger==='schedule');
    assert.ok(scheduled,'expected scheduler to create a run');
    assert.equal(scheduled.state,'completed');
    assert.equal(scheduled.scheduleId,schedule.id);

    const scheduleAfter=await jsonFetch(`${base}/api/projects/${project.id}/schedules/${schedule.id}`);
    assert.equal(scheduleAfter.response.status,200);
    assert.equal(scheduleAfter.body.schedule.lastRunState,'completed');
    assert.equal(scheduleAfter.body.schedule.lastRunId,scheduled.id);
    assert.ok(Date.parse(scheduleAfter.body.schedule.nextRunAt)>Date.now());

    const snapshots2=await jsonFetch(`${base}/api/projects/${project.id}/snapshots`);
    assert.equal(snapshots2.body.snapshots.length,2);
  }finally{
    child.kill('SIGTERM');
    await Promise.race([new Promise(resolve=>child.once('exit',resolve)),sleep(3000)]);
    if(child.exitCode===null)child.kill('SIGKILL');
    await fs.rm(dataDir,{recursive:true,force:true});
    assert.equal(stderr,'',`server stderr should be empty, got: ${stderr}`);
  }
});
