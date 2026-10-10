import crypto from 'node:crypto';

const SCOPES=new Set(['read:dashboard','read:research','write:runs','write:shares','write:webhooks']);
const ACTIVE_ENTITLEMENTS=new Set(['active','trialing']);
const TOKEN_PREFIX='xhs_sk_';
const MAX_TTL_SECONDS=365*24*3600;
const DEFAULT_TTL_SECONDS=90*24*3600;

export class ApiKeyError extends Error{
  constructor(message,{code='API_KEY_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

function hashToken(token){return crypto.createHash('sha256').update(String(token)).digest('hex')}
function id(){return `key_${Date.now().toString(36)}_${crypto.randomBytes(5).toString('hex')}`}
function normalizeScopes(scopes){
  const clean=[...new Set((Array.isArray(scopes)?scopes:[]).map(String).filter(scope=>SCOPES.has(scope)))];
  if(!clean.length)throw new ApiKeyError('At least one supported API key scope is required.',{code:'API_KEY_SCOPE_REQUIRED'});
  if(clean.length!==(Array.isArray(scopes)?new Set(scopes.map(String)).size:0))throw new ApiKeyError('API key scopes contain an unsupported value.',{code:'API_KEY_SCOPE_INVALID'});
  return clean.sort();
}
function ttlSeconds(value){const n=Math.trunc(Number(value));if(!Number.isFinite(n)||n<=0)return DEFAULT_TTL_SECONDS;return Math.max(3600,Math.min(MAX_TTL_SECONDS,n))}

export function ensureApiKeySchema(store){
  if(!store?.db)throw new TypeError('HostedStore is required');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys(
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      token_prefix TEXT NOT NULL,
      scopes_json TEXT NOT NULL,
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      last_used_at TEXT,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_api_keys_workspace ON api_keys(workspace_id,created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_api_keys_token_hash ON api_keys(token_hash);
  `);
}

function publicRow(row){
  return row?{
    id:row.id,workspaceId:row.workspace_id,name:row.name,tokenPrefix:row.token_prefix,
    scopes:JSON.parse(row.scopes_json||'[]'),createdBy:row.created_by,createdAt:row.created_at,
    expiresAt:row.expires_at,revokedAt:row.revoked_at||null,lastUsedAt:row.last_used_at||null,
  }:null;
}

export function createApiKey(store,{workspaceId,userId,name='Automation key',scopes=['read:dashboard'],ttlSeconds:ttl}={}){
  ensureApiKeySchema(store);
  store.requireRole(userId,workspaceId,['owner','admin']);
  const selected=normalizeScopes(scopes),token=`${TOKEN_PREFIX}${crypto.randomBytes(32).toString('base64url')}`,createdAt=new Date().toISOString(),expiresAt=new Date(Date.now()+ttlSeconds(ttl)*1000).toISOString();
  const row={id:id(),workspaceId,name:String(name||'Automation key').trim().slice(0,120)||'Automation key',tokenPrefix:token.slice(0,18),scopes:selected,createdAt,expiresAt};
  store.db.prepare('INSERT INTO api_keys(id,workspace_id,name,token_hash,token_prefix,scopes_json,created_by,created_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(row.id,workspaceId,row.name,hashToken(token),row.tokenPrefix,JSON.stringify(selected),userId,createdAt,expiresAt);
  store.audit({workspaceId,userId,action:'api_key.create',targetType:'api_key',targetId:row.id,metadata:{name:row.name,scopes:selected,expiresAt}});
  return {...row,createdBy:userId,revokedAt:null,lastUsedAt:null,token};
}

export function listApiKeys(store,{workspaceId,userId}={}){
  ensureApiKeySchema(store);store.requireRole(userId,workspaceId,['owner','admin']);
  return store.db.prepare('SELECT * FROM api_keys WHERE workspace_id=? ORDER BY created_at DESC').all(workspaceId).map(publicRow);
}

export function revokeApiKey(store,{workspaceId,userId,keyId}={}){
  ensureApiKeySchema(store);store.requireRole(userId,workspaceId,['owner','admin']);
  const timestamp=new Date().toISOString();
  const result=store.db.prepare('UPDATE api_keys SET revoked_at=? WHERE id=? AND workspace_id=? AND revoked_at IS NULL').run(timestamp,String(keyId||''),workspaceId);
  if(!Number(result.changes||0))throw new ApiKeyError('API key not found or already revoked.',{code:'API_KEY_NOT_FOUND',statusCode:404});
  store.audit({workspaceId,userId,action:'api_key.revoke',targetType:'api_key',targetId:keyId,metadata:{}});
  return {id:keyId,workspaceId,revokedAt:timestamp};
}

export function resolveApiKey(store,token,{requiredScope=''}={}){
  ensureApiKeySchema(store);
  const raw=String(token||'').trim();
  if(!raw.startsWith(TOKEN_PREFIX)||raw.length<40)throw new ApiKeyError('Invalid API key.',{code:'API_KEY_INVALID',statusCode:401});
  const row=store.db.prepare('SELECT * FROM api_keys WHERE token_hash=?').get(hashToken(raw));
  const now=Date.now();
  if(!row||row.revoked_at||Date.parse(row.expires_at)<=now)throw new ApiKeyError('API key is invalid, revoked, or expired.',{code:'API_KEY_INVALID',statusCode:401});
  const scopes=JSON.parse(row.scopes_json||'[]');
  if(requiredScope&&!scopes.includes(requiredScope))throw new ApiKeyError('API key does not have the required scope.',{code:'API_KEY_SCOPE_FORBIDDEN',statusCode:403});
  const entitlement=store.getEntitlement(row.workspace_id);
  if(!ACTIVE_ENTITLEMENTS.has(entitlement.status))throw new ApiKeyError('Workspace entitlement is not active.',{code:'ENTITLEMENT_REQUIRED',statusCode:402});
  const usedAt=new Date().toISOString();
  store.db.prepare('UPDATE api_keys SET last_used_at=? WHERE id=?').run(usedAt,row.id);
  return {...publicRow({...row,last_used_at:usedAt}),entitlement};
}

export function bearerApiKey(req){
  const header=String(req?.headers?.authorization||'');
  if(!/^Bearer\s+/iu.test(header))return '';
  const token=header.replace(/^Bearer\s+/iu,'').trim();
  return token.startsWith(TOKEN_PREFIX)?token:'';
}

export const apiKeyScopes=Object.freeze([...SCOPES].sort());
