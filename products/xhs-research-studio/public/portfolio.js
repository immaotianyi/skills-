(() => {
  const LEVEL_WEIGHT={none:0,low:1,medium:2,high:3};
  const HARD_RISK=new Set(['CAPTCHA','ACCESS_DENIED','BLOCKED','LOGIN_REQUIRED']);
  const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  const fmtTime=value=>{const ms=Date.parse(String(value||''));return Number.isFinite(ms)?new Date(ms).toLocaleString():'—'};
  const levelLabel=level=>({high:'高',medium:'中',low:'低',none:'正常'}[level]||level);

  async function json(path){
    const response=await fetch(path);
    const text=await response.text();let body=text;try{body=text?JSON.parse(text):null}catch{}
    if(!response.ok)throw new Error(body?.error||text||`HTTP ${response.status}`);
    return body;
  }

  function attentionLevel({snapshot,run,alerts}){
    const levels=[];
    const risk=String(snapshot?.coverage?.riskState||run?.riskState||'NORMAL');
    if(HARD_RISK.has(risk))levels.push('high');else if(risk!=='NORMAL')levels.push('medium');
    if(run?.state==='failed')levels.push('high');else if(run?.state==='manual_action_required')levels.push('medium');
    const quality=String(snapshot?.quality?.status||'');
    if(['blocked','weak'].includes(quality))levels.push('high');else if(quality==='caution')levels.push('medium');
    for(const alert of alerts||[])levels.push(LEVEL_WEIGHT[alert?.level]===undefined?'medium':alert.level);
    if(!snapshot)levels.push('low');
    return levels.reduce((best,level)=>LEVEL_WEIGHT[level]>LEVEL_WEIGHT[best]?level:best,'none');
  }

  async function mapLimited(items,limit,worker){
    const output=new Array(items.length);let cursor=0;
    async function lane(){while(cursor<items.length){const index=cursor++;output[index]=await worker(items[index],index)}}
    await Promise.all(Array.from({length:Math.min(Math.max(1,limit),Math.max(1,items.length))},lane));
    return output;
  }

  async function loadRow(project){
    const [snapshotBody,runBody]=await Promise.all([
      json(`/api/projects/${encodeURIComponent(project.id)}/snapshots`),
      json(`/api/projects/${encodeURIComponent(project.id)}/runs`),
    ]);
    const snapshots=Array.isArray(snapshotBody?.snapshots)?snapshotBody.snapshots:[];
    const runs=Array.isArray(runBody?.runs)?runBody.runs:[];
    const snapshot=snapshots.at(-1)||null,run=runs.at(-1)||null;
    const alerts=run?.snapshotId&&snapshot?.id===run.snapshotId&&Array.isArray(run.attention)?run.attention:[];
    const level=attentionLevel({snapshot,run,alerts});
    return {
      projectId:project.id,name:project.name||project.id,client:project.client||'',category:project.category||'',
      snapshot,run,alerts,attentionLevel:level,needsAttention:level!=='none',
    };
  }

  function aggregate(rows){
    const summary={
      totalProjects:rows.length,
      withSnapshots:rows.filter(row=>row.snapshot).length,
      needsAttention:rows.filter(row=>row.needsAttention).length,
      highAttention:rows.filter(row=>row.attentionLevel==='high').length,
      nonNormalRisk:rows.filter(row=>String(row.snapshot?.coverage?.riskState||row.run?.riskState||'NORMAL')!=='NORMAL').length,
    };
    rows.sort((a,b)=>{
      const byAttention=LEVEL_WEIGHT[b.attentionLevel]-LEVEL_WEIGHT[a.attentionLevel];
      if(byAttention)return byAttention;
      const bt=Date.parse(b.snapshot?.createdAt||b.run?.updatedAt||'')||0,at=Date.parse(a.snapshot?.createdAt||a.run?.updatedAt||'')||0;
      return bt-at||String(a.name).localeCompare(String(b.name),'zh-CN');
    });
    return summary;
  }

  function renderSummary(summary){
    return `<div class="metrics"><div><b>${summary.totalProjects}</b><span>项目</span></div><div><b>${summary.withSnapshots}</b><span>有快照</span></div><div><b>${summary.needsAttention}</b><span>需关注</span></div><div><b>${summary.highAttention}</b><span>高优先</span></div><div><b>${summary.nonNormalRisk}</b><span>采集风险</span></div></div>`;
  }

  function rowHtml(row){
    const snapshot=row.snapshot||{},quality=snapshot.quality||{},coverage=snapshot.coverage||{};
    const risk=String(coverage.riskState||row.run?.riskState||'NORMAL');
    const alerts=(row.alerts||[]).slice(0,4);
    const alertHtml=alerts.length?`<ul>${alerts.map(alert=>`<li><b>${esc(alert.type||'attention')}</b> · ${esc(alert.title||'需要关注')}${alert.detail?`<br><small>${esc(alert.detail)}</small>`:''}</li>`).join('')}</ul>`:'<p><small>当前没有来自最近自动运行的 attention alert。</small></p>';
    return `<article class="card" data-portfolio-project="${esc(row.projectId)}"><div class="row"><div><span class="eyebrow">${esc(row.client||row.category||'CLIENT PROJECT')}</span><h4>${esc(row.name)}</h4></div><b>关注 ${esc(levelLabel(row.attentionLevel))}</b></div><p>证据质量：${quality.status?`${esc(quality.status)}${Number.isFinite(Number(quality.score))?` · ${Number(quality.score)}/100`:''}`:'无快照'}<br>采集风险：${esc(risk)}<br>覆盖：${Number(coverage.notes||0)} notes / ${Number(coverage.comments||0)} comments<br>最新快照：${esc(fmtTime(snapshot.createdAt))}<br>最新运行：${esc(row.run?.state||'—')} · ${esc(fmtTime(row.run?.updatedAt))}</p>${alertHtml}</article>`;
  }

  async function renderPortfolio(){
    const panel=document.getElementById('hostedPanel');if(!panel)return;
    panel.hidden=false;panel.innerHTML='<div class="row"><h3>Agency Portfolio</h3><button id="portfolioClose" class="link">关闭</button></div><p>正在汇总 workspace 项目、最近快照和运行状态…</p>';
    panel.querySelector('#portfolioClose').onclick=()=>{panel.hidden=true};
    try{
      const projectBody=await json('/api/projects'),projects=Array.isArray(projectBody?.projects)?projectBody.projects:[];
      const rows=await mapLimited(projects,4,loadRow),summary=aggregate(rows);
      panel.innerHTML=`<div class="row"><div><span class="eyebrow">AGENCY TRIAGE</span><h3>Portfolio</h3></div><button id="portfolioClose" class="link">关闭</button></div><p>跨客户项目的运营视图，只汇总证据质量、采集风险、最近运行和 attention；具体结论仍回到项目证据链。</p>${renderSummary(summary)}<div id="portfolioRows">${rows.map(rowHtml).join('')||'<p>当前 workspace 还没有项目。</p>'}</div>`;
      panel.querySelector('#portfolioClose').onclick=()=>{panel.hidden=true};
    }catch(error){panel.innerHTML=`<div class="row"><h3>Agency Portfolio</h3><button id="portfolioClose" class="link">关闭</button></div><p>${esc(error.message)}</p>`;panel.querySelector('#portfolioClose').onclick=()=>{panel.hidden=true}}
  }

  async function install(){
    await (window.XHS_STUDIO_READY||Promise.resolve());
    const bar=document.getElementById('hostedBar');if(!bar)return;
    if(document.getElementById('hostedPortfolio'))return;
    const button=document.createElement('button');button.type='button';button.id='hostedPortfolio';button.className='secondary';button.textContent='Portfolio';button.onclick=()=>renderPortfolio();
    const before=document.getElementById('hostedProjectActions');bar.insertBefore(button,before||null);
  }

  window.addEventListener('load',()=>{install().catch(error=>console.error('portfolio init failed',error))});
})();
