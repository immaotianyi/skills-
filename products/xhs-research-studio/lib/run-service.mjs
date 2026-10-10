import { createRun, getRun, listRuns, transitionRun, requeueRun, RUN_STATES } from './runs.mjs';
import { executorConfigured, runConfiguredExecutor } from './executor.mjs';
import { claimDueSchedules, createSchedule, getSchedule, listSchedules, recordScheduleRun, updateSchedule } from './schedules.mjs';
import { getProject, getProjects, listSnapshots, loadSnapshot, mutateProjects, saveSnapshot } from './storage.mjs';
import { diffHarvest } from './analysis.mjs';

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

export class RunService{
  constructor(dataDir,{schedulerTickMs}={}){
    this.dataDir=dataDir;
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
      activeProjects:[...new Set([...this.launchingProjects,...this.activeByProject.keys()])],
    };
  }

  async runs(projectId){return listRuns(this.dataDir,projectId)}
  async run(projectId,runId){return getRun(this.dataDir,projectId,runId)}
  async schedules(projectId){return listSchedules(this.dataDir,projectId)}
  async schedule(scheduleId){return getSchedule(this.dataDir,scheduleId)}
  async createSchedule(projectId,input){return createSchedule(this.dataDir,projectId,input)}
  async updateSchedule(scheduleId,patch){return updateSchedule(this.dataDir,scheduleId,patch)}

  async launch(project,{budget={},trigger='manual',scheduleId=null}={}){
    if(this.#busy(project.id))throw new RunServiceError(409,'A Harvest run is already active or launching for this project.','RUN_BUSY');
    // Reserve synchronously before the first await. Without this, two concurrent HTTP
    // requests can both observe an idle project and create two queued runs.
    this.launchingProjects.add(project.id);
    try{
      const run=await createRun(this.dataDir,project,{budget,trigger,scheduleId});
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
        current=await transitionRun(this.dataDir,project.id,current.id,RUN_STATES.MANUAL_ACTION_REQUIRED,{
          riskState:result.riskState||'BLOCKED',gaps:result.gaps||[],stoppedBecause:result.reason||'Manual action required.',
        });
        if(current.scheduleId)await recordScheduleRun(this.dataDir,current.scheduleId,{runId:current.id,state:current.state});
        return current;
      }

      // Commit point: once set, cancellation is rejected so persisted run state cannot
      // disagree with a snapshot that is already being written.
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
        // #execute owns schedule run-state recording. Do not write the stale queued
        // state here after launch because a very fast executor may already be running
        // or completed by the time launch() resolves.
        await this.launch(project,{budget:schedule.budget,trigger:'schedule',scheduleId:schedule.id});
      }catch(error){
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
    }
  }

  async start(){
    if(this.timer)return;
    await this.recover();
    await this.tick();
    this.timer=setInterval(()=>this.tick().catch(error=>console.error('scheduler tick failed',error)),this.schedulerTickMs);
    this.timer.unref?.();
  }

  stop(){
    if(this.timer){clearInterval(this.timer);this.timer=null}
    for(const active of this.abortByProject.values()){
      if(!active.committing)active.controller.abort();
    }
  }
}
