import crypto from 'node:crypto';

const INVITABLE_ROLES=new Set(['admin','analyst','viewer']);
const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

function now(){return new Date().toISOString()}
function id(prefix){return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`}
function normalizeEmail(value){return String(value||'').trim().toLowerCase()}
function tokenHash(token){return crypto.createHash('sha256').update(String(token||'')).digest('hex')}

export class HostedMembersError extends Error{
  constructor(message,{code='HOSTED_MEMBERS_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

export function ensureHostedMembersSchema(store){
  if(!store?.db)throw new TypeError('HostedStore is required');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_invitations(
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      email TEXT NOT NULL,
      role TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      invited_by TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      accepted_at TEXT,
      accepted_by TEXT,
      revoked_at TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(invited_by) REFERENCES users(id) ON DELETE CASCADE,
      FOREIGN KEY(accepted_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_invitations_workspace ON workspace_invitations(workspace_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_workspace_invitations_email ON workspace_invitations(email,expires_at);
  `);
}

export function listWorkspaceMembers(store,actorUserId,workspaceId){
  store.requireRole(actorUserId,workspaceId,['owner','admin']);
  return store.db.prepare(`SELECT u.id,u.email,m.role,m.created_at AS createdAt
    FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=? ORDER BY m.created_at,u.email`).all(workspaceId);
}

export function createWorkspaceInvitation(store,{actorUserId,workspaceId,email,role='analyst',ttlSeconds=7*24*3600}={}){
  ensureHostedMembersSchema(store);
  store.requireRole(actorUserId,workspaceId,['owner','admin']);
  const normalized=normalizeEmail(email);
  if(!EMAIL_RE.test(normalized))throw new HostedMembersError('A valid invitation email is required.',{code:'INVALID_INVITE_EMAIL'});
  if(!INVITABLE_ROLES.has(role))throw new HostedMembersError('Invitation role must be admin, analyst, or viewer.',{code:'INVALID_INVITE_ROLE'});
  const existing=store.db.prepare(`SELECT 1 AS member FROM memberships m JOIN users u ON u.id=m.user_id
    WHERE m.workspace_id=? AND u.email=?`).get(workspaceId,normalized);
  if(existing)throw new HostedMembersError('This account is already a workspace member.',{code:'ALREADY_MEMBER',statusCode:409});
  const seconds=Math.max(300,Math.min(30*24*3600,Math.trunc(Number(ttlSeconds)||7*24*3600)));
  const token=crypto.randomBytes(32).toString('base64url');
  const timestamp=now(),expiresAt=new Date(Date.now()+seconds*1000).toISOString(),inviteId=id('inv');
  store.db.prepare(`INSERT INTO workspace_invitations(id,workspace_id,email,role,token_hash,invited_by,expires_at,created_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(inviteId,workspaceId,normalized,role,tokenHash(token),actorUserId,expiresAt,timestamp);
  store.audit({workspaceId,userId:actorUserId,action:'member.invite.create',targetType:'invitation',targetId:inviteId,metadata:{email:normalized,role,expiresAt}});
  return {id:inviteId,workspaceId,email:normalized,role,expiresAt,createdAt:timestamp,token};
}

export function listWorkspaceInvitations(store,actorUserId,workspaceId){
  ensureHostedMembersSchema(store);
  store.requireRole(actorUserId,workspaceId,['owner','admin']);
  const timestamp=now();
  return store.db.prepare(`SELECT id,email,role,invited_by AS invitedBy,expires_at AS expiresAt,accepted_at AS acceptedAt,
    accepted_by AS acceptedBy,revoked_at AS revokedAt,created_at AS createdAt
    FROM workspace_invitations WHERE workspace_id=? ORDER BY created_at DESC`).all(workspaceId).map(row=>({
      ...row,
      state:row.revokedAt?'revoked':row.acceptedAt?'accepted':row.expiresAt<=timestamp?'expired':'pending',
    }));
}

export function revokeWorkspaceInvitation(store,{actorUserId,workspaceId,invitationId}={}){
  ensureHostedMembersSchema(store);
  store.requireRole(actorUserId,workspaceId,['owner','admin']);
  const row=store.db.prepare('SELECT * FROM workspace_invitations WHERE id=? AND workspace_id=?').get(invitationId,workspaceId);
  if(!row)throw new HostedMembersError('Invitation not found.',{code:'INVITE_NOT_FOUND',statusCode:404});
  if(row.accepted_at)throw new HostedMembersError('Accepted invitation cannot be revoked.',{code:'INVITE_ALREADY_ACCEPTED',statusCode:409});
  if(!row.revoked_at)store.db.prepare('UPDATE workspace_invitations SET revoked_at=? WHERE id=?').run(now(),invitationId);
  store.audit({workspaceId,userId:actorUserId,action:'member.invite.revoke',targetType:'invitation',targetId:invitationId});
  return {ok:true};
}

export function acceptWorkspaceInvitation(store,{userId,userEmail,token}={}){
  ensureHostedMembersSchema(store);
  const normalized=normalizeEmail(userEmail);
  if(!userId||!token)throw new HostedMembersError('Authenticated user and invitation token are required.',{code:'INVITE_TOKEN_REQUIRED'});
  const timestamp=now(),hash=tokenHash(token);
  store.db.exec('BEGIN IMMEDIATE');
  let result;
  try{
    const row=store.db.prepare(`SELECT * FROM workspace_invitations WHERE token_hash=? AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at>?`).get(hash,timestamp);
    if(!row)throw new HostedMembersError('Invitation not found, expired, revoked, or already used.',{code:'INVITE_NOT_AVAILABLE',statusCode:404});
    if(row.email!==normalized)throw new HostedMembersError('Invitation email does not match the signed-in account.',{code:'INVITE_EMAIL_MISMATCH',statusCode:403});
    const existing=store.db.prepare('SELECT role FROM memberships WHERE workspace_id=? AND user_id=?').get(row.workspace_id,userId);
    if(!existing){
      store.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)').run(row.workspace_id,userId,row.role,timestamp);
    }
    store.db.prepare('UPDATE workspace_invitations SET accepted_at=?,accepted_by=? WHERE id=?').run(timestamp,userId,row.id);
    store.db.exec('COMMIT');
    result={workspaceId:row.workspace_id,role:existing?.role||row.role,invitationId:row.id};
  }catch(error){try{store.db.exec('ROLLBACK')}catch{}throw error}
  store.audit({workspaceId:result.workspaceId,userId,action:'member.invite.accept',targetType:'invitation',targetId:result.invitationId,metadata:{role:result.role}});
  return result;
}

export const hostedMemberRoles=Object.freeze({invitable:[...INVITABLE_ROLES]});
