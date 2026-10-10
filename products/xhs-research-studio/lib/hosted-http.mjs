import { publicBillingPlans, createStripeCheckoutSession, createStripePortalSession, verifyStripeWebhook, applyStripeEvent } from './billing.mjs';
import { assertLoginAllowed, recordLoginFailure, recordLoginSuccess, assertRegistrationAllowed, recordRegistrationAttempt, requestClientIp } from './auth-security.mjs';
import { getWorkspaceBranding } from './branding.mjs';

const COOKIE='xhs_studio_session';
const DEFAULT_SHARE_TTL_SECONDS=7*24*3600;
const MAX_SHARE_TTL_SECONDS=30*24*3600;
const SHARE_NO_STORE_HEADERS=Object.freeze({'cache-control':'private, no-store, max-age=0','pragma':'no-cache','x-content-type-options':'nosniff'});
const SAFE_HEX_RE=/^#[0-9a-f]{6}$/iu;

export class HostedHttpError extends Error{
  constructor(statusCode,message,code='HOSTED_HTTP_ERROR'){super(message);this.statusCode=statusCode;this.code=code}
}

function cookies(req){const out={};for(const part of String(req.headers.cookie||'').split(';')){const i=part.indexOf('=');if(i<0)continue;try{out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}catch{}}return out}
function bearer(req){const h=String(req.headers.authorization||'');return /^Bearer\s+/iu.test(h)?h.replace(/^Bearer\s+/iu,'').trim():''}
export function sessionToken(req){return bearer(req)||cookies(req)[COOKIE]||''}
export function requireHostedSession(req,store){const token=sessionToken(req),session=store.resolveSession(token);if(!session)throw new HostedHttpError(401,'Authentication required.','AUTH_REQUIRED');return {...session,token}}
function requestOrigin(req){const proto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();return `${proto}://${req.headers.host||'localhost'}`}
function configuredOrigin(req,env){const raw=String(env.XHS_STUDIO_PUBLIC_URL||'').trim();try{return new URL(raw||requestOrigin(req)).origin}catch{return requestOrigin(req)}}
export function assertSameOrigin(req,env=process.env){const origin=String(req.headers.origin||'').trim();if(origin&&origin!==configuredOrigin(req,env))throw new HostedHttpError(403,'Cross-origin state-changing request rejected.','ORIGIN_FORBIDDEN')}
function sessionCookie(req,token,expiresAt,env){const maxAge=Math.max(0,Math.floor((Date.parse(expiresAt)-Date.now())/1000)),secure=configuredOrigin(req,env).startsWith('https:')?'; Secure':'';return `${COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`}
function expiredCookie(req,env){const secure=configuredOrigin(req,env).startsWith('https:')?'; Secure':'';return `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`}
function boundedShareTtl(value){const n=Math.trunc(Number(value));if(!Number.isFinite(n)||n<=0)return DEFAULT_SHARE_TTL_SECONDS;return Math.max(300,Math.min(MAX_SHARE_TTL_SECONDS,n))}

