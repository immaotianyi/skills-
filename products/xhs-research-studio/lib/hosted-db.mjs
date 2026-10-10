import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import path from 'node:path';
import { mkdirSync } from 'node:fs';

const EMAIL_RE=/^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
const ROLES=new Set(['owner','admin','analyst','viewer']);
const ACTIVE_STATUSES=new Set(['active','trialing']);

function id(prefix){return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`}
function now(){return new Date().toISOString()}
function monthKey(date=new Date()){return date.toISOString().slice(0,7)}
function normalizeEmail(value){return String(value||'').trim().toLowerCase()}
function tokenHash(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
function hashPassword(password,salt=crypto.randomBytes(16)){
  const value=String(password||'');
  if(value.length<12||value.length>512)throw new Error('Password must be between 12 and 512 characters.');
  const derived=crypto.scryptSync(value,salt,64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
  return {salt:salt.toString('base64'),hash:derived.toString('base64')};
}
function verifyPassword(password,salt,expected){
  try{
    const derived=crypto.scryptSync(String(password||''),Buffer.from(salt,'base64'),64,{N:16384,r:8,p:1,maxmem:64*1024*1024});
    const actual=Buffer.from(expected,'base64');
    return actual.length===derived.length&&crypto.timingSafeEqual(actual,derived);
  }catch{return false}
}
function parseJson(value,fallback={}){try{return JSON.parse(value)}catch{return fallback}}
function cleanName(value,fallback='Workspace'){return String(value||fallback).trim().slice(0,120)||fallback}
function defaultEntitlement(){return {plan:'unpaid',status:'inactive',maxProjects:0,maxRunsMonth:0,maxNotesRun:0,maxCommentsRun:0}}

export class HostedStoreError extends Error{
  constructor(message,{code='HOSTED_STORE_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

export class HostedStore{
  constructor(dataDir,{sessionTtlSeconds=30*24*3600}={}){
    mkdirSync(dataDir,{recursive:true});
    this.db=new DatabaseSync(path.join(dataDir,'hosted.sqlite'));
    this.sessionTtlSeconds=Math.max(3600,Math.min(365*24*3600,Number(sessionTtlSeconds)||30*24*3600));
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA busy_timeout=5000;');
    this.#migrate();
  }
  close(){this.db.close()}
  #migrate(){
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosted_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users(
        id TEXT PRIMARY KEY,email TEXT NOT NULL UNIQUE,password_salt TEXT NOT NULL,password_hash TEXT NOT NULL,
        disabled INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions(
        id TEXT PRIMARY KEY,user_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL,last_seen_at TEXT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
      CREATE INDEX IF NOT EXISTS idx_sessions_expiry ON sessions(expires_at);
      CREATE TABLE IF NOT EXISTS workspaces(
        id TEXT PRIMARY KEY,name TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memberships(
        workspace_id TEXT NOT NULL,user_id TEXT NOT NULL,role TEXT NOT NULL,created_at TEXT NOT NULL,
        PRIMARY KEY(workspace_id,user_id),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(user_id) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS entitlements(
        workspace_id TEXT PRIMARY KEY,plan TEXT NOT NULL,status TEXT NOT NULL,
        provider_customer_id TEXT,provider_subscription_id TEXT,current_period_end TEXT,
        max_projects INTEGER NOT NULL,max_runs_month INTEGER NOT NULL,max_notes_run INTEGER NOT NULL,max_comments_run INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS usage_monthly(
        workspace_id TEXT NOT NULL,month TEXT NOT NULL,runs INTEGER NOT NULL DEFAULT 0,notes INTEGER NOT NULL DEFAULT 0,comments INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,PRIMARY KEY(workspace_id,month),
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
      );
      CREATE TABLE IF NOT EXISTS share_links(
        id TEXT PRIMARY KEY,workspace_id TEXT NOT NULL,project_id TEXT NOT NULL,token_hash TEXT NOT NULL UNIQUE,
        created_by TEXT NOT NULL,expires_at TEXT,revoked_at TEXT,created_at TEXT NOT NULL,
        FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
        FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_share_token ON share_links(token_hash);
      CREATE TABLE IF NOT EXISTS audit_events(
        id TEXT PRIMARY KEY,workspace_id TEXT,user_id TEXT,action TEXT NOT NULL,target_type TEXT,target_id TEXT,
        metadata_json TEXT NOT NULL,created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_audit_workspace_time ON audit_events(workspace_id,created_at DESC);
      CREATE TABLE IF NOT EXISTS billing_events(
        provider_event_id TEXT PRIMARY KEY,type TEXT NOT NULL,payload_hash TEXT NOT NULL,processed_at TEXT NOT NULL
      );
    `);
  }
  #tx(fn){
    this.db.exec('BEGIN IMMEDIATE');
    try{const value=fn();this.db.exec('COMMIT');return value}catch(error){try{this.db.exec('ROLLBACK')}catch{}throw error}
  }
  register({email,password,workspaceName=''}){
    const normalized=normalizeEmail(email);
    if(!EMAIL_RE.test(normalized))throw new HostedStoreError('A valid email address is required.',{code:'INVALID_EMAIL'});
    const passwordData=hashPassword(password);
    const userId=id('usr'),workspaceId=id('wsp'),timestamp=now();
    try{
      this.#tx(()=>{
        this.db.prepare('INSERT INTO users(id,email,password_salt,password_hash,created_at,updated_at) VALUES(?,?,?,?,?,?)')
          .run(userId,normalized,passwordData.salt,passwordData.hash,timestamp,timestamp);
        this.db.prepare('INSERT INTO workspaces(id,name,created_at,updated_at) VALUES(?,?,?,?)')
          .run(workspaceId,cleanName(workspaceName,normalized.split('@')[0]),timestamp,timestamp);
        this.db.prepare('INSERT INTO memberships(workspace_id,user_id,role,created_at) VALUES(?,?,?,?)')
          .run(workspaceId,userId,'owner',timestamp);
        const ent=defaultEntitlement();
        this.db.prepare(`INSERT INTO entitlements(workspace_id,plan,status,max_projects,max_runs_month,max_notes_run,max_comments_run,updated_at)
          VALUES(?,?,?,?,?,?,?,?)`).run(workspaceId,ent.plan,ent.status,ent.maxProjects,ent.maxRunsMonth,ent.maxNotesRun,ent.maxCommentsRun,timestamp);
      });
    }catch(error){
      if(String(error.message).includes('UNIQUE constraint failed: users.email'))throw new HostedStoreError('An account with this email already exists.',{code:'EMAIL_EXISTS',statusCode:409});
      throw error;
    }
    this.audit({workspaceId,userId,action:'auth.register',targetType:'workspace',targetId:workspaceId,metadata:{email:normalized}});
    return {user:{id:userId,email:normalized},workspace:{id:workspaceId,name:cleanName(workspaceName,normalized.split('@')[0]),role:'owner'}};
  }
  authenticate(email,password){
    const normalized=normalizeEmail(email);
    const row=this.db.prepare('SELECT * FROM users WHERE email=?').get(normalized);
    if(!row||row.disabled||!verifyPassword(password,row.password_salt,row.password_hash))return null;
    return {id:row.id,email:row.email};
  }
  createSession(userId,{ttlSeconds=this.sessionTtlSeconds}={}){
    const token=crypto.randomBytes(32).toString('base64url');
    const timestamp=now();
    const expiresAt=new Date(Date.now()+Math.max(3600,Number(ttlSeconds)||this.sessionTtlSeconds)*1000).toISOString();
    const session={id:id('ses'),userId,expiresAt,createdAt:timestamp};
    this.db.prepare('INSERT INTO sessions(id,user_id,token_hash,expires_at,created_at,last_seen_at) VALUES(?,?,?,?,?,?)')
      .run(session.id,userId,tokenHash(token),expiresAt,timestamp,timestamp);
    return {...session,token};
  }
  resolveSession(token){
    if(!token)return null;
    const timestamp=now();
    this.db.prepare('DELETE FROM sessions WHERE expires_at<=?').run(timestamp);
    const row=this.db.prepare(`SELECT s.id AS session_id,s.user_id,s.expires_at,u.email,u.disabled
      FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=? AND s.expires_at>?`).get(tokenHash(token),timestamp);
    if(!row||row.disabled)return null;
    this.db.prepare('UPDATE sessions SET last_seen_at=? WHERE id=?').run(timestamp,row.session_id);
    return {sessionId:row.session_id,user:{id:row.user_id,email:row.email},expiresAt:row.expires_at};
  }
  revokeSession(token){if(token)this.db.prepare('DELETE FROM sessions WHERE token_hash=?').run(tokenHash(token))}
  memberships(userId){
    return this.db.prepare(`SELECT w.id,w.name,m.role,w.created_at AS createdAt
      FROM memberships m JOIN workspaces w ON w.id=m.workspace_id WHERE m.user_id=? ORDER BY w.created_at`).all(userId);
  }
  membership(userId,workspaceId){
    const row=this.db.prepare(`SELECT w.id,w.name,m.role FROM memberships m JOIN workspaces w ON w.id=m.workspace_id
      WHERE m.user_id=? AND m.workspace_id=?`).get(userId,workspaceId);
    return row?{id:row.id,name:row.name,role:row.role}:null;
  }
  requireRole(userId,workspaceId,allowed=['owner','admin','analyst','viewer']){
    const member=this.membership(userId,workspaceId);
    if(!member)throw new HostedStoreError('Workspace access denied.',{code:'WORKSPACE_FORBIDDEN',statusCode:403});
    if(!allowed.includes(member.role))throw new HostedStoreError('This workspace role cannot perform that action.',{code:'ROLE_FORBIDDEN',statusCode:403});
    return member;
  }
  setMemberRole(actorUserId,workspaceId,targetUserId,role){
    if(!ROLES.has(role))throw new HostedStoreError('Invalid workspace role.',{code:'INVALID_ROLE'});
    this.requireRole(actorUserId,workspaceId,['owner','admin']);
    const target=this.membership(targetUserId,workspaceId);
    if(!target)throw new HostedStoreError('Workspace member not found.',{code:'MEMBER_NOT_FOUND',statusCode:404});
    if(target.role==='owner'&&role!=='owner')throw new HostedStoreError('Workspace owner role cannot be removed through this endpoint.',{code:'OWNER_PROTECTED',statusCode:409});
    this.db.prepare('UPDATE memberships SET role=? WHERE workspace_id=? AND user_id=?').run(role,workspaceId,targetUserId);
    this.audit({workspaceId,userId:actorUserId,action:'member.role.update',targetType:'user',targetId:targetUserId,metadata:{role}});
  }
  getEntitlement(workspaceId){
    const row=this.db.prepare('SELECT * FROM entitlements WHERE workspace_id=?').get(workspaceId);
    if(!row)return defaultEntitlement();
    return {workspaceId,plan:row.plan,status:row.status,providerCustomerId:row.provider_customer_id||null,providerSubscriptionId:row.provider_subscription_id||null,currentPeriodEnd:row.current_period_end||null,maxProjects:row.max_projects,maxRunsMonth:row.max_runs_month,maxNotesRun:row.max_notes_run,maxCommentsRun:row.max_comments_run,updatedAt:row.updated_at};
  }
  setEntitlement(workspaceId,input={}){
    const current=this.getEntitlement(workspaceId),timestamp=now();
    const next={
      plan:String(input.plan??current.plan).slice(0,80),status:String(input.status??current.status).slice(0,40),
      providerCustomerId:input.providerCustomerId??current.providerCustomerId,providerSubscriptionId:input.providerSubscriptionId??current.providerSubscriptionId,
      currentPeriodEnd:input.currentPeriodEnd??current.currentPeriodEnd,
      maxProjects:Math.max(0,Math.trunc(Number(input.maxProjects??current.maxProjects)||0)),
      maxRunsMonth:Math.max(0,Math.trunc(Number(input.maxRunsMonth??current.maxRunsMonth)||0)),
      maxNotesRun:Math.max(0,Math.trunc(Number(input.maxNotesRun??current.maxNotesRun)||0)),
      maxCommentsRun:Math.max(0,Math.trunc(Number(input.maxCommentsRun??current.maxCommentsRun)||0)),
    };
    this.db.prepare(`INSERT INTO entitlements(workspace_id,plan,status,provider_customer_id,provider_subscription_id,current_period_end,max_projects,max_runs_month,max_notes_run,max_comments_run,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET plan=excluded.plan,status=excluded.status,
      provider_customer_id=excluded.provider_customer_id,provider_subscription_id=excluded.provider_subscription_id,current_period_end=excluded.current_period_end,
      max_projects=excluded.max_projects,max_runs_month=excluded.max_runs_month,max_notes_run=excluded.max_notes_run,max_comments_run=excluded.max_comments_run,updated_at=excluded.updated_at`)
      .run(workspaceId,next.plan,next.status,next.providerCustomerId,next.providerSubscriptionId,next.currentPeriodEnd,next.maxProjects,next.maxRunsMonth,next.maxNotesRun,next.maxCommentsRun,timestamp);
    return this.getEntitlement(workspaceId);
  }
  usage(workspaceId,month=monthKey()){
    const row=this.db.prepare('SELECT * FROM usage_monthly WHERE workspace_id=? AND month=?').get(workspaceId,month);
    return {workspaceId,month,runs:row?.runs||0,notes:row?.notes||0,comments:row?.comments||0};
  }
  assertProjectCreation(workspaceId,currentProjectCount){
    const ent=this.getEntitlement(workspaceId);
    if(!ACTIVE_STATUSES.has(ent.status))throw new HostedStoreError('An active paid or trial entitlement is required.',{code:'ENTITLEMENT_REQUIRED',statusCode:402});
    if(currentProjectCount>=ent.maxProjects)throw new HostedStoreError('Workspace project limit reached.',{code:'PROJECT_LIMIT',statusCode:402});
    return ent;
  }
  reserveRun(workspaceId,budget={}){
    return this.#tx(()=>{
      const ent=this.getEntitlement(workspaceId);
      if(!ACTIVE_STATUSES.has(ent.status))throw new HostedStoreError('An active paid or trial entitlement is required.',{code:'ENTITLEMENT_REQUIRED',statusCode:402});
      if(Number(budget.maxNotes||0)>ent.maxNotesRun||Number(budget.maxComments||0)>ent.maxCommentsRun){
        throw new HostedStoreError('Requested run budget exceeds workspace plan limits.',{code:'RUN_BUDGET_PLAN_LIMIT',statusCode:402});
      }
      const month=monthKey(),usage=this.usage(workspaceId,month);
      if(usage.runs>=ent.maxRunsMonth)throw new HostedStoreError('Monthly run limit reached.',{code:'MONTHLY_RUN_LIMIT',statusCode:402});
      const timestamp=now();
      this.db.prepare(`INSERT INTO usage_monthly(workspace_id,month,runs,notes,comments,updated_at) VALUES(?,?,1,0,0,?)
        ON CONFLICT(workspace_id,month) DO UPDATE SET runs=runs+1,updated_at=excluded.updated_at`).run(workspaceId,month,timestamp);
      return {...usage,runs:usage.runs+1};
    });
  }
  recordRunUsage(workspaceId,{notes=0,comments=0}={}){
    const month=monthKey(),timestamp=now();
    this.db.prepare(`INSERT INTO usage_monthly(workspace_id,month,runs,notes,comments,updated_at) VALUES(?,?,0,?,?,?)
      ON CONFLICT(workspace_id,month) DO UPDATE SET notes=notes+excluded.notes,comments=comments+excluded.comments,updated_at=excluded.updated_at`)
      .run(workspaceId,month,Math.max(0,Math.trunc(Number(notes)||0)),Math.max(0,Math.trunc(Number(comments)||0)),timestamp);
    return this.usage(workspaceId,month);
  }
  createShare({workspaceId,projectId,userId,ttlSeconds=7*24*3600}){
    this.requireRole(userId,workspaceId,['owner','admin','analyst']);
    const token=crypto.randomBytes(32).toString('base64url'),timestamp=now();
    const expiresAt=ttlSeconds?new Date(Date.now()+Math.max(300,Number(ttlSeconds))*1000).toISOString():null;
    const row={id:id('shr'),workspaceId,projectId,createdBy:userId,expiresAt,createdAt:timestamp};
    this.db.prepare('INSERT INTO share_links(id,workspace_id,project_id,token_hash,created_by,expires_at,created_at) VALUES(?,?,?,?,?,?,?)')
      .run(row.id,workspaceId,projectId,tokenHash(token),userId,expiresAt,timestamp);
    this.audit({workspaceId,userId,action:'share.create',targetType:'project',targetId:projectId,metadata:{shareId:row.id,expiresAt}});
    return {...row,token};
  }
  resolveShare(token){
    const timestamp=now();
    const row=this.db.prepare(`SELECT * FROM share_links WHERE token_hash=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`).get(tokenHash(token),timestamp);
    return row?{id:row.id,workspaceId:row.workspace_id,projectId:row.project_id,expiresAt:row.expires_at,createdAt:row.created_at}:null;
  }
  revokeShare(workspaceId,shareId,userId){
    this.requireRole(userId,workspaceId,['owner','admin','analyst']);
    this.db.prepare('UPDATE share_links SET revoked_at=? WHERE id=? AND workspace_id=?').run(now(),shareId,workspaceId);
    this.audit({workspaceId,userId,action:'share.revoke',targetType:'share',targetId:shareId});
  }
  audit({workspaceId=null,userId=null,action,targetType=null,targetId=null,metadata={}}){
    this.db.prepare('INSERT INTO audit_events(id,workspace_id,user_id,action,target_type,target_id,metadata_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(id('aud'),workspaceId,userId,String(action).slice(0,120),targetType,targetId,JSON.stringify(metadata||{}).slice(0,20_000),now());
  }
  auditLog(workspaceId,{limit=100}={}){
    const rows=this.db.prepare('SELECT * FROM audit_events WHERE workspace_id=? ORDER BY created_at DESC LIMIT ?').all(workspaceId,Math.max(1,Math.min(500,Math.trunc(limit)||100)));
    return rows.map(row=>({id:row.id,userId:row.user_id,action:row.action,targetType:row.target_type,targetId:row.target_id,metadata:parseJson(row.metadata_json,{}),createdAt:row.created_at}));
  }
  recordBillingEvent(providerEventId,type,payloadHash){
    try{this.db.prepare('INSERT INTO billing_events(provider_event_id,type,payload_hash,processed_at) VALUES(?,?,?,?)').run(providerEventId,type,payloadHash,now());return true}
    catch(error){if(String(error.message).includes('UNIQUE constraint failed: billing_events.provider_event_id'))return false;throw error}
  }
}

export function hostedModeEnabled(){return ['1','true','yes'].includes(String(process.env.XHS_STUDIO_HOSTED||'').toLowerCase())}
