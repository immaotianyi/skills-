import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const SAFE_ID_RE=/^[A-Za-z0-9._-]+$/u;
const queues=new Map();
const MIN_INTERVAL_MINUTES=60;
const MAX_INTERVAL_MINUTES=525_600;

function assertId(value,label){if(!SAFE_ID_RE.test(String(value||'')))throw new Error(`invalid ${label}`)}
function scheduleFile(dataDir){return path.join(dataDir,'schedules.json')}
function makeId(){return `sch_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`}

async function readJson(file,fallback){
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch(err){if(err?.code==='ENOENT')return fallback;if(err instanceof SyntaxError)throw new Error(`Corrupt JSON storage file: ${file}: ${err.message}`);throw err}
}
async function writeAtomic(file,data){
  await fs.mkdir(path.dirname(file),{recursive:true});
  const tmp=`${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try{await fs.writeFile(tmp,JSON.stringify(data,null,2)+'\n','utf8');await fs.rename(tmp,file)}finally{await fs.rm(tmp,{force:true}).catch(()=>{})}
}
async function mutate(dataDir,fn){
  const file=scheduleFile(dataDir);const key=path.resolve(file);const prev=queues.get(key)||Promise.resolve();
  const run=prev.catch(()=>{}).then(async()=>{const rows=await readJson(file,[]);if(!Array.isArray(rows))throw new Error('Corrupt schedules.json: root must be an array.');const result=await fn(rows);await writeAtomic(file,rows);return result});
  queues.set(key,run.then(()=>undefined,()=>undefined));return run;
}
function intervalMinutes(value){
  const n=Math.trunc(Number(value));
  if(!Number.isFinite(n)||n<MIN_INTERVAL_MINUTES||n>MAX_INTERVAL_MINUTES)throw new Error(`intervalMinutes must be between ${MIN_INTERVAL_MINUTES} and ${MAX_INTERVAL_MINUTES}`);
  return n;
}
function iso(value,fallback){
  const parsed=Date.parse(String(value||''));
  if(Number.isFinite(parsed))return new Date(parsed).toISOString();
  if(fallback!==undefined)return fallback;
  throw new Error('invalid schedule time');
}

export async function listSchedules(dataDir,projectId=''){
  if(projectId)assertId(projectId,'projectId');
  const rows=await readJson(scheduleFile(dataDir),[]);if(!Array.isArray(rows))throw new Error('Corrupt schedules.json: root must be an array.');
  return rows.filter(row=>!projectId||row.projectId===projectId).sort((a,b)=>(Date.parse(a.nextRunAt)||0)-(Date.parse(b.nextRunAt)||0)||String(a.id).localeCompare(String(b.id)));
}

export async function getSchedule(dataDir,scheduleId){
  assertId(scheduleId,'scheduleId');return (await listSchedules(dataDir)).find(row=>row.id===scheduleId)||null;
}

export async function createSchedule(dataDir,projectId,{intervalMinutes:interval=1440,enabled=true,startAt='',budget={}}={}){
  assertId(projectId,'projectId');
  const minutes=intervalMinutes(interval);const now=new Date().toISOString();
  const first=startAt?iso(startAt):new Date(Date.now()+minutes*60_000).toISOString();
  const row={
    id:makeId(),projectId,enabled:Boolean(enabled),intervalMinutes:minutes,nextRunAt:first,
    budget:{
      maxNotes:Math.min(500,Math.max(1,Math.trunc(Number(budget.maxNotes)||80))),
      maxComments:Math.min(20_000,Math.max(0,Math.trunc(Number(budget.maxComments)||2_000))),
      maxSeconds:Math.min(1_800,Math.max(15,Math.trunc(Number(budget.maxSeconds)||300))),
    },
    createdAt:now,updatedAt:now,lastClaimedAt:null,lastRunAt:null,lastRunId:null,lastRunState:null,lastError:null,
  };
  return mutate(dataDir,rows=>{rows.push(row);return row});
}

export async function updateSchedule(dataDir,scheduleId,patch={}){
  assertId(scheduleId,'scheduleId');
  return mutate(dataDir,rows=>{
    const index=rows.findIndex(row=>row.id===scheduleId);if(index<0)throw new Error('schedule not found');
    const current=rows[index];const next={...current};
    if('enabled'in patch)next.enabled=Boolean(patch.enabled);
    if('intervalMinutes'in patch)next.intervalMinutes=intervalMinutes(patch.intervalMinutes);
    if('nextRunAt'in patch)next.nextRunAt=iso(patch.nextRunAt);
    if('budget'in patch){
      const budget=patch.budget||{};
      next.budget={
        maxNotes:Math.min(500,Math.max(1,Math.trunc(Number(budget.maxNotes??current.budget.maxNotes)||80))),
        maxComments:Math.min(20_000,Math.max(0,Math.trunc(Number(budget.maxComments??current.budget.maxComments)||0))),
        maxSeconds:Math.min(1_800,Math.max(15,Math.trunc(Number(budget.maxSeconds??current.budget.maxSeconds)||300))),
      };
    }
    next.updatedAt=new Date().toISOString();rows[index]=next;return next;
  });
}

export async function claimDueSchedules(dataDir,{now=new Date(),limit=20}={}){
  const nowMs=now instanceof Date?now.getTime():Date.parse(String(now));
  if(!Number.isFinite(nowMs))throw new Error('invalid claim time');
  return mutate(dataDir,rows=>{
    const due=rows.filter(row=>row.enabled&&Number.isFinite(Date.parse(row.nextRunAt))&&Date.parse(row.nextRunAt)<=nowMs)
      .sort((a,b)=>Date.parse(a.nextRunAt)-Date.parse(b.nextRunAt)).slice(0,Math.max(1,Math.min(100,Math.trunc(limit)||20)));
    const claimed=[];
    for(const row of due){
      row.lastClaimedAt=new Date(nowMs).toISOString();
      row.nextRunAt=new Date(nowMs+row.intervalMinutes*60_000).toISOString();
      row.updatedAt=row.lastClaimedAt;
      claimed.push(structuredClone(row));
    }
    return claimed;
  });
}

export async function recordScheduleRun(dataDir,scheduleId,{runId='',state='',error=null,at=new Date()}={}){
  assertId(scheduleId,'scheduleId');if(runId)assertId(runId,'runId');
  return mutate(dataDir,rows=>{
    const row=rows.find(item=>item.id===scheduleId);if(!row)throw new Error('schedule not found');
    row.lastRunAt=iso(at instanceof Date?at.toISOString():at);
    row.lastRunId=runId||row.lastRunId||null;
    row.lastRunState=String(state||'').slice(0,80)||null;
    row.lastError=error?String(error.message||error).slice(0,500):null;
    row.updatedAt=new Date().toISOString();return structuredClone(row);
  });
}

export const scheduleLimits=Object.freeze({minIntervalMinutes:MIN_INTERVAL_MINUTES,maxIntervalMinutes:MAX_INTERVAL_MINUTES});
