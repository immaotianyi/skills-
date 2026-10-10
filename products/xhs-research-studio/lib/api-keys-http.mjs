import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { requireHostedSession, assertSameOrigin } from './hosted-http.mjs';
import { getProjects, getProject, listSnapshots, loadSnapshot } from './storage.mjs';
import { markdownReport } from './analysis.mjs';
import { buildWorkspaceDashboard } from './workspace-dashboard.mjs';
import { decorateAlertsWithAcknowledgements } from './alert-state.mjs';
import { createApiKey, listApiKeys, revokeApiKey, resolveApiKey, bearerApiKey, apiKeyScopes } from './api-keys.mjs';

const moduleDir=path.dirname(fileURLToPath(import.meta.url));
const productRoot=path.dirname(moduleDir);
function dataDir(env=process.env){return env.XHS_STUDIO_DATA||path.join(productRoot,'data')}

export class ApiKeyHttpError extends Error{
  constructor(statusCode,message,code='API_KEY_HTTP_ERROR'){super(message);this.statusCode=statusCode;this.code=code}
}

async function latestProjectReport(root,project){
  const snapshots=await listSnapshots(root,project.id),latest=snapshots.at(-1);
  if(!latest)throw new ApiKeyHttpError(404,'project has no snapshot','SNAPSHOT_NOT_FOUND');
  const snapshot=await loadSnapshot(root,project.id,latest.id),previousMeta=snapshots.at(-2),previous=previousMeta?await loadSnapshot(root,project.id,previousMeta.id):null;
  return {project:{id:project.id,name:project.name,client:project.client||'',category:project.category||''},snapshot:{id:snapshot.id,createdAt:snapshot.createdAt,analysis:snapshot.analysis},markdown:markdownReport(project,snapshot,previous)};
}

export async function handleApiKeysApi({req,res,url,store,readJson,send,env=process.env}){
  const parts=url.pathname.split('/').filter(Boolean),root=dataDir(env);

  if(parts[0]==='api'&&parts[1]==='automation'){
    const token=bearerApiKey(req);
    if(!token)throw new ApiKeyHttpError(401,'Bearer API key required.','API_KEY_REQUIRED');
    if(parts[2]==='dashboard'&&parts.length===3&&req.method==='GET'){
      const key=resolveApiKey(store,token,{requiredScope:'read:dashboard'}),projects=await getProjects(root);
      const dashboard=await buildWorkspaceDashboard(root,{workspaceId:key.workspaceId,projects,alertLimit:Math.min(500,Math.max(1,Math.trunc(Number(url.searchParams.get('alertLimit')))||100))});
      return send(res,200,{apiKey:{id:key.id,name:key.name,workspaceId:key.workspaceId,scopes:key.scopes},dashboard:{...dashboard,alerts:decorateAlertsWithAcknowledgements(store,key.workspaceId,dashboard.alerts)}});
    }
    if(parts[2]==='projects'&&parts[3]&&parts[4]==='report'&&req.method==='GET'){
      const key=resolveApiKey(store,token,{requiredScope:'read:research'}),project=await getProject(root,parts[3]);
      if(!project||project.workspaceId!==key.workspaceId)throw new ApiKeyHttpError(404,'project not found','PROJECT_NOT_FOUND');
      const report=await latestProjectReport(root,project);
      if(url.searchParams.get('format')==='markdown')return send(res,200,report.markdown,'text/markdown; charset=utf-8');
      return send(res,200,{apiKey:{id:key.id,name:key.name,workspaceId:key.workspaceId,scopes:key.scopes},...report});
    }
    return false;
  }

  if(parts[0]!=='api'||parts[1]!=='workspaces'||!parts[2]||parts[3]!=='api-keys')return false;
  const workspaceId=parts[2],session=requireHostedSession(req,store);
  store.requireRole(session.user.id,workspaceId,['owner','admin']);

  if(parts.length===4&&req.method==='GET')return send(res,200,{scopes:apiKeyScopes,keys:listApiKeys(store,{workspaceId,userId:session.user.id})});
  if(parts.length===4&&req.method==='POST'){
    assertSameOrigin(req,env);const body=await readJson(req);
    const key=createApiKey(store,{workspaceId,userId:session.user.id,name:body.name,scopes:body.scopes,ttlSeconds:body.ttlSeconds});
    return send(res,201,{key,warning:'The raw API key token is shown only once. Store it in a secret manager.'});
  }
  if(parts[4]&&parts.length===5&&req.method==='DELETE'){
    assertSameOrigin(req,env);return send(res,200,{key:revokeApiKey(store,{workspaceId,userId:session.user.id,keyId:parts[4]})});
  }
  return false;
}
