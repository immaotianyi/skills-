import { HostedStoreError } from './hosted-db.mjs';

const DISABLE_SCHEDULE_CODES=new Set(['ENTITLEMENT_REQUIRED','RUN_BUDGET_PLAN_LIMIT']);
const ACTIVE_STATUSES=new Set(['active','trialing']);

function assertResumeAllowed(store,workspaceId,budget){
  const ent=store.getEntitlement(workspaceId);
  if(!ACTIVE_STATUSES.has(ent.status))throw new HostedStoreError('An active paid or trial entitlement is required.',{code:'ENTITLEMENT_REQUIRED',statusCode:402});
  if(Number(budget?.maxNotes||0)>ent.maxNotesRun||Number(budget?.maxComments||0)>ent.maxCommentsRun){
    throw new HostedStoreError('Requested run budget exceeds workspace plan limits.',{code:'RUN_BUDGET_PLAN_LIMIT',statusCode:402});
  }
  return ent;
}

export function createHostedRunPolicy(store){
  if(!store)throw new TypeError('HostedStore is required');
  return {
    async beforeRun(project,{budget,trigger,scheduleId,resume=false,runId=null}){
      if(!project?.workspaceId)throw new HostedStoreError('Hosted projects must belong to a workspace.',{code:'WORKSPACE_REQUIRED',statusCode:403});
      if(resume){
        const ent=assertResumeAllowed(store,project.workspaceId,budget);
        store.audit({workspaceId:project.workspaceId,action:'run.resume.authorized',targetType:'run',targetId:runId,metadata:{trigger,scheduleId,budget,plan:ent.plan,status:ent.status}});
        return;
      }
      const usage=store.reserveRun(project.workspaceId,budget);
      store.audit({workspaceId:project.workspaceId,action:'run.reserve',targetType:'project',targetId:project.id,metadata:{trigger,scheduleId,resume:false,budget,month:usage.month,runs:usage.runs}});
    },
    async afterCollect(project,run,actual){
      if(!project?.workspaceId)return;
      const usage=store.recordRunUsage(project.workspaceId,{notes:actual.notes,comments:actual.comments});
      store.audit({workspaceId:project.workspaceId,action:'run.usage.record',targetType:'run',targetId:run.id,metadata:{actual,month:usage.month,runs:usage.runs,notes:usage.notes,comments:usage.comments}});
    },
    async afterComplete(project,run){
      if(!project?.workspaceId)return;
      store.audit({workspaceId:project.workspaceId,action:'run.completed',targetType:'run',targetId:run.id,metadata:{snapshotId:run.snapshotId,counts:run.counts,riskState:run.riskState}});
    },
    async scheduledLaunchError(project,schedule,error){
      if(project?.workspaceId)store.audit({workspaceId:project.workspaceId,action:'schedule.launch.failed',targetType:'schedule',targetId:schedule.id,metadata:{code:error?.code||'RUN_FAILED',message:String(error?.message||error).slice(0,500)}});
      return {disableSchedule:DISABLE_SCHEDULE_CODES.has(error?.code)};
    },
  };
}
