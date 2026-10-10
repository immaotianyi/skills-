import crypto from 'node:crypto';

const LOGIN_WINDOW_MS=15*60_000;
const LOGIN_BLOCK_MS=15*60_000;
const PAIR_LIMIT=8;
const IP_LIMIT=40;

export class AuthThrottleError extends Error{
  constructor(message,{retryAfterSeconds=60}={}){super(message);this.code='AUTH_RATE_LIMIT';this.statusCode=429;this.retryAfterSeconds=Math.max(1,Math.trunc(retryAfterSeconds)||60)}
}

function normalizeEmail(value){return String(value||'').trim().toLowerCase().slice(0,320)}
function hashKey(scope,value){return crypto.createHash('sha256').update(`${scope}\0${String(value||'')}`).digest('hex')}
function iso(ms){return new Date(ms).toISOString()}
function parseMs(value){const ms=Date.parse(String(value||''));return Number.isFinite(ms)?ms:0}

export function ensureAuthSecuritySchema(store){
  if(!store?.db)throw new TypeError('HostedStore is required');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS auth_rate_limits(
      key_hash TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      failures INTEGER NOT NULL DEFAULT 0,
      window_started_at TEXT NOT NULL,
      blocked_until TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_blocked ON auth_rate_limits(blocked_until);
  `);
}

export function requestClientIp(req,env=process.env){
  const trustProxy=['1','true','yes'].includes(String(env.XHS_STUDIO_TRUST_PROXY||'').toLowerCase());
  if(trustProxy){
    const forwarded=String(req?.headers?.['x-forwarded-for']||'').split(',')[0].trim();
    if(forwarded)return forwarded.slice(0,128);
  }
  return String(req?.socket?.remoteAddress||'unknown').slice(0,128);
}

function keys(email,ip){
  const normalized=normalizeEmail(email),address=String(ip||'unknown');
  return [
    {scope:'login_pair',keyHash:hashKey('login_pair',`${normalized}\0${address}`),limit:PAIR_LIMIT},
    {scope:'login_ip',keyHash:hashKey('login_ip',address),limit:IP_LIMIT},
  ];
}

function currentRow(store,keyHash){return store.db.prepare('SELECT * FROM auth_rate_limits WHERE key_hash=?').get(keyHash)||null}
function activeBlock(row,nowMs){const until=parseMs(row?.blocked_until);return until>nowMs?until:0}

export function loginThrottleState(store,{email,ip,nowMs=Date.now()}={}){
  ensureAuthSecuritySchema(store);
  let blockedUntil=0;
  for(const key of keys(email,ip))blockedUntil=Math.max(blockedUntil,activeBlock(currentRow(store,key.keyHash),nowMs));
  return {blocked:blockedUntil>nowMs,blockedUntil:blockedUntil?iso(blockedUntil):null,retryAfterSeconds:blockedUntil>nowMs?Math.ceil((blockedUntil-nowMs)/1000):0};
}

export function assertLoginAllowed(store,input={}){
  const state=loginThrottleState(store,input);
  if(state.blocked)throw new AuthThrottleError('Too many login attempts. Try again later.',{retryAfterSeconds:state.retryAfterSeconds});
  return state;
}

export function recordLoginFailure(store,{email,ip,nowMs=Date.now()}={}){
  ensureAuthSecuritySchema(store);
  store.db.exec('BEGIN IMMEDIATE');
  let blockedUntil=0;
  try{
    for(const key of keys(email,ip)){
      const row=currentRow(store,key.keyHash);
      const existingWindow=parseMs(row?.window_started_at);
      const inWindow=existingWindow&&nowMs-existingWindow<LOGIN_WINDOW_MS;
      const failures=(inWindow?Number(row?.failures||0):0)+1;
      const windowStarted=inWindow?existingWindow:nowMs;
      const previousBlock=activeBlock(row,nowMs);
      const nextBlock=previousBlock|| (failures>=key.limit?nowMs+LOGIN_BLOCK_MS:0);
      blockedUntil=Math.max(blockedUntil,nextBlock);
      store.db.prepare(`INSERT INTO auth_rate_limits(key_hash,scope,failures,window_started_at,blocked_until,updated_at)
        VALUES(?,?,?,?,?,?) ON CONFLICT(key_hash) DO UPDATE SET scope=excluded.scope,failures=excluded.failures,
        window_started_at=excluded.window_started_at,blocked_until=excluded.blocked_until,updated_at=excluded.updated_at`)
        .run(key.keyHash,key.scope,failures,iso(windowStarted),nextBlock?iso(nextBlock):null,iso(nowMs));
    }
    store.db.exec('COMMIT');
  }catch(error){try{store.db.exec('ROLLBACK')}catch{}throw error}
  return {blocked:blockedUntil>nowMs,blockedUntil:blockedUntil?iso(blockedUntil):null,retryAfterSeconds:blockedUntil>nowMs?Math.ceil((blockedUntil-nowMs)/1000):0};
}

export function recordLoginSuccess(store,{email,ip}={}){
  ensureAuthSecuritySchema(store);
  const pair=keys(email,ip)[0];
  store.db.prepare('DELETE FROM auth_rate_limits WHERE key_hash=?').run(pair.keyHash);
}

export const authSecurityLimits=Object.freeze({loginWindowMs:LOGIN_WINDOW_MS,loginBlockMs:LOGIN_BLOCK_MS,pairLimit:PAIR_LIMIT,ipLimit:IP_LIMIT});
