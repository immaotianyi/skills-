import { requireHostedSession } from './hosted-http.mjs';
import { buildWorkspaceDashboard } from './workspace-dashboard.mjs';
import { acknowledgeAlert, clearAlertAcknowledgement, decorateAlertsWithAcknowledgements } from './alert-state.mjs';

export class WorkspaceDashboardHttpError extends Error{
  constructor(statusCode,message,code='WORKSPACE_DASHBOARD_ERROR'){super(message);this.statusCode=statusCode;this.code=code}
}

function parseLimit(value,fallback=100,max=500){const n=Math.trunc(Number(value));return Number.isFinite(n)&&n>0?Math.min(max,n):fallback}

async function dashboardFor({store,dataDir,getProjects,workspaceId,alertLimit=100}){
  const projects=await getProjects();
  const dashboard=await buildWorkspaceDashboard(dataDir,{workspaceId,projects,alertLimit});
  return {...dashboard,alerts:decorateAlertsWithAcknowledgements(store,workspaceId,dashboard.alerts)};
}

export async function handleWorkspaceDashboardApi({req,res,url,store,dataDir,getProjects,readJson,send}){
  const parts=url.pathname.split('/').filter(Boolean);
  if(parts[0]!=='api'||parts[1]!=='workspaces'||!parts[2])return false;
  const workspaceId=parts[2];
  if(parts[3]!=='dashboard'&&parts[3]!=='alerts')return false;
  const session=requireHostedSession(req,store);

  if(parts[3]==='dashboard'&&parts.length===4&&req.method==='GET'){
    store.requireRole(session.user.id,workspaceId,['owner','admin','analyst','viewer']);
    const dashboard=await dashboardFor({store,dataDir,getProjects,workspaceId,alertLimit:parseLimit(url.searchParams.get('alertLimit'))});
    return send(res,200,dashboard);
  }

  if(parts[3]==='alerts'&&parts[4]&&parts[5]==='ack'){
    store.requireRole(session.user.id,workspaceId,['owner','admin','analyst']);
    const alertId=parts[4];
    const dashboard=await dashboardFor({store,dataDir,getProjects,workspaceId,alertLimit:500});
    if(!dashboard.alerts.some(alert=>alert.id===alertId))throw new WorkspaceDashboardHttpError(404,'alert not found','ALERT_NOT_FOUND');
    if(req.method==='POST'){
      const body=await readJson(req);
      const acknowledgement=acknowledgeAlert(store,{workspaceId,alertId,userId:session.user.id,note:body.note});
      return send(res,200,{acknowledgement});
    }
    if(req.method==='DELETE'){
      const acknowledgement=clearAlertAcknowledgement(store,{workspaceId,alertId,userId:session.user.id});
      return send(res,200,{acknowledgement});
    }
  }
  return false;
}
