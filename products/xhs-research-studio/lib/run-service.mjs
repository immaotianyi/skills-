import { createRun, getRun, listRuns, transitionRun, requeueRun, RUN_STATES, normalizeRunBudget } from './runs.mjs';
import { executorConfigured, runConfiguredExecutor } from './executor.mjs';
import { claimDueSchedules, createSchedule, getSchedule, listSchedules, recordScheduleRun, updateSchedule } from './schedules.mjs';
import { getProject, getProjects, listSnapshots, loadSnapshot, mutateProjects, saveSnapshot } from './storage.mjs';
import { diffHarvest } from './analysis.mjs';
import { normalizeHarvest } from './normalize.mjs';
import { validateHarvestInput } from './validation.mjs';

export class RunServiceError extends Error{
  constructor(statusCode,message,code='RUN_SERVICE_ERROR'){super(message);this.statusCode=statusCode;this.code=code}
}

function counts(snapshot){
  return {
    notes:snapshot?.harvest?.notes?.length||0,
    comments:snapshot?.harvest?.comments?.length||0,
    queries:snapshot?.harvest?.queries?.length||0,
  };
}

function executorHarvestWithinBudget(raw,budget){
  const validation=validateHarvestInput(raw,{strictV2:true});
  if(!validation.ok){
    const error=new Error(`Executor returned invalid strict Harvest v2 payload: ${validation.errors.slice(0,5).map(item=>`${item.path}: ${item.message}`).join('; ')}`);
    error.code='EXECUTOR_INVALID_HARVEST';
    throw error;
  }
  const normalized=normalizeHarvest(raw);
  const actual={notes:normalized.notes.length,comments:normalized.comments.length,queries:normalized.queries.length};
  const violations=[];
  if(actual.notes>budget.maxNotes)violations.push(`notes ${actual.notes} > maxNotes ${budget.maxNotes}`);
  if(actual.comments>budget.maxComments)violations.push(`comments ${actual.comments} > maxComments ${budget.maxComments}`);
  if(violations.length){
    const error=new Error(`Executor output exceeded the server-enforced run budget: ${violations.join(', ')}.`);
    error.code='RUN_BUDGET_EXCEEDED';
    throw error;
  }
  return actual;
}

export class RunService{
  constructor(dataDir,{schedulerTickMs,policy=null}={}){
    this.dataDir=dataDir;
    this.policy=policy;
    this.activeByProject=new Map();
    this.abortByProject=new Map();
    this.launchingProjects=new Set();
    this.timer=null;
    const configured=Number(schedulerTickMs??process.env.XHS_STUDIO_SCHEDULER_TICK_MS??30_000);
    this.schedulerTickMs=Number.isFinite(configured)?Math.max(250,Math.min(300_000,configured)):30_000;
  }

  #busy(projectId){return this.launchingProjects.has(projectId)||this.activeByProject.has(projectId)}

  status(){
    return {
      executorConfigured:executorConfigured(),
      schedulerTickMs:this.schedulerTickMs,
      policyConfigured:Boolean(this.policy),
      activeProjects:[...new Set([...this.launchingProjects,...this.activeByProject.keys()])],
    };
  }

  async runs(projectId){return listRuns(this.dataDir,projectId)}
  async run(projectId,runId){return getRun(this.dataDir,projectId,runId)}

