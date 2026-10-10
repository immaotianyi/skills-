(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  let currentProjectId='';

  async function request(path){
    const response=await fetch(path),text=await response.text();let data=text;try{data=text?JSON.parse(text):null}catch{}
    if(!response.ok){const error=new Error(data?.error||text||`HTTP ${response.status}`);error.status=response.status;error.code=data?.code;throw error}
    return data;
  }
  function workspaceId(){return String(localStorage.getItem('xhs-studio-workspace')||'')}
  function filename(project){const base=String(project?.name||'xhs-client-digest').replace(/[^A-Za-z0-9\u3400-\u9fff._-]+/gu,'-').replace(/^-+|-+$/gu,'').slice(0,80)||'xhs-client-digest';return `${base}-weekly-digest.md`}
  function downloadText(name,text){const blob=new Blob([text],{type:'text/markdown;charset=utf-8'}),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;a.download=name;document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000)}

  async function loadDigest(projectId){
    const projectPayload=await request(`/api/projects/${encodeURIComponent(projectId)}`),project=projectPayload.project,snapshots=projectPayload.snapshots||[];
    if(!snapshots.length)return{project,digest:null,markdown:'暂无快照。Weekly Digest 需要至少一份可验证快照。\n'};
    const latestMeta=snapshots.at(-1),previousMeta=snapshots.length>=2?snapshots.at(-2):null;
    const tasks=[request(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(latestMeta.id)}`)];
    if(previousMeta)tasks.push(request(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(previousMeta.id)}`));
    const [latestSnapshot,previousSnapshot=null]=await Promise.all(tasks);
    let diff=null;
    if(previousMeta){try{diff=(await request(`/api/projects/${encodeURIComponent(projectId)}/diff`)).diff}catch{diff=null}}
    let branding={};const wid=workspaceId();
    if(wid){try{branding=(await request(`/api/workspaces/${encodeURIComponent(wid)}/branding`)).branding||{}}catch{branding={}}}
    const model=globalThis.XHS_DIGEST_MODEL;if(!model)throw new Error('Digest model is not loaded.');
    const digest=model.buildDigest({project,latestSnapshot,previousSnapshot,diff,branding});
    return{project,digest,markdown:model.digestMarkdown(digest)};
  }

  function summaryHtml(digest){
    if(!digest)return'';
    const alerts=digest.alerts||[],terms=digest.emergingTerms||[];
    return `<div class="metrics"><div><b>${digest.coverage.notes}</b><span>notes</span></div><div><b>${digest.coverage.comments}</b><span>comments</span></div><div><b>${alerts.length}</b><span>attention</span></div><div><b>${terms.length}</b><span>traceable themes</span></div></div>`;
  }

  async function renderDigest(){
    const panel=document.getElementById('hostedPanel');if(!panel)return;
    panel.hidden=false;
    panel.innerHTML='<div class="row"><h3>Weekly Client Digest</h3><button id="digestClose" class="link">关闭</button></div><p>正在生成证据约束摘要…</p>';
    panel.querySelector('#digestClose').onclick=()=>{panel.hidden=true};
    if(!currentProjectId){panel.innerHTML='<div class="row"><h3>Weekly Client Digest</h3><button id="digestClose" class="link">关闭</button></div><p>请先选择项目。</p>';panel.querySelector('#digestClose').onclick=()=>{panel.hidden=true};return}
    try{
      const result=await loadDigest(currentProjectId),digest=result.digest,markdown=result.markdown;
      panel.innerHTML=`<div class="row"><div><span class="eyebrow">CLIENT DELIVERY</span><h3>Weekly Client Digest</h3></div><button id="digestClose" class="link">关闭</button></div><p>基于最近可用快照生成。只报告已采集 evidence 中的计数、观察排名和可回溯主题；不把非代表性样本外推为总体占比。</p>${summaryHtml(digest)}<div class="hostedRow"><button id="digestCopy">复制 Markdown</button><button id="digestDownload" class="secondary">下载 .md</button></div><pre id="digestText">${esc(markdown)}</pre>`;
      panel.querySelector('#digestClose').onclick=()=>{panel.hidden=true};
      panel.querySelector('#digestCopy').onclick=async()=>{await navigator.clipboard.writeText(markdown);panel.querySelector('#digestCopy').textContent='已复制'};
      panel.querySelector('#digestDownload').onclick=()=>downloadText(filename(result.project),markdown);
    }catch(error){panel.innerHTML=`<div class="row"><h3>Weekly Client Digest</h3><button id="digestClose" class="link">关闭</button></div><p>${esc(error.message)}</p>`;panel.querySelector('#digestClose').onclick=()=>{panel.hidden=true}}
  }

  async function install(){
    await (window.XHS_STUDIO_READY||Promise.resolve());
    const bar=document.getElementById('hostedBar');if(!bar||document.getElementById('hostedDigest'))return;
    const button=document.createElement('button');button.type='button';button.id='hostedDigest';button.className='secondary';button.textContent='周报';button.onclick=()=>renderDigest();
    const before=document.getElementById('hostedProjectActions');bar.insertBefore(button,before||null);
  }

  window.addEventListener('xhs:project-opened',event=>{currentProjectId=String(event.detail?.projectId||'')});
  window.addEventListener('load',()=>{install().catch(error=>console.error('digest init failed',error))});
})();
