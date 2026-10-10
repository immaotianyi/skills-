import { RunServiceError } from './run-service.mjs';

export class RunHttpError extends Error{
  constructor(statusCode,message,details=[]){super(message);this.statusCode=statusCode;this.details=details}
}

function asClientError(error,fallback='Invalid run request.'){
  if(error instanceof RunServiceError)return error;
  if(Number(error?.statusCode)>=400&&Number(error?.statusCode)<500)return error;
  const message=String(error?.message||fallback);
  if(/not found/i.test(message))return new RunHttpError(404,message);
  return new RunHttpError(400,message);
}

async function requireRun(runService,projectId,runId){
  const run=await runService.run(projectId,runId);
  if(!run)throw new RunHttpError(404,'run not found');
  return run;
}

async function requireSchedule(runService,projectId,scheduleId){
  const schedule=await runService.schedule(scheduleId);
  if(!schedule||schedule.projectId!==projectId)throw new RunHttpError(404,'schedule not found');
  return schedule;
}

export async function handleProjectRunApi({req,res,parts,project,runService,readJson,send}){
  if(parts[3]==='runs'){
    if(parts.length===4&&req.method==='GET'){
      send(res,200,{runs:await runService.runs(project.id),system:runService.status()});
      return true;
    }
    if(parts.length===4&&req.method==='POST'){
      const body=await readJson(req);
      let run;
      try{run=await runService.launch(project,{budget:body?.budget||body||{},trigger:'manual'})}
      catch(error){throw asClientError(error)}
      send(res,202,{run,system:runService.status()});
      return true;
    }
    if(parts[4]){
      const runId=parts[4];
      if(parts.length===5&&req.method==='GET'){
        send(res,200,{run:await requireRun(runService,project.id,runId)});
        return true;
      }
      if(parts[5]==='resume'&&req.method==='POST'){
        await requireRun(runService,project.id,runId);
        try{send(res,202,{run:await runService.resume(project,runId),system:runService.status()})}
        catch(error){throw asClientError(error)}
        return true;
      }
      if(parts[5]==='cancel'&&req.method==='POST'){
        await requireRun(runService,project.id,runId);
        try{send(res,200,{run:await runService.cancel(project,runId),system:runService.status()})}
        catch(error){throw asClientError(error)}
        return true;
      }
    }
  }

  if(parts[3]==='schedules'){
    if(parts.length===4&&req.method==='GET'){
      send(res,200,{schedules:await runService.schedules(project.id)});
      return true;
    }
    if(parts.length===4&&req.method==='POST'){
      const body=await readJson(req);
      try{send(res,201,{schedule:await runService.createSchedule(project.id,body||{})})}
      catch(error){throw asClientError(error)}
      return true;
    }
    if(parts[4]){
      const scheduleId=parts[4];
      const schedule=await requireSchedule(runService,project.id,scheduleId);
      if(parts.length===5&&req.method==='GET'){
        send(res,200,{schedule});
        return true;
      }
      if(parts.length===5&&['PATCH','PUT'].includes(req.method)){
        const body=await readJson(req);
        try{send(res,200,{schedule:await runService.updateSchedule(scheduleId,body||{})})}
        catch(error){throw asClientError(error)}
        return true;
      }
      if(parts[5]==='run-now'&&req.method==='POST'){
        try{
          const run=await runService.launch(project,{budget:schedule.budget,trigger:'schedule_manual',scheduleId:schedule.id});
          send(res,202,{run,system:runService.status()});
        }catch(error){throw asClientError(error)}
        return true;
      }
    }
  }
  return false;
}