  async #reconcileSchedule(schedule,{persist=false}={}){
    if(!schedule?.projectId||!schedule?.lastRunId)return schedule;
    const run=await getRun(this.dataDir,schedule.projectId,schedule.lastRunId).catch(()=>null);
    if(!run||run.state===schedule.lastRunState)return schedule;
    const reconciled={
      ...schedule,
      lastRunState:run.state,
      lastRunAt:run.finishedAt||run.updatedAt||schedule.lastRunAt,
      lastError:run.error?.message||null,
    };
    if(persist){
      return recordScheduleRun(this.dataDir,schedule.id,{
        runId:run.id,
        state:run.state,
        error:run.error?.message||null,
        at:run.finishedAt||run.updatedAt||new Date(),
      });
    }
    return reconciled;
  }

  async schedules(projectId){
    const schedules=await listSchedules(this.dataDir,projectId);
    return Promise.all(schedules.map(schedule=>this.#reconcileSchedule(schedule)));
  }
  async schedule(scheduleId){
    return this.#reconcileSchedule(await getSchedule(this.dataDir,scheduleId));
  }
  async createSchedule(projectId,input){return createSchedule(this.dataDir,projectId,input)}
  async updateSchedule(scheduleId,patch){return updateSchedule(this.dataDir,scheduleId,patch)}

  async #beforeRun(project,meta){
    if(this.policy?.beforeRun)await this.policy.beforeRun(project,meta);
  }

  async launch(project,{budget={},trigger='manual',scheduleId=null}={}){
    if(this.#busy(project.id))throw new RunServiceError(409,'A Harvest run is already active or launching for this project.','RUN_BUSY');
    this.launchingProjects.add(project.id);
    try{
      const normalizedBudget=normalizeRunBudget(budget);
      await this.#beforeRun(project,{budget:normalizedBudget,trigger,scheduleId,resume:false});
      const run=await createRun(this.dataDir,project,{budget:normalizedBudget,trigger,scheduleId});
      this.execute(project,run).catch(()=>{});
      return run;
    }finally{
      this.launchingProjects.delete(project.id);
    }
  }

  async resume(project,runId){
    if(this.#busy(project.id))throw new RunServiceError(409,'A Harvest run is already active or launching for this project.','RUN_BUSY');
    this.launchingProjects.add(project.id);
    try{
      const existing=await getRun(this.dataDir,project.id,runId);
      if(!existing)throw new RunServiceError(404,'run not found','RUN_NOT_FOUND');
      await this.#beforeRun(project,{budget:existing.budget,trigger:'resume',scheduleId:existing.scheduleId||null,resume:true,runId});
      const queued=await requeueRun(this.dataDir,project.id,runId);
      this.execute(project,queued).catch(()=>{});
      return queued;
    }finally{
      this.launchingProjects.delete(project.id);
    }
  }

  async cancel(project,runId){
    const current=await getRun(this.dataDir,project.id,runId);
    if(!current)throw new RunServiceError(404,'run not found','RUN_NOT_FOUND');
    if([RUN_STATES.COMPLETED,RUN_STATES.CANCELLED].includes(current.state)){
      throw new RunServiceError(409,`Run cannot be cancelled from ${current.state}.`,'RUN_NOT_CANCELLABLE');
    }
    const active=this.abortByProject.get(project.id);
    if(active?.runId===runId&&active.committing){
      throw new RunServiceError(409,'Run result is already being committed as a snapshot and can no longer be cancelled safely.','RUN_COMMITTING');
    }
    if(active?.runId===runId)active.controller.abort();
    try{
      return await transitionRun(this.dataDir,project.id,runId,RUN_STATES.CANCELLED,{stoppedBecause:'Cancelled by operator.'});
    }catch(error){
      throw new RunServiceError(409,error.message,'RUN_NOT_CANCELLABLE');
    }
  }

  async execute(project,run){
    if(this.activeByProject.has(project.id))throw new RunServiceError(409,'A Harvest run is already active for this project.','RUN_BUSY');
    const controller=new AbortController();
    const active={runId:run.id,controller,committing:false};
    this.abortByProject.set(project.id,active);
    const task=this.#execute(project,run,{signal:controller.signal,active});
    this.activeByProject.set(project.id,task);
    try{return await task}finally{
      if(this.activeByProject.get(project.id)===task)this.activeByProject.delete(project.id);
      if(this.abortByProject.get(project.id)===active)this.abortByProject.delete(project.id);
    }
  }

  async #execute(project,run,{signal,active}={}){
    let current=await transitionRun(this.dataDir,project.id,run.id,RUN_STATES.RUNNING);
    if(current.scheduleId)await recordScheduleRun(this.dataDir,current.scheduleId,{runId:current.id,state:current.state});
    try{
      const result=await runConfiguredExecutor(project,current,{timeoutMs:current.budget.maxSeconds*1000,signal});
      const latestAfterExecutor=await getRun(this.dataDir,project.id,current.id);
      if(latestAfterExecutor?.state===RUN_STATES.CANCELLED)return latestAfterExecutor;
      if(result.status==='manual_action_required'){
        if(current.scheduleId)await updateSchedule(this.dataDir,current.scheduleId,{enabled:false});
        current=await transitionRun(this.dataDir,project.id,current.id,RUN_STATES.MANUAL_ACTION_REQUIRED,{
          riskState:result.riskState||'BLOCKED',gaps:result.gaps||[],stoppedBecause:result.reason||'Manual action required.',
        });
        if(current.scheduleId)await recordScheduleRun(this.dataDir,current.scheduleId,{runId:current.id,state:current.state});
        return current;
      }

      const actual=executorHarvestWithinBudget(result.harvest,current.budget);
      if(this.policy?.afterCollect)await this.policy.afterCollect(project,current,actual);

      if(active)active.committing=true;
      const before=await listSnapshots(this.dataDir,project.id);
      const snapshot=await saveSnapshot(this.dataDir,project.id,result.harvest);
      await mutateProjects(this.dataDir,projects=>{
        const index=projects.findIndex(item=>item.id===project.id);
        if(index<0)throw new RunServiceError(404,'project not found','PROJECT_NOT_FOUND');
        projects[index]={...projects[index],updatedAt:new Date().toISOString(),lastSnapshotAt:snapshot.createdAt};
        return projects[index];
      });

      let attention=[];
      if(before.length){
        try{
          const previous=await loadSnapshot(this.dataDir,project.id,before.at(-1).id);
          if(previous?.harvest)attention=diffHarvest(previous.harvest,snapshot.harvest).alerts||[];
        }catch{
          attention=[];
        }
      }
      current=await transitionRun(this.dataDir,project.id,current.id,RUN_STATES.COMPLETED,{
        snapshotId:snapshot.id,
        riskState:snapshot.harvest?.meta?.riskState||'NORMAL',
        gaps:snapshot.harvest?.meta?.gaps||[],
        stoppedBecause:snapshot.harvest?.meta?.stoppedBecause||null,
        counts:counts(snapshot),
        attention,
      });
      if(current.scheduleId)await recordScheduleRun(this.dataDir,current.scheduleId,{runId:current.id,state:current.state});
      if(this.policy?.afterComplete)await this.policy.afterComplete(project,current,snapshot).catch?.(()=>{});
      return current;
    }catch(error){
      const latest=await getRun(this.dataDir,project.id,current.id).catch(()=>null);
      if(latest?.state===RUN_STATES.CANCELLED){
        if(latest.scheduleId)await recordScheduleRun(this.dataDir,latest.scheduleId,{runId:latest.id,state:latest.state}).catch(()=>{});
        return latest;
      }
      try{
        current=await transitionRun(this.dataDir,project.id,current.id,RUN_STATES.FAILED,{error:{code:error.code||'RUN_FAILED',message:error.message||String(error)}});
      }catch{}
      if(current?.scheduleId)await recordScheduleRun(this.dataDir,current.scheduleId,{runId:current.id,state:RUN_STATES.FAILED,error}).catch(()=>{});
      throw error;
    }
  }

  async tick(){
    const due=await claimDueSchedules(this.dataDir,{now:new Date(),limit:20});
    for(const schedule of due){
      const project=await getProject(this.dataDir,schedule.projectId);
      if(!project){
        await updateSchedule(this.dataDir,schedule.id,{enabled:false});
        await recordScheduleRun(this.dataDir,schedule.id,{state:'disabled_missing_project',error:'Project no longer exists.'});
        continue;
      }
      if(this.#busy(project.id)){
        await recordScheduleRun(this.dataDir,schedule.id,{state:'skipped_overlap',error:'Previous project run is still active or launching.'});
        continue;
      }
      try{
        await this.launch(project,{budget:schedule.budget,trigger:'schedule',scheduleId:schedule.id});
      }catch(error){
        const directive=this.policy?.scheduledLaunchError?await this.policy.scheduledLaunchError(project,schedule,error):null;
        if(directive?.disableSchedule)await updateSchedule(this.dataDir,schedule.id,{enabled:false}).catch(()=>{});
        await recordScheduleRun(this.dataDir,schedule.id,{state:'launch_failed',error});
      }
    }
    return due.length;
  }

  async recover(){
    const projects=await getProjects(this.dataDir);
    for(const project of projects){
      const runs=await listRuns(this.dataDir,project.id);
      for(const run of runs.filter(item=>item.state===RUN_STATES.RUNNING)){
        await transitionRun(this.dataDir,project.id,run.id,RUN_STATES.FAILED,{error:{code:'SERVER_RESTART',message:'Server restarted while this executor run was active; result was not trusted.'}}).catch(()=>{});
      }
      const queued=runs.filter(item=>item.state===RUN_STATES.QUEUED);
      if(queued.length&&!this.activeByProject.has(project.id))this.execute(project,queued[0]).catch(()=>{});
      for(const extra of queued.slice(1)){
        await transitionRun(this.dataDir,project.id,extra.id,RUN_STATES.CANCELLED,{stoppedBecause:'Cancelled during restart recovery because another queued run for the project was resumed.'}).catch(()=>{});
      }
      const schedules=await listSchedules(this.dataDir,project.id);
      for(const schedule of schedules){
        await this.#reconcileSchedule(schedule,{persist:true}).catch(()=>{});
      }
    }
  }

  async start(){
    if(this.timer)return;
    await this.recover();
    await this.tick();
    this.timer=setInterval(()=>this.tick().catch(error=>console.error('scheduler tick failed',error)),this.schedulerTickMs);
    this.timer.unref?.();
  }

  async stop({timeoutMs=4_000}={}){
    if(this.timer){clearInterval(this.timer);this.timer=null}
    const tasks=[...this.activeByProject.values()];
    for(const active of this.abortByProject.values()){
      if(!active.committing)active.controller.abort();
    }
    if(!tasks.length)return {settled:true,active:0};
    let timedOut=false;
    let timer;
    await Promise.race([
      Promise.allSettled(tasks),
      new Promise(resolve=>{
        timer=setTimeout(()=>{timedOut=true;resolve()},Math.max(100,Number(timeoutMs)||4_000));
        timer.unref?.();
      }),
    ]);
    if(timer)clearTimeout(timer);
    return {settled:!timedOut,active:this.activeByProject.size};
  }
}