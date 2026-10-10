import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SAFE_ID_RE=/^[A-Za-z0-9._-]+$/u;
const queues=new Map();

export const RUN_STATES=Object.freeze({
  QUEUED:'queued',
  RUNNING:'running',
  MANUAL_ACTION_REQUIRED:'manual_action_required',
  COMPLETED:'completed',
  FAILED:'failed',
  CANCELLED:'cancelled',
});

const transitions=Object.freeze({
  queued:new Set(['running','cancelled']),
  running:new Set(['manual_action_required','completed','failed','cancelled']),
  manual_action_required:new Set(['queued','cancelled']),
  completed:new Set(),
  failed:new Set(['queued','cancelled']),
  cancelled:new Set(),
});

function assertId(value,label){
  if(!SAFE_ID_RE.test(String(value||''))) throw new Error(`invalid ${label}`);
}

function makeRunId(){
  return `run_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function clampInt(value,min,max,fallback){
  const parsed=Number(value);
  if(!Number.isFinite(parsed)) return fallback;
  return Math.min(max,Math.max(min,Math.trunc(parsed)));
}

export function normalizeRunBudget(input={}){
  return {
    maxNotes:clampInt(input.maxNotes,1,500,80),
    maxComments:clampInt(input.maxComments,0,20_000,2_000),
    maxSeconds:clampInt(input.maxSeconds,15,1_800,300),
  };
}

function runDir(dataDir,projectId){
  assertId(projectId,'projectId');
  return path.join(dataDir,'runs',projectId);
}

function runFile(dataDir,projectId,runId){
  assertId(runId,'runId');
  return path.join(runDir(dataDir,projectId),`${runId}.json`);
}

async function readJson(file,fallback=undefined){
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch(err){
    if(err?.code==='ENOENT'&&fallback!==undefined)return fallback;
    if(err instanceof SyntaxError)throw new Error(`Corrupt JSON storage file: ${file}: ${err.message}`);
    throw err;
  }
}

async function writeJsonAtomic(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try{
    await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n','utf8');
    await fs.rename(tmp,file);
  }finally{
    await fs.rm(tmp,{force:true}).catch(()=>{});
  }
}

async function serialize(key,fn){
  const previous=queues.get(key)||Promise.resolve();
  const current=previous.catch(()=>{}).then(fn);
  queues.set(key,current.then(()=>undefined,()=>undefined));
  return current;
}

function publicError(error){
  if(!error)return null;
  return {
    code:String(error.code||'RUN_FAILED').slice(0,80),
    message:String(error.message||error).slice(0,500),
  };
}

export async function createRun(dataDir,project,{budget={},trigger='manual',scheduleId=null}={}){
  if(!project?.id)throw new TypeError('project is required');
  assertId(project.id,'projectId');
  const now=new Date().toISOString();
  const run={
    id:makeRunId(),
    projectId:project.id,
    state:RUN_STATES.QUEUED,
    trigger:String(trigger||'manual').slice(0,40),
    scheduleId:scheduleId?String(scheduleId):null,
    budget:normalizeRunBudget(budget),
    createdAt:now,
    updatedAt:now,
    startedAt:null,
    finishedAt:null,
    attempt:0,
    snapshotId:null,
    riskState:'NORMAL',
    gaps:[],
    stoppedBecause:null,
    counts:{notes:0,comments:0,queries:0},
    attention:[],
    error:null,
  };
  await writeJsonAtomic(runFile(dataDir,project.id,run.id),run);
  return run;
}

export async function getRun(dataDir,projectId,runId){
  assertId(projectId,'projectId');assertId(runId,'runId');
  return readJson(runFile(dataDir,projectId,runId),null);
}

export async function listRuns(dataDir,projectId){
  const dir=runDir(dataDir,projectId);
  let files;
  try{files=(await fs.readdir(dir)).filter(name=>name.endsWith('.json'))}
  catch(err){if(err?.code==='ENOENT')return[];throw err}
  const runs=[];
  for(const file of files){const run=await readJson(path.join(dir,file),null);if(run)runs.push(run)}
  runs.sort((a,b)=>(Date.parse(a.createdAt)||0)-(Date.parse(b.createdAt)||0)||String(a.id).localeCompare(String(b.id)));
  return runs;
}

export async function transitionRun(dataDir,projectId,runId,nextState,patch={}){
  assertId(projectId,'projectId');assertId(runId,'runId');
  if(!Object.values(RUN_STATES).includes(nextState))throw new Error(`invalid run state: ${nextState}`);
  const file=runFile(dataDir,projectId,runId);
  return serialize(file,async()=>{
    const current=await readJson(file,null);
    if(!current)throw new Error('run not found');
    if(current.state!==nextState&&!transitions[current.state]?.has(nextState)){
      throw new Error(`invalid run transition: ${current.state} -> ${nextState}`);
    }
    const now=new Date().toISOString();
    const next={...current,...patch,state:nextState,updatedAt:now};
    if(nextState===RUN_STATES.RUNNING){
      next.startedAt=current.startedAt||now;
      next.finishedAt=null;
      next.attempt=(Number(current.attempt)||0)+1;
      next.error=null;
    }
    if([RUN_STATES.COMPLETED,RUN_STATES.FAILED,RUN_STATES.CANCELLED].includes(nextState))next.finishedAt=now;
    if(nextState===RUN_STATES.FAILED)next.error=publicError(patch.error||current.error||new Error('run failed'));
    await writeJsonAtomic(file,next);
    return next;
  });
}

export async function requeueRun(dataDir,projectId,runId){
  const current=await getRun(dataDir,projectId,runId);
  if(!current)throw new Error('run not found');
  if(![RUN_STATES.MANUAL_ACTION_REQUIRED,RUN_STATES.FAILED].includes(current.state))throw new Error(`run cannot be resumed from ${current.state}`);
  return transitionRun(dataDir,projectId,runId,RUN_STATES.QUEUED,{finishedAt:null,error:null,stoppedBecause:null});
}