export function resolveWorkspace(req,store,session,{roles=['owner','admin','analyst','viewer']}={}){
  const memberships=store.memberships(session.user.id),requested=String(req.headers['x-xhs-workspace-id']||'').trim(),workspaceId=requested||(memberships.length===1?memberships[0].id:'');
  if(!workspaceId)throw new HostedHttpError(400,'X-XHS-Workspace-Id is required when the account belongs to multiple workspaces.','WORKSPACE_REQUIRED');
  const workspace=store.requireRole(session.user.id,workspaceId,roles);return {session,workspace,memberships};
}
export function requireProjectWorkspace(req,store,project,{write=false,admin=false}={}){
  const session=requireHostedSession(req,store),roles=admin?['owner','admin']:write?['owner','admin','analyst']:['owner','admin','analyst','viewer'],context=resolveWorkspace(req,store,session,{roles});
  if(!project?.workspaceId||project.workspaceId!==context.workspace.id)throw new HostedHttpError(404,'project not found','PROJECT_NOT_FOUND');return context;
}
function mePayload(store,session){return {user:session.user,session:{expiresAt:session.expiresAt},workspaces:store.memberships(session.user.id).map(workspace=>({...workspace,entitlement:store.getEntitlement(workspace.id),usage:store.usage(workspace.id)}))}}
function optionalSessionPayload(req,store){const token=sessionToken(req);if(!token)return null;const session=store.resolveSession(token);return session?mePayload(store,session):null}
function escapeHtml(value){return String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]))}
function sharedHtml(shared,branding={}){
  const accent=SAFE_HEX_RE.test(String(branding?.accentColor||''))?String(branding.accentColor).toLowerCase():'#171717';
  const projectName=escapeHtml(shared.project?.name||'Shared Research Report');
  const reportTitle=escapeHtml(branding?.reportTitle||shared.project?.name||'Shared Research Report');
  const agencyName=escapeHtml(branding?.agencyName||'');
  const footerText=escapeHtml(branding?.footerText||'');
  const markdown=escapeHtml(shared.markdown||'No report is available.');
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${reportTitle}</title><style>:root{--accent:${accent}}body{font:16px/1.6 system-ui;margin:0;background:#f6f6f4;color:#171717}main{max-width:960px;margin:auto;padding:40px 24px}header{border-top:4px solid var(--accent);margin-bottom:18px}header small{letter-spacing:.08em;text-transform:uppercase}header h1{margin:.25rem 0;color:var(--accent)}header p{margin:.25rem 0;color:#555}article{background:white;border:1px solid #ddd;border-radius:14px;padding:28px}pre{white-space:pre-wrap;word-break:break-word;font:inherit}footer{margin-top:18px;color:#666;font-size:13px}</style></head><body><main><header>${agencyName?`<small>${agencyName}</small>`:''}<h1>${reportTitle}</h1><p>${projectName}</p></header><article><pre>${markdown}</pre></article>${footerText?`<footer>${footerText}</footer>`:''}</main></body></html>`;
}

export async function handlePublicShare({req,res,url,store,send,loadSharedReport}){
  const match=url.pathname.match(/^\/share\/([A-Za-z0-9_-]{20,})$/u),apiMatch=url.pathname.match(/^\/api\/shared\/([A-Za-z0-9_-]{20,})$/u),token=(match||apiMatch)?.[1];
  if(!token||req.method!=='GET')return false;
  const share=store.resolveShare(token);if(!share)throw new HostedHttpError(404,'Shared report not found or expired.','SHARE_NOT_FOUND');
  const shared=await loadSharedReport(share);if(!shared)throw new HostedHttpError(404,'Shared report not found.','SHARE_NOT_FOUND');
  const branding=getWorkspaceBranding(store,share.workspaceId);
  if(apiMatch){send(res,200,{share:{id:share.id,expiresAt:share.expiresAt},branding,...shared},'application/json; charset=utf-8',SHARE_NO_STORE_HEADERS);return true}
  send(res,200,sharedHtml(shared,branding),'text/html; charset=utf-8',{...SHARE_NO_STORE_HEADERS,'content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",'x-robots-tag':'noindex, nofollow'});return true;
}

export async function handleHostedApi({req,res,url,store,readJson,readRaw,send,getProject,getProjects,env=process.env}){
  const parts=url.pathname.split('/').filter(Boolean);
  if(url.pathname==='/api/hosted/status'&&req.method==='GET')return send(res,200,{hosted:true,session:optionalSessionPayload(req,store),billing:{provider:'stripe',plans:publicBillingPlans(env),configured:Boolean(env.XHS_STUDIO_STRIPE_SECRET_KEY&&env.XHS_STUDIO_STRIPE_WEBHOOK_SECRET)}});
  if(url.pathname==='/api/auth/register'&&req.method==='POST'){
    assertSameOrigin(req,env);const ip=requestClientIp(req,env);assertRegistrationAllowed(store,{ip});recordRegistrationAttempt(store,{ip});
    const body=await readJson(req),created=store.register({email:body.email,password:body.password,workspaceName:body.workspaceName}),session=store.createSession(created.user.id);
    return send(res,201,{...created,...mePayload(store,{user:created.user,expiresAt:session.expiresAt})},'application/json; charset=utf-8',{'set-cookie':sessionCookie(req,session.token,session.expiresAt,env)});
  }
  if(url.pathname==='/api/auth/login'&&req.method==='POST'){
    assertSameOrigin(req,env);const body=await readJson(req),ip=requestClientIp(req,env);assertLoginAllowed(store,{email:body.email,ip});const user=store.authenticate(body.email,body.password);
    if(!user){recordLoginFailure(store,{email:body.email,ip});assertLoginAllowed(store,{email:body.email,ip});throw new HostedHttpError(401,'Invalid email or password.','AUTH_INVALID')}
    recordLoginSuccess(store,{email:body.email,ip});const session=store.createSession(user.id);store.audit({userId:user.id,action:'auth.login',metadata:{}});return send(res,200,mePayload(store,{user,expiresAt:session.expiresAt}),'application/json; charset=utf-8',{'set-cookie':sessionCookie(req,session.token,session.expiresAt,env)});
  }
  if(url.pathname==='/api/auth/logout'&&req.method==='POST'){
    assertSameOrigin(req,env);const session=requireHostedSession(req,store);store.revokeSession(session.token);return send(res,200,{ok:true},'application/json; charset=utf-8',{'set-cookie':expiredCookie(req,env)});
  }
  if(url.pathname==='/api/me'&&req.method==='GET')return send(res,200,mePayload(store,requireHostedSession(req,store)));
  if(url.pathname==='/api/billing/webhook'&&req.method==='POST'){
    const secret=String(env.XHS_STUDIO_STRIPE_WEBHOOK_SECRET||'').trim();if(!secret)throw new HostedHttpError(503,'Stripe webhook secret is not configured.','BILLING_NOT_CONFIGURED');
    const raw=await readRaw(req),event=verifyStripeWebhook(raw,req.headers['stripe-signature'],secret),result=applyStripeEvent(store,event,{rawBody:raw,env});return send(res,200,{received:true,applied:result.applied,duplicate:result.duplicate});
  }

  if(parts[0]==='api'&&parts[1]==='workspaces'&&parts[2]){
    const session=requireHostedSession(req,store),workspaceId=parts[2];
    if(parts.length===3&&req.method==='GET'){const workspace=store.requireRole(session.user.id,workspaceId);return send(res,200,{workspace,entitlement:store.getEntitlement(workspaceId),usage:store.usage(workspaceId)})}
    if(parts[3]==='billing'&&parts[4]==='checkout'&&req.method==='POST'){
      assertSameOrigin(req,env);const workspace=store.requireRole(session.user.id,workspaceId,['owner','admin']),body=await readJson(req),entitlement=store.getEntitlement(workspaceId);
      const checkout=await createStripeCheckoutSession({workspace,user:session.user,planId:body.plan,entitlement,env});
      store.audit({workspaceId,userId:session.user.id,action:'billing.checkout.create',targetType:'workspace',targetId:workspaceId,metadata:{plan:checkout.plan.id,sessionId:checkout.id}});return send(res,201,checkout);
    }
    if(parts[3]==='billing'&&parts[4]==='portal'&&req.method==='POST'){
      assertSameOrigin(req,env);const workspace=store.requireRole(session.user.id,workspaceId,['owner','admin']),entitlement=store.getEntitlement(workspaceId),portal=await createStripePortalSession({workspace,entitlement,env});
      store.audit({workspaceId,userId:session.user.id,action:'billing.portal.create',targetType:'workspace',targetId:workspaceId,metadata:{sessionId:portal.id}});return send(res,201,portal);
    }
    if(parts[3]==='usage'&&req.method==='GET'){store.requireRole(session.user.id,workspaceId);return send(res,200,{entitlement:store.getEntitlement(workspaceId),usage:store.usage(workspaceId)})}
    if(parts[3]==='audit'&&req.method==='GET'){store.requireRole(session.user.id,workspaceId,['owner','admin']);return send(res,200,{events:store.auditLog(workspaceId,{limit:Number(url.searchParams.get('limit'))||100})})}
    if(parts[3]==='shares'&&parts.length===4&&req.method==='POST'){
      assertSameOrigin(req,env);store.requireRole(session.user.id,workspaceId,['owner','admin','analyst']);const body=await readJson(req),project=await getProject(body.projectId);
      if(!project||project.workspaceId!==workspaceId)throw new HostedHttpError(404,'project not found','PROJECT_NOT_FOUND');
      const share=store.createShare({workspaceId,projectId:project.id,userId:session.user.id,ttlSeconds:boundedShareTtl(body.ttlSeconds)});return send(res,201,{share:{id:share.id,projectId:share.projectId,expiresAt:share.expiresAt,url:`${configuredOrigin(req,env)}/share/${share.token}`}});
    }
    if(parts[3]==='shares'&&parts[4]&&parts[5]==='revoke'&&req.method==='POST'){assertSameOrigin(req,env);store.revokeShare(workspaceId,parts[4],session.user.id);return send(res,200,{ok:true})}
  }
  return false;
}

export function workspaceProjects(projects,workspaceId){return (projects||[]).filter(project=>project.workspaceId===workspaceId)}
export function hostedProjectCount(projects,workspaceId){return workspaceProjects(projects,workspaceId).length}