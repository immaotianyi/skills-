const ALERT_ID_RE=/^alt_[0-9a-f]{24}$/u;

export class AlertStateError extends Error{
  constructor(message,{code='ALERT_STATE_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

function assertStore(store){if(!store?.db)throw new TypeError('HostedStore is required')}
function assertAlertId(alertId){if(!ALERT_ID_RE.test(String(alertId||'')))throw new AlertStateError('Invalid alert ID.',{code:'ALERT_ID_INVALID'})}
function safeNote(value){return String(value??'').trim().slice(0,1000)}

export function ensureAlertStateSchema(store){
  assertStore(store);
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS alert_acknowledgements(
      workspace_id TEXT NOT NULL,
      alert_id TEXT NOT NULL,
      acknowledged_by TEXT NOT NULL,
      acknowledged_at TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      PRIMARY KEY(workspace_id,alert_id),
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(acknowledged_by) REFERENCES users(id) ON DELETE RESTRICT
    );
    CREATE INDEX IF NOT EXISTS idx_alert_ack_workspace_time ON alert_acknowledgements(workspace_id,acknowledged_at DESC);
  `);
}

export function acknowledgeAlert(store,{workspaceId,alertId,userId,note=''}={}){
  assertStore(store);assertAlertId(alertId);
  store.requireRole(userId,workspaceId,['owner','admin','analyst']);
  ensureAlertStateSchema(store);
  const timestamp=new Date().toISOString(),cleanNote=safeNote(note);
  store.db.prepare(`INSERT INTO alert_acknowledgements(workspace_id,alert_id,acknowledged_by,acknowledged_at,note)
    VALUES(?,?,?,?,?) ON CONFLICT(workspace_id,alert_id) DO UPDATE SET
    acknowledged_by=excluded.acknowledged_by,acknowledged_at=excluded.acknowledged_at,note=excluded.note`)
    .run(workspaceId,alertId,userId,timestamp,cleanNote);
  store.audit({workspaceId,userId,action:'alert.acknowledge',targetType:'alert',targetId:alertId,metadata:{note:cleanNote}});
  return {workspaceId,alertId,acknowledged:true,acknowledgedBy:userId,acknowledgedAt:timestamp,note:cleanNote};
}

export function clearAlertAcknowledgement(store,{workspaceId,alertId,userId}={}){
  assertStore(store);assertAlertId(alertId);
  store.requireRole(userId,workspaceId,['owner','admin','analyst']);
  ensureAlertStateSchema(store);
  const result=store.db.prepare('DELETE FROM alert_acknowledgements WHERE workspace_id=? AND alert_id=?').run(workspaceId,alertId);
  store.audit({workspaceId,userId,action:'alert.unacknowledge',targetType:'alert',targetId:alertId,metadata:{existed:Number(result.changes||0)>0}});
  return {workspaceId,alertId,acknowledged:false,removed:Number(result.changes||0)>0};
}

export function alertAcknowledgements(store,workspaceId,alertIds=[]){
  assertStore(store);ensureAlertStateSchema(store);
  const ids=[...new Set((alertIds||[]).map(String).filter(id=>ALERT_ID_RE.test(id)))];
  if(!ids.length)return new Map();
  const out=new Map();
  const chunkSize=200;
  for(let start=0;start<ids.length;start+=chunkSize){
    const chunk=ids.slice(start,start+chunkSize),marks=chunk.map(()=>'?').join(',');
    const rows=store.db.prepare(`SELECT workspace_id,alert_id,acknowledged_by,acknowledged_at,note FROM alert_acknowledgements WHERE workspace_id=? AND alert_id IN (${marks})`).all(workspaceId,...chunk);
    for(const row of rows)out.set(row.alert_id,{acknowledged:true,acknowledgedBy:row.acknowledged_by,acknowledgedAt:row.acknowledged_at,note:row.note||''});
  }
  return out;
}

export function decorateAlertsWithAcknowledgements(store,workspaceId,alerts=[]){
  const states=alertAcknowledgements(store,workspaceId,(alerts||[]).map(alert=>alert.id));
  return (alerts||[]).map(alert=>({...alert,acknowledgement:states.get(alert.id)||{acknowledged:false,acknowledgedBy:null,acknowledgedAt:null,note:''}}));
}
