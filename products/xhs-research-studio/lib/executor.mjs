import { spawn } from 'node:child_process';

const HARD_STOP_STATES=new Set(['CAPTCHA','LOGIN_REQUIRED','ACCESS_DENIED','BLOCKED','THROTTLED']);

export class ExecutorError extends Error{
  constructor(message,{code='EXECUTOR_ERROR',details=[]}={}){super(message);this.name='ExecutorError';this.code=code;this.details=details}
}

function parseArgs(){
  const raw=String(process.env.XHS_STUDIO_HARVEST_EXECUTOR_ARGS||'').trim();
  if(!raw)return[];
  let parsed;
  try{parsed=JSON.parse(raw)}catch{throw new ExecutorError('XHS_STUDIO_HARVEST_EXECUTOR_ARGS must be valid JSON.',{code:'EXECUTOR_CONFIG'})}
  if(!Array.isArray(parsed)||parsed.some(x=>typeof x!=='string'))throw new ExecutorError('XHS_STUDIO_HARVEST_EXECUTOR_ARGS must be a JSON array of strings.',{code:'EXECUTOR_CONFIG'});
  return parsed;
}

function executorEnv(){
  const allowed={};
  for(const key of ['PATH','HOME','LANG','LC_ALL','TZ'])if(process.env[key])allowed[key]=process.env[key];
  for(const [key,value] of Object.entries(process.env))if(key.startsWith('XHS_EXECUTOR_'))allowed[key]=value;
  return allowed;
}

export function executorConfigured(){
  return Boolean(String(process.env.XHS_STUDIO_HARVEST_EXECUTOR||'').trim());
}

export function buildExecutorPlan(project,run){
  return {
    schemaVersion:'xhs-harvest-run-plan/1.0',
    runId:run.id,
    project:{
      id:project.id,
      name:project.name,
      client:project.client||'',
      category:project.category||'',
      keywords:Array.isArray(project.keywords)?project.keywords:[],
      competitors:Array.isArray(project.competitors)?project.competitors:[],
    },
    budget:run.budget,
    safety:{
      publicOrAuthorizedReadOnlyOnly:true,
      bypassCaptcha:false,
      bypassLogin:false,
      bypassAccessControls:false,
      bypassRateLimits:false,
      onBlockedState:'manual_action_required',
    },
    requiredOutput:{
      format:'JSON',
      completed:'{"status":"completed","harvest":<Harvest v2 payload>}',
      manual:'{"status":"manual_action_required","reason":"...","riskState":"CAPTCHA|LOGIN_REQUIRED|ACCESS_DENIED|BLOCKED|THROTTLED","gaps":[]}',
    },
  };
}

function normalizeProtocol(value){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new ExecutorError('Executor output must be one JSON object.',{code:'EXECUTOR_PROTOCOL'});
  const status=String(value.status||'').trim();
  if(status==='manual_action_required'){
    const riskState=String(value.riskState||'').trim().toUpperCase()||'BLOCKED';
    return {
      status,
      reason:String(value.reason||'Manual action is required.').slice(0,500),
      riskState,
      gaps:Array.isArray(value.gaps)?value.gaps.map(x=>String(x).slice(0,300)).slice(0,100):[],
    };
  }
  if(status!=='completed'||!value.harvest||typeof value.harvest!=='object'){
    throw new ExecutorError('Executor must return completed+harvest or manual_action_required.',{code:'EXECUTOR_PROTOCOL'});
  }
  const riskState=String(value.harvest?.meta?.riskState||'NORMAL').toUpperCase();
  if(HARD_STOP_STATES.has(riskState)||value.harvest?.meta?.loginRequired===true){
    return {
      status:'manual_action_required',
      reason:String(value.harvest?.meta?.stoppedBecause||`Harvest stopped in ${riskState}.`).slice(0,500),
      riskState:value.harvest?.meta?.loginRequired===true&&riskState==='NORMAL'?'LOGIN_REQUIRED':riskState,
      gaps:Array.isArray(value.harvest?.meta?.gaps)?value.harvest.meta.gaps.map(x=>String(x).slice(0,300)).slice(0,100):[],
    };
  }
  return {status:'completed',harvest:value.harvest};
}

export async function runConfiguredExecutor(project,run,{timeoutMs,maxOutputBytes=20_000_000}={}){
  const command=String(process.env.XHS_STUDIO_HARVEST_EXECUTOR||'').trim();
  if(!command){
    return {status:'manual_action_required',reason:'No Harvest executor is configured on this Studio instance.',riskState:'EXECUTOR_NOT_CONFIGURED',gaps:['Configure XHS_STUDIO_HARVEST_EXECUTOR or use the existing authorized manual ingest flow.']};
  }
  const args=parseArgs();
  const timeout=Number.isFinite(Number(timeoutMs))?Math.max(1,Number(timeoutMs)):Math.max(15_000,(run?.budget?.maxSeconds||300)*1000);
  const outputLimit=Math.max(1_024,Number(maxOutputBytes)||20_000_000);
  const plan=JSON.stringify(buildExecutorPlan(project,run))+'\n';

  return new Promise((resolve,reject)=>{
    const child=spawn(command,args,{shell:false,stdio:['pipe','pipe','pipe'],env:executorEnv(),windowsHide:true});
    let stdout=[];let stderr=[];let stdoutBytes=0;let stderrBytes=0;let settled=false;
    const finish=(fn,value)=>{if(settled)return;settled=true;clearTimeout(timer);fn(value)};
    const fail=(message,code='EXECUTOR_ERROR')=>finish(reject,new ExecutorError(message,{code}));
    const timer=setTimeout(()=>{
      child.kill('SIGKILL');
      fail(`Harvest executor exceeded ${timeout} ms timeout.`,'EXECUTOR_TIMEOUT');
    },timeout);

    child.on('error',err=>fail(`Failed to start Harvest executor: ${err.message}`,'EXECUTOR_START'));
    child.stdout.on('data',chunk=>{
      stdoutBytes+=chunk.length;
      if(stdoutBytes>outputLimit){child.kill('SIGKILL');fail(`Harvest executor stdout exceeded ${outputLimit} bytes.`,'EXECUTOR_OUTPUT_LIMIT');return}
      stdout.push(chunk);
    });
    child.stderr.on('data',chunk=>{
      stderrBytes+=chunk.length;
      if(stderrBytes<=64_000)stderr.push(chunk);
    });
    child.on('close',code=>{
      if(settled)return;
      if(code!==0){
        const detail=Buffer.concat(stderr).toString('utf8').trim().slice(0,2_000);
        fail(`Harvest executor exited with code ${code}${detail?`: ${detail}`:''}.`,'EXECUTOR_EXIT');return;
      }
      const text=Buffer.concat(stdout).toString('utf8').trim();
      if(!text){fail('Harvest executor produced no JSON output.','EXECUTOR_PROTOCOL');return}
      let parsed;
      try{parsed=JSON.parse(text)}catch(err){fail(`Harvest executor output is not valid JSON: ${err.message}`,'EXECUTOR_PROTOCOL');return}
      try{finish(resolve,normalizeProtocol(parsed))}catch(err){finish(reject,err)}
    });
    child.stdin.on('error',err=>fail(`Failed writing executor plan: ${err.message}`,'EXECUTOR_IO'));
    child.stdin.end(plan);
  });
}
