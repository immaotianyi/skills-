const DEFAULT_BRANDING=Object.freeze({agencyName:'',reportTitle:'',accentColor:'#171717',footerText:''});
const HEX_RE=/^#[0-9a-f]{6}$/iu;

function cleanText(value,max){return String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max)}
function cleanColor(value){const color=String(value||'').trim().toLowerCase();return HEX_RE.test(color)?color:DEFAULT_BRANDING.accentColor}

export class BrandingError extends Error{
  constructor(message,{code='BRANDING_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

export function normalizeBranding(input={}){
  return {
    agencyName:cleanText(input.agencyName,120),
    reportTitle:cleanText(input.reportTitle,160),
    accentColor:cleanColor(input.accentColor),
    footerText:cleanText(input.footerText,300),
  };
}

export function ensureBrandingSchema(store){
  if(!store?.db)throw new TypeError('HostedStore is required');
  store.db.exec(`CREATE TABLE IF NOT EXISTS workspace_branding(
    workspace_id TEXT PRIMARY KEY,
    agency_name TEXT NOT NULL DEFAULT '',
    report_title TEXT NOT NULL DEFAULT '',
    accent_color TEXT NOT NULL DEFAULT '#171717',
    footer_text TEXT NOT NULL DEFAULT '',
    updated_by TEXT,
    updated_at TEXT NOT NULL,
    FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
    FOREIGN KEY(updated_by) REFERENCES users(id) ON DELETE SET NULL
  )`);
}

export function getWorkspaceBranding(store,workspaceId){
  ensureBrandingSchema(store);
  const row=store.db.prepare('SELECT agency_name,report_title,accent_color,footer_text,updated_at FROM workspace_branding WHERE workspace_id=?').get(workspaceId);
  if(!row)return {...DEFAULT_BRANDING,updatedAt:null};
  return {...normalizeBranding({agencyName:row.agency_name,reportTitle:row.report_title,accentColor:row.accent_color,footerText:row.footer_text}),updatedAt:row.updated_at||null};
}

export function updateWorkspaceBranding(store,{actorUserId,workspaceId,input={}}={}){
  ensureBrandingSchema(store);
  if(!actorUserId||!workspaceId)throw new BrandingError('Workspace and actor are required.',{code:'BRANDING_CONTEXT_REQUIRED'});
  store.requireRole(actorUserId,workspaceId,['owner','admin']);
  const branding=normalizeBranding(input),updatedAt=new Date().toISOString();
  store.db.prepare(`INSERT INTO workspace_branding(workspace_id,agency_name,report_title,accent_color,footer_text,updated_by,updated_at)
    VALUES(?,?,?,?,?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET
    agency_name=excluded.agency_name,report_title=excluded.report_title,accent_color=excluded.accent_color,
    footer_text=excluded.footer_text,updated_by=excluded.updated_by,updated_at=excluded.updated_at`)
    .run(workspaceId,branding.agencyName,branding.reportTitle,branding.accentColor,branding.footerText,actorUserId,updatedAt);
  store.audit({workspaceId,userId:actorUserId,action:'workspace.branding.update',targetType:'workspace',targetId:workspaceId,metadata:branding});
  return {...branding,updatedAt};
}

export const brandingDefaults=DEFAULT_BRANDING;
