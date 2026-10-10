import crypto from 'node:crypto';

const LOGIN_WINDOW_MS=15*60_000;
const LOGIN_BLOCK_MS=15*60_000;
const PAIR_LIMIT=8;
const IP_LIMIT=40;
const REGISTER_WINDOW_MS=60*60_000;
const REGISTER_BLOCK_MS=60*60_000;
const REGISTER_IP_LIMIT=12;

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

function loginKeys(email,ip){
  const normalized=normalizeEmail(email),address=String(ip||'unknown');
  return [
    {scope:'login_pair',keyHash:hashKey('login_pair',`${normalized}\0${address}`),limit:PAIR_LIMIT,windowMs:LOGIN_WINDOW_MS,blockMs:LOGIN_BLOCK_MS},
    {scope:'login_ip',keyHash:hashKey('login_ip',address),limit:IP_LIMIT,windowMs:LOGIN_WINDOW_MS,blockMs:LOGIN_BLOCK_MS},
  ];
}

function registrationKey(ip){
  const address=String(ip||'unknown');
  return {scope:'register_ip',keyHash:hashKey('register_ip',address),limit:REGISTER_IP_LIMIT,windowMs:REGISTER_WINDOW_MS,blockMs:REGISTER_BLOCK_MS};
}

function currentRow(store,keyHash){return store.db.prepare('SELECT * FROM auth_rate_limits WHERE key_hash=?').get(keyHash)||null}
function activeBlock(row,nowMs){const until=parseMs(row?.blocked_until);return until>nowMs?until:0}

function throttleState(store,keys,nowMs){
  ensureAuthSecuritySchema(store);
  let blockedUntil=0;
  for(const key of keys)blockedUntil=Math.max(blockedUntil,activeBlock(currentRow(store,key.keyHash),nowMs));
  return {blocked:blockedUntil>nowMs,blockedUntil:blockedUntil?iso(blockedUntil):null,retryAfterSeconds:blockedUntil>nowMs?Math.ceil((blockedUntil-nowMs)/1000):0};
}

function recordCounters(store,keys,nowMs){
  ensureAuthSecuritySchema(store);
  store.db.exec('BEGIN IMMEDIATE');
  let blockedUntil=0;
  try{
    for(const key of keys){
      const row=currentRow(store,key.keyHash);
      const existingWindow=parseMs(row?.window_started_at);
      const inWindow=existingWindow&&nowMs-existingWindow<key.windowMs;
      const failures=(inWindow?Number(row?.failures||0):0)+1;
      const windowStarted=inWindow?existingWindow:nowMs;
      const previousBlock=activeBlock(row,nowMs);
      const nextBlock=previousBlock||(failures>=key.limit?nowMs+key.blockMs:0);
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

export function loginThrottleState(store,{email,ip,nowMs=Date.now()}={}){
  return throttleState(store,loginKeys(email,ip),nowMs);
}

export function assertLoginAllowed(store,input={}){
  const state=loginThrottleState(store,input);
  if(state.blocked)throw new AuthThrottleError('Too many login attempts. Try again later.',{retryAfterSeconds:state.retryAfterSeconds});
  return state;
}

export function recordLoginFailure(store,{email,ip,nowMs=Date.now()}={}){
  return recordCounters(store,loginKeys(email,ip),nowMs);
}

export function recordLoginSuccess(store,{email,ip}={}){
  ensureAuthSecuritySchema(store);
  const pair=loginKeys(email,ip)[0];
  store.db.prepare('DELETE FROM auth_rate_limits WHERE key_hash=?').run(pair.keyHash);
}

export function registrationThrottleState(store,{ip,nowMs=Date.now()}={}){
  return throttleState(store,[registrationKey(ip)],nowMs);
}

export function assertRegistrationAllowed(store,input={}){
  const state=registrationThrottleState(store,input);
  if(state.blocked)throw new AuthThrottleError('Too many account registrations from this address. Try again later.',{retryAfterSeconds:state.retryAfterSeconds});
  return state;
}

export function recordRegistrationAttempt(store,{ip,nowMs=Date.now()}={}){
  return recordCounters(store,[registrationKey(ip)],nowMs);
}

export const authSecurityLimits=Object.freeze({
  loginWindowMs:LOGIN_WINDOW_MS,
  loginBlockMs:LOGIN_BLOCK_MS,
  pairLimit:PAIR_LIMIT,
  ipLimit:IP_LIMIT,
  registrationWindowMs:REGISTER_WINDOW_MS,
  registrationBlockMs:REGISTER_BLOCK_MS,
  registrationIpLimit:REGISTER_IP_LIMIT,
});
