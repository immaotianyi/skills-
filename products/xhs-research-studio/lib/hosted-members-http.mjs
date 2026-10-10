import { assertSameOrigin, requireHostedSession } from './hosted-http.mjs';
import {
  createWorkspaceInvitation,
  acceptWorkspaceInvitation,
  listWorkspaceMembers,
  listWorkspaceInvitations,
  revokeWorkspaceInvitation,
} from './hosted-members.mjs';
import { getWorkspaceBranding, updateWorkspaceBranding } from './branding.mjs';
import { createSavedTemplate, deleteSavedTemplate, listSavedTemplates } from './saved-templates.mjs';

function origin(req,env=process.env){
  const configured=String(env.XHS_STUDIO_PUBLIC_URL||'').trim().replace(/\/$/u,'');
  if(configured)return configured;
  const proto=String(req.headers['x-forwarded-proto']||'http').split(',')[0].trim();
  return `${proto}://${req.headers.host||'localhost'}`;
}

export async function handleHostedMembersApi({req,res,url,store,readJson,send,env=process.env}){
  const parts=url.pathname.split('/').filter(Boolean);

  if(url.pathname==='/api/invitations/accept'&&req.method==='POST'){
    assertSameOrigin(req,env);
    const session=requireHostedSession(req,store);
    const body=await readJson(req);
    const membership=acceptWorkspaceInvitation(store,{userId:session.user.id,userEmail:session.user.email,token:body.token});
    return send(res,200,{membership});
  }

  if(parts[0]!=='api'||parts[1]!=='workspaces'||!parts[2])return false;
  const workspaceId=parts[2];
  const session=requireHostedSession(req,store);

  if(parts[3]==='templates'&&parts.length===4&&req.method==='GET'){
    return send(res,200,{templates:listSavedTemplates(store,{actorUserId:session.user.id,workspaceId})});
  }
  if(parts[3]==='templates'&&parts.length===4&&req.method==='POST'){
    assertSameOrigin(req,env);
    const body=await readJson(req);
    const template=createSavedTemplate(store,{actorUserId:session.user.id,workspaceId,input:body});
    return send(res,201,{template});
  }
  if(parts[3]==='templates'&&parts[4]&&parts.length===5&&req.method==='DELETE'){
    assertSameOrigin(req,env);
    deleteSavedTemplate(store,{actorUserId:session.user.id,workspaceId,templateId:parts[4]});
    return send(res,200,{ok:true,id:parts[4]});
  }

  if(parts[3]==='branding'&&parts.length===4&&req.method==='GET'){
    store.requireRole(session.user.id,workspaceId);
    return send(res,200,{branding:getWorkspaceBranding(store,workspaceId)});
  }
  if(parts[3]==='branding'&&parts.length===4&&req.method==='PATCH'){
    assertSameOrigin(req,env);
    const body=await readJson(req);
    const branding=updateWorkspaceBranding(store,{actorUserId:session.user.id,workspaceId,input:body});
    return send(res,200,{branding});
  }

  if(parts[3]==='members'&&parts.length===4&&req.method==='GET'){
    return send(res,200,{members:listWorkspaceMembers(store,session.user.id,workspaceId)});
  }
  if(parts[3]==='members'&&parts[4]&&parts.length===5&&req.method==='PATCH'){
    assertSameOrigin(req,env);
    const body=await readJson(req),role=String(body.role||'');
    if(role==='owner'){
      const error=new Error('Workspace ownership cannot be granted through the generic member-role endpoint.');
      error.code='OWNER_TRANSFER_REQUIRED';error.statusCode=409;throw error;
    }
    store.setMemberRole(session.user.id,workspaceId,parts[4],role);
    return send(res,200,{member:store.membership(parts[4],workspaceId)});
  }

  if(parts[3]==='invitations'&&parts.length===4&&req.method==='GET'){
    return send(res,200,{invitations:listWorkspaceInvitations(store,session.user.id,workspaceId)});
  }
  if(parts[3]==='invitations'&&parts.length===4&&req.method==='POST'){
    assertSameOrigin(req,env);
    const body=await readJson(req);
    const invite=createWorkspaceInvitation(store,{
      actorUserId:session.user.id,
      workspaceId,
      email:body.email,
      role:body.role,
      ttlSeconds:body.ttlSeconds,
    });
    return send(res,201,{invitation:{
      id:invite.id,email:invite.email,role:invite.role,expiresAt:invite.expiresAt,
      url:`${origin(req,env)}/?invite=${encodeURIComponent(invite.token)}`,
    }});
  }
  if(parts[3]==='invitations'&&parts[4]&&parts[5]==='revoke'&&req.method==='POST'){
    assertSameOrigin(req,env);
    revokeWorkspaceInvitation(store,{actorUserId:session.user.id,workspaceId,invitationId:parts[4]});
    return send(res,200,{ok:true});
  }
  return false;
}
