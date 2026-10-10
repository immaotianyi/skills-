import { analyze, diffHarvest } from './analysis.mjs';

const HARD_RISK=new Set(['CAPTCHA','ACCESS_DENIED','BLOCKED','LOGIN_REQUIRED']);
const RUN_ATTENTION=new Set(['failed','manual_action_required']);
const LEVEL_WEIGHT=Object.freeze({none:0,low:1,medium:2,high:3});

function isoTime(value){const ms=Date.parse(String(value||''));return Number.isFinite(ms)?new Date(ms).toISOString():null}
function analysisOf(snapshot){return snapshot?.harvest?(snapshot.analysis||analyze(snapshot.harvest)):null}
function alertLevel(alert){const level=String(alert?.level||'medium').toLowerCase();return LEVEL_WEIGHT[level]===undefined?'medium':level}
function maxLevel(levels){return levels.reduce((best,level)=>LEVEL_WEIGHT[level]>LEVEL_WEIGHT[best]?level:best,'none')}

export function buildPortfolioRow({project,latestSnapshot=null,previousSnapshot=null,latestRun=null}={}){
  if(!project?.id)throw new TypeError('project is required');
  const latestAnalysis=analysisOf(latestSnapshot);
  const diff=latestSnapshot?.harvest&&previousSnapshot?.harvest?diffHarvest(previousSnapshot.harvest,latestSnapshot.harvest):null;
  const alerts=(diff?.alerts||latestRun?.attention||[]).map(alert=>({
    level:alertLevel(alert),
    type:String(alert?.type||'attention').slice(0,80),
    title:String(alert?.title||'Attention required').slice(0,240),
    detail:String(alert?.detail||'').slice(0,500),
  }));
  const riskState=String(latestAnalysis?.coverage?.riskState||latestSnapshot?.harvest?.meta?.riskState||latestRun?.riskState||'NORMAL');
  const quality=latestAnalysis?.quality?{
    status:String(latestAnalysis.quality.status||'unknown'),
    score:Number.isFinite(Number(latestAnalysis.quality.score))?Number(latestAnalysis.quality.score):null,
    warnings:Array.isArray(latestAnalysis.quality.warnings)?latestAnalysis.quality.warnings.slice(0,5):[],
  }:null;
  const coverage=latestAnalysis?.coverage?{
    notes:Number(latestAnalysis.coverage.notes||0),
    comments:Number(latestAnalysis.coverage.comments||0),
    authors:Number(latestAnalysis.coverage.authors||0),
    gaps:Array.isArray(latestAnalysis.coverage.gaps)?latestAnalysis.coverage.gaps.length:0,
  }:null;
  const run=latestRun?{
    id:latestRun.id,
    state:latestRun.state,
    trigger:latestRun.trigger||'manual',
    updatedAt:isoTime(latestRun.updatedAt||latestRun.finishedAt||latestRun.createdAt),
    snapshotId:latestRun.snapshotId||null,
  }:null;
  const levelCandidates=alerts.map(alert=>alert.level);
  if(HARD_RISK.has(riskState))levelCandidates.push('high');
  else if(riskState!=='NORMAL')levelCandidates.push('medium');
  if(RUN_ATTENTION.has(String(run?.state||'')))levelCandidates.push(run.state==='failed'?'high':'medium');
  if(quality?.status==='blocked'||quality?.status==='weak')levelCandidates.push('high');
  else if(quality?.status==='caution')levelCandidates.push('medium');
  if(!latestSnapshot)levelCandidates.push('low');
  const attentionLevel=maxLevel(levelCandidates);
  return {
    projectId:project.id,
    name:String(project.name||project.id),
    client:String(project.client||''),
    category:String(project.category||''),
    updatedAt:isoTime(project.updatedAt||project.createdAt),
    latestSnapshotAt:isoTime(latestSnapshot?.createdAt||latestSnapshot?.harvest?.source?.capturedAt),
    snapshotId:latestSnapshot?.id||null,
    quality,
    coverage,
    riskState,
    latestRun:run,
    alerts,
    attentionLevel,
    needsAttention:attentionLevel!=='none',
  };
}

export function buildPortfolioSummary(rows=[]){
  const projects=[...rows];
  const summary={
    totalProjects:projects.length,
    withSnapshots:projects.filter(row=>row.latestSnapshotAt).length,
    withoutSnapshots:projects.filter(row=>!row.latestSnapshotAt).length,
    needsAttention:projects.filter(row=>row.needsAttention).length,
    highAttention:projects.filter(row=>row.attentionLevel==='high').length,
    nonNormalRisk:projects.filter(row=>row.riskState&&row.riskState!=='NORMAL').length,
    failedOrManualRuns:projects.filter(row=>RUN_ATTENTION.has(String(row.latestRun?.state||''))).length,
  };
  const sorted=projects.sort((a,b)=>{
    const attention=LEVEL_WEIGHT[b.attentionLevel]-LEVEL_WEIGHT[a.attentionLevel];
    if(attention)return attention;
    const time=(Date.parse(b.latestSnapshotAt||b.updatedAt||'')||0)-(Date.parse(a.latestSnapshotAt||a.updatedAt||'')||0);
    return time||String(a.name).localeCompare(String(b.name),'zh-CN');
  });
  return {summary,projects:sorted};
}

export const portfolioSemantics=Object.freeze({
  purpose:'Agency triage across workspace projects; not a cross-project population inference.',
  attentionLevels:Object.keys(LEVEL_WEIGHT),
  hardRiskStates:[...HARD_RISK],
});
