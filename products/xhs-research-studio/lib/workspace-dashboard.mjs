import crypto from 'node:crypto';
import { listRuns } from './runs.mjs';
import { listSchedules } from './schedules.mjs';
import { listSnapshots } from './storage.mjs';

const LEVEL_WEIGHT=Object.freeze({high:3,medium:2,low:1,info:0});

function safe(value,max=500){return String(value??'').trim().slice(0,max)}
function stableAlertId(parts){return `alt_${crypto.createHash('sha256').update(parts.map(value=>String(value??'')).join('\0')).digest('hex').slice(0,24)}`}
function newest(rows,key='createdAt'){return [...(rows||[])].sort((a,b)=>(Date.parse(b?.[key]||'')||0)-(Date.parse(a?.[key]||'')||0)||String(b?.id||'').localeCompare(String(a?.id||'')))[0]||null}
function earliest(rows,key){return [...(rows||[])].filter(row=>Number.isFinite(Date.parse(row?.[key]||''))).sort((a,b)=>Date.parse(a[key])-Date.parse(b[key])||String(a?.id||'').localeCompare(String(b?.id||'')))[0]||null}
function sourcePaths(projectId,run){return {
  project:`/api/projects/${encodeURIComponent(projectId)}`,
  run:run?.id?`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(run.id)}`:null,
  snapshot:run?.snapshotId?`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(run.snapshotId)}`:null,
}}
function alertRecord({workspaceId,project,run=null,level='medium',type,title,detail='',createdAt='',source={}}){
  const projectId=project.id,runId=run?.id||null,snapshotId=run?.snapshotId||null,timestamp=createdAt||run?.finishedAt||run?.updatedAt||run?.createdAt||project.updatedAt||project.createdAt||new Date(0).toISOString();
  return {
    id:stableAlertId([workspaceId,projectId,runId,type,title,detail,timestamp]),
    workspaceId,projectId,projectName:project.name,runId,snapshotId,
    level:LEVEL_WEIGHT[level]===undefined?'medium':level,type:safe(type,80),title:safe(title,240),detail:safe(detail,1000),
    createdAt:timestamp,source:{...sourcePaths(projectId,run),...source},
  };
}
function operationalRunAlert(workspaceId,project,run){
  if(run?.state==='manual_action_required')return alertRecord({workspaceId,project,run,level:'high',type:'manual-action-required',title:'Harvest run needs manual action',detail:[run.riskState,run.stoppedBecause].filter(Boolean).join(' · ')});
  if(run?.state==='failed')return alertRecord({workspaceId,project,run,level:'high',type:'run-failed',title:'Harvest run failed',detail:[run.error?.code,run.error?.message].filter(Boolean).join(' · ')});
  return null;
}
function scheduleAlert(workspaceId,project,schedule){
  if(!schedule?.lastRunState)return null;
  if(['launch_failed','disabled_missing_project'].includes(schedule.lastRunState))return alertRecord({workspaceId,project,level:'high',type:'schedule-failed',title:'Scheduled monitoring needs attention',detail:schedule.lastError||schedule.lastRunState,createdAt:schedule.lastRunAt||schedule.updatedAt,source:{scheduleId:schedule.id}});
  if(schedule.lastRunState==='skipped_overlap')return alertRecord({workspaceId,project,level:'medium',type:'schedule-overlap',title:'Scheduled run skipped because a previous run was still active',detail:schedule.lastError||'',createdAt:schedule.lastRunAt||schedule.updatedAt,source:{scheduleId:schedule.id}});
  return null;
}
function attentionAlerts(workspaceId,project,runs){
  const out=[];
  for(const run of runs){
    for(const [index,item] of (run.attention||[]).entries()){
      out.push(alertRecord({workspaceId,project,run,level:item.level||'medium',type:item.type||'attention',title:item.title||'Research attention',detail:item.detail||'',createdAt:run.finishedAt||run.updatedAt,source:{attentionIndex:index}}));
    }
  }
  return out;
}
function sortAlerts(rows){return rows.sort((a,b)=>(LEVEL_WEIGHT[b.level]??0)-(LEVEL_WEIGHT[a.level]??0)||(Date.parse(b.createdAt)||0)-(Date.parse(a.createdAt)||0)||a.id.localeCompare(b.id))}

