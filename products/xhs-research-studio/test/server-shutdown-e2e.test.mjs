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
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));

async function waitHealth(base){
  const until=Date.now()+7000;
  while(Date.now()<until){
    try{if((await fetch(`${base}/api/health`)).ok)return}catch{}
    await sleep(50);
  }
  throw new Error('server did not become healthy');
}

async function jsonFetch(url,options={}){
  const response=await fetch(url,{headers:{'content-type':'application/json',...(options.headers||{})},...options});
  const text=await response.text();
  return {response,body:text?JSON.parse(text):null};
}

test('SIGTERM waits for active executor failure state to persist before server exits', {timeout:15000}, async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'xhs-server-shutdown-'));
  const port=59000+Math.floor(Math.random()*1000);
  const base=`http://127.0.0.1:${port}`;
  const child=spawn(process.execPath,[serverPath],{
    cwd:root,
    stdio:['ignore','pipe','pipe'],
    env:{
      ...process.env,
      HOST:'127.0.0.1',PORT:String(port),XHS_STUDIO_DATA:dataDir,
      XHS_STUDIO_HARVEST_EXECUTOR:process.execPath,
      XHS_STUDIO_HARVEST_EXECUTOR_ARGS:JSON.stringify([mock]),
      XHS_EXECUTOR_MODE:'hang',
    },
  });
  let stderr='';
  child.stderr.on('data',chunk=>{stderr+=chunk.toString()});
  try{
    await waitHealth(base);
    const created=await jsonFetch(`${base}/api/projects`,{method:'POST',body:JSON.stringify({name:'Shutdown E2E',keywords:['防晒']})});
    assert.equal(created.response.status,201);
    const project=created.body;
    const launched=await jsonFetch(`${base}/api/projects/${project.id}/runs`,{method:'POST',body:JSON.stringify({budget:{maxSeconds:60}})});
    assert.equal(launched.response.status,202);
    const runId=launched.body.run.id;

    const until=Date.now()+3000;
    let state='';
    while(Date.now()<until){
      const current=await jsonFetch(`${base}/api/projects/${project.id}/runs/${runId}`);
      state=current.body.run.state;
      if(state==='running')break;
      await sleep(20);
    }
    assert.equal(state,'running');

    const exited=new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('server did not exit after SIGTERM')),7000);
      child.once('exit',(code,signal)=>{clearTimeout(timer);resolve({code,signal})});
    });
    child.kill('SIGTERM');
    const result=await exited;
    assert.equal(result.code,0,`unexpected shutdown result ${JSON.stringify(result)} stderr=${stderr}`);

    const runPath=path.join(dataDir,'runs',project.id,`${runId}.json`);
    const persisted=JSON.parse(await fs.readFile(runPath,'utf8'));
    assert.equal(persisted.state,'failed');
    assert.equal(persisted.error.code,'EXECUTOR_CANCELLED');
    assert.ok(persisted.finishedAt);
  }finally{
    if(child.exitCode===null)child.kill('SIGKILL');
    await fs.rm(dataDir,{recursive:true,force:true});
  }
});
