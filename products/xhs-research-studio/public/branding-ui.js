(() => {
  const HEX_RE=/^#[0-9a-f]{6}$/iu;
  const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

  async function request(path,{method='GET',body}={}){
    const options={method,headers:{}};
    if(body!==undefined){options.body=JSON.stringify(body);options.headers['content-type']='application/json'}
    const response=await fetch(path,options),text=await response.text();let data=text;try{data=text?JSON.parse(text):null}catch{}
    if(!response.ok){const error=new Error(data?.error||text||`HTTP ${response.status}`);error.status=response.status;error.code=data?.code;throw error}
    return data;
  }

  function workspaceId(){return String(localStorage.getItem('xhs-studio-workspace')||'')}
  function roleOf(me,id){return (me?.workspaces||[]).find(workspace=>workspace.id===id)?.role||''}
  function safeAccent(value){return HEX_RE.test(String(value||''))?String(value).toLowerCase():'#171717'}

  function previewHtml(branding={}){
    const accent=safeAccent(branding.accentColor);
    return `<div id="brandingPreview" class="card" style="border-top:4px solid ${accent}"><span class="eyebrow">${esc(branding.agencyName||'AGENCY')}</span><h4 style="color:${accent}">${esc(branding.reportTitle||'Client Research Report')}</h4><p>示例客户项目 · 证据与方法边界保持不变</p>${branding.footerText?`<small>${esc(branding.footerText)}</small>`:''}</div>`;
  }

  async function renderBranding(){
    const panel=document.getElementById('hostedPanel');if(!panel)return;
    const id=workspaceId();if(!id){panel.hidden=false;panel.innerHTML='<p>当前没有 workspace。</p>';return}
    panel.hidden=false;panel.innerHTML='<div class="row"><h3>客户报告品牌</h3><button id="brandingClose" class="link">关闭</button></div><p>正在加载…</p>';
    panel.querySelector('#brandingClose').onclick=()=>{panel.hidden=true};
    try{
      const [me,result]=await Promise.all([request('/api/me'),request(`/api/workspaces/${encodeURIComponent(id)}/branding`)]);
      const role=roleOf(me,id),canManage=['owner','admin'].includes(role),branding=result.branding||{};
      panel.innerHTML=`<div class="row"><div><span class="eyebrow">WHITE LABEL</span><h3>客户报告品牌</h3></div><button id="brandingClose" class="link">关闭</button></div><p>品牌只影响客户报告外观；不会隐藏来源、证据质量、方法限制或访问安全边界。远程 logo / 自定义 HTML / CSS 在当前 beta 中禁用。</p>${previewHtml(branding)}${canManage?`<form id="brandingForm"><label>机构 / Agency 名称</label><input name="agencyName" maxlength="120" value="${esc(branding.agencyName||'')}"><label>报告标题</label><input name="reportTitle" maxlength="160" value="${esc(branding.reportTitle||'')}"><label>强调色（#RRGGBB）</label><input name="accentColor" maxlength="7" pattern="#[0-9A-Fa-f]{6}" value="${esc(safeAccent(branding.accentColor))}"><label>页脚</label><input name="footerText" maxlength="300" value="${esc(branding.footerText||'')}"><button>保存品牌设置</button><div id="brandingStatus"></div></form>`:`<p><small>当前角色 ${esc(role||'unknown')}：可查看品牌设置，只有 owner/admin 可以修改。</small></p>`}`;
      panel.querySelector('#brandingClose').onclick=()=>{panel.hidden=true};
      const form=panel.querySelector('#brandingForm');
      if(form)form.onsubmit=async event=>{
        event.preventDefault();const data=new FormData(form),accent=String(data.get('accentColor')||'').trim();const status=panel.querySelector('#brandingStatus');
        if(!HEX_RE.test(accent)){status.textContent='强调色必须是 #RRGGBB。';return}
        status.textContent='保存中…';
        try{
          const saved=await request(`/api/workspaces/${encodeURIComponent(id)}/branding`,{method:'PATCH',body:{agencyName:data.get('agencyName'),reportTitle:data.get('reportTitle'),accentColor:accent,footerText:data.get('footerText')}});
          status.textContent='已保存。';const preview=panel.querySelector('#brandingPreview');if(preview)preview.outerHTML=previewHtml(saved.branding||{});
        }catch(error){status.textContent=error.message}
      };
    }catch(error){panel.innerHTML=`<div class="row"><h3>客户报告品牌</h3><button id="brandingClose" class="link">关闭</button></div><p>${esc(error.message)}</p>`;panel.querySelector('#brandingClose').onclick=()=>{panel.hidden=true}}
  }

  async function install(){
    await (window.XHS_STUDIO_READY||Promise.resolve());
    const bar=document.getElementById('hostedBar');if(!bar||document.getElementById('hostedBranding'))return;
    const button=document.createElement('button');button.type='button';button.id='hostedBranding';button.className='secondary';button.textContent='品牌';button.onclick=()=>renderBranding();
    const before=document.getElementById('hostedProjectActions');bar.insertBefore(button,before||null);
  }

  window.addEventListener('load',()=>{install().catch(error=>console.error('branding init failed',error))});
})();