export async function buildWorkspaceDashboard(dataDir,{workspaceId,projects=[],alertLimit=100,runHistoryLimit=20}={}){
  if(!workspaceId)throw new TypeError('workspaceId is required');
  const scoped=(projects||[]).filter(project=>project?.workspaceId===workspaceId);
  const projectRows=[];
  const alerts=[];
  let activeRuns=0,manualAction=0,failedRuns=0,enabledSchedules=0,totalSnapshots=0;

  for(const project of scoped){
    const [allRuns,schedules,snapshots]=await Promise.all([
      listRuns(dataDir,project.id),listSchedules(dataDir,project.id),listSnapshots(dataDir,project.id),
    ]);
    const recentRuns=allRuns.slice(-Math.max(1,Math.min(100,Math.trunc(runHistoryLimit)||20)));
    const latestRun=newest(allRuns),latestSnapshot=snapshots.at(-1)||null;
    const enabled=schedules.filter(row=>row.enabled),nextSchedule=earliest(enabled,'nextRunAt');
    const projectActive=allRuns.filter(run=>['queued','running'].includes(run.state)).length;
    const projectManual=allRuns.filter(run=>run.state==='manual_action_required').length;
    const projectFailed=allRuns.filter(run=>run.state==='failed').length;
    activeRuns+=projectActive;manualAction+=projectManual;failedRuns+=projectFailed;enabledSchedules+=enabled.length;totalSnapshots+=snapshots.length;

    for(const run of recentRuns){
      const operational=operationalRunAlert(workspaceId,project,run);if(operational)alerts.push(operational);
    }
    alerts.push(...attentionAlerts(workspaceId,project,recentRuns));
    for(const schedule of schedules){const item=scheduleAlert(workspaceId,project,schedule);if(item)alerts.push(item)}
    if(latestSnapshot?.coverage?.riskState&&latestSnapshot.coverage.riskState!=='NORMAL'){
      alerts.push(alertRecord({workspaceId,project,level:'high',type:'latest-capture-risk',title:`Latest capture state: ${latestSnapshot.coverage.riskState}`,detail:(latestSnapshot.coverage.gaps||[]).map(g=>typeof g==='string'?g:JSON.stringify(g)).join(' · '),createdAt:latestSnapshot.createdAt,source:{snapshot:`/api/projects/${encodeURIComponent(project.id)}/snapshots/${encodeURIComponent(latestSnapshot.id)}`}}));
    }

    projectRows.push({
      id:project.id,name:project.name,client:project.client||'',category:project.category||'',updatedAt:project.updatedAt||null,
      latestSnapshot:latestSnapshot?{id:latestSnapshot.id,createdAt:latestSnapshot.createdAt,quality:latestSnapshot.quality||null,coverage:latestSnapshot.coverage||null,integrityStatus:latestSnapshot.integrityStatus||null}:null,
      latestRun:latestRun?{id:latestRun.id,state:latestRun.state,trigger:latestRun.trigger,createdAt:latestRun.createdAt,finishedAt:latestRun.finishedAt,snapshotId:latestRun.snapshotId,riskState:latestRun.riskState,counts:latestRun.counts,error:latestRun.error}:null,
      schedules:{total:schedules.length,enabled:enabled.length,nextRunAt:nextSchedule?.nextRunAt||null},
      health:{activeRuns:projectActive,manualActionRequired:projectManual,failedRuns:projectFailed},
    });
  }

  const deduped=new Map();
  for(const alert of alerts)deduped.set(alert.id,alert);
  const sorted=sortAlerts([...deduped.values()]).slice(0,Math.max(1,Math.min(500,Math.trunc(alertLimit)||100)));
  projectRows.sort((a,b)=>(Date.parse(b.latestSnapshot?.createdAt||b.updatedAt||'')||0)-(Date.parse(a.latestSnapshot?.createdAt||a.updatedAt||'')||0)||a.name.localeCompare(b.name,'zh-CN'));
  return {
    schemaVersion:'xhs-workspace-dashboard/1.0',workspaceId,generatedAt:new Date().toISOString(),
    summary:{projects:projectRows.length,totalSnapshots,activeRuns,manualActionRequired:manualAction,failedRuns,enabledSchedules,alerts:sorted.length,highAlerts:sorted.filter(a=>a.level==='high').length},
    projects:projectRows,alerts:sorted,
  };
}
