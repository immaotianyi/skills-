import crypto from 'node:crypto';

const MAX_TEMPLATES=50;
const WRITE_ROLES=['owner','admin','analyst'];

function cleanText(value,max){return String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max)}
function cleanList(value,{limit=100,itemMax=120}={}){
  if(!Array.isArray(value))return[];
  return [...new Set(value.map(item=>cleanText(item,itemMax)).filter(Boolean))].slice(0,limit);
}
function id(){return `tpl_${Date.now().toString(36)}_${crypto.randomBytes(6).toString('hex')}`}
function now(){return new Date().toISOString()}
function parseList(value){try{const parsed=JSON.parse(String(value||'[]'));return Array.isArray(parsed)?parsed:[]}catch{return[]}}

export class SavedTemplateError extends Error{
  constructor(message,{code='SAVED_TEMPLATE_ERROR',statusCode=400}={}){super(message);this.code=code;this.statusCode=statusCode}
}

export function ensureSavedTemplateSchema(store){
  if(!store?.db)throw new TypeError('HostedStore is required');
  store.db.exec(`
    CREATE TABLE IF NOT EXISTS workspace_project_templates(
      id TEXT PRIMARY KEY,
      workspace_id TEXT NOT NULL,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '',
      keywords_json TEXT NOT NULL DEFAULT '[]',
      competitors_json TEXT NOT NULL DEFAULT '[]',
      created_by TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY(workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE,
      FOREIGN KEY(created_by) REFERENCES users(id) ON DELETE CASCADE,
      UNIQUE(workspace_id,name)
    );
    CREATE INDEX IF NOT EXISTS idx_workspace_project_templates_workspace ON workspace_project_templates(workspace_id,created_at DESC);
  `);
}

export function normalizeSavedTemplate(input={}){
  const name=cleanText(input.name,120);
  if(!name)throw new SavedTemplateError('Template name is required.',{code:'TEMPLATE_NAME_REQUIRED'});
  return {
    name,
    description:cleanText(input.description,300),
    category:cleanText(input.category,120),
    keywords:cleanList(input.keywords),
    competitors:cleanList(input.competitors),
  };
}

function rowShape(row){return{
  id:row.id,workspaceId:row.workspace_id,name:row.name,description:row.description,category:row.category,
  keywords:parseList(row.keywords_json),competitors:parseList(row.competitors_json),createdBy:row.created_by,
  createdAt:row.created_at,updatedAt:row.updated_at,
}}

export function listSavedTemplates(store,{actorUserId,workspaceId}={}){
  ensureSavedTemplateSchema(store);store.requireRole(actorUserId,workspaceId);
  return store.db.prepare('SELECT * FROM workspace_project_templates WHERE workspace_id=? ORDER BY created_at DESC,name').all(workspaceId).map(rowShape);
}

export function createSavedTemplate(store,{actorUserId,workspaceId,input={}}={}){
  ensureSavedTemplateSchema(store);store.requireRole(actorUserId,workspaceId,WRITE_ROLES);
  const template=normalizeSavedTemplate(input),templateId=id(),timestamp=now();
  store.db.exec('BEGIN IMMEDIATE');
  try{
    const count=Number(store.db.prepare('SELECT COUNT(*) AS count FROM workspace_project_templates WHERE workspace_id=?').get(workspaceId)?.count||0);
    if(count>=MAX_TEMPLATES)throw new SavedTemplateError(`Workspace template limit reached (${MAX_TEMPLATES}).`,{code:'TEMPLATE_LIMIT',statusCode:409});
    try{
      store.db.prepare(`INSERT INTO workspace_project_templates(id,workspace_id,name,description,category,keywords_json,competitors_json,created_by,created_at,updated_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`).run(templateId,workspaceId,template.name,template.description,template.category,JSON.stringify(template.keywords),JSON.stringify(template.competitors),actorUserId,timestamp,timestamp);
    }catch(error){
      if(String(error?.message||'').includes('UNIQUE constraint failed'))throw new SavedTemplateError('A saved template with this name already exists in the workspace.',{code:'TEMPLATE_NAME_EXISTS',statusCode:409});
      throw error;
    }
    store.db.exec('COMMIT');
  }catch(error){try{store.db.exec('ROLLBACK')}catch{}throw error}
  store.audit({workspaceId,userId:actorUserId,action:'project.template.create',targetType:'project_template',targetId:templateId,metadata:{name:template.name,category:template.category,keywords:template.keywords.length,competitors:template.competitors.length}});
  return {id:templateId,workspaceId,...template,createdBy:actorUserId,createdAt:timestamp,updatedAt:timestamp};
}

export function deleteSavedTemplate(store,{actorUserId,workspaceId,templateId}={}){
  ensureSavedTemplateSchema(store);store.requireRole(actorUserId,workspaceId,WRITE_ROLES);
  const row=store.db.prepare('SELECT id,name FROM workspace_project_templates WHERE id=? AND workspace_id=?').get(templateId,workspaceId);
  if(!row)throw new SavedTemplateError('Saved template not found.',{code:'TEMPLATE_NOT_FOUND',statusCode:404});
  store.db.prepare('DELETE FROM workspace_project_templates WHERE id=? AND workspace_id=?').run(templateId,workspaceId);
  store.audit({workspaceId,userId:actorUserId,action:'project.template.delete',targetType:'project_template',targetId:templateId,metadata:{name:row.name}});
  return {ok:true,id:templateId};
}

export const savedTemplateLimits=Object.freeze({maxTemplates:MAX_TEMPLATES,maxKeywords:100,maxCompetitors:100});
