(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  let currentProject=null;

  async function request(path,{method='GET',body}={}){
    const options={method,headers:{}};
    if(body!==undefined){options.body=JSON.stringify(body);options.headers['content-type']='application/json'}
    const response=await fetch(path,options),text=await response.text();let data=text;try{data=text?JSON.parse(text):null}catch{}
    if(!response.ok){const error=new Error(data?.error||text||`HTTP ${response.status}`);error.status=response.status;error.code=data?.code;throw error}
    return data;
  }
  function workspaceId(){return String(localStorage.getItem('xhs-studio-workspace')||'')}
  function roleOf(me,id){return (me?.workspaces||[]).find(workspace=>workspace.id===id)?.role||''}
  function canWrite(role){return ['owner','admin','analyst'].includes(role)}
  function form(){return document.querySelector('#projectForm')}

  function applyTemplate(template){
    const target=form();if(!target)return;
    target.elements.name.value=template.name||'';
    target.elements.client.value='';
    target.elements.category.value=template.category||'';
    target.elements.keywords.value=(template.keywords||[]).join('\n');
    target.elements.competitors.value=(template.competitors||[]).join('\n');
    target.elements.name.focus();
  }

  async function waitBuiltIns(){for(let i=0;i<80;i++){if(document.querySelector('#templates .template'))return;await new Promise(resolve=>setTimeout(resolve,25))}}
  async function loadTemplates(){
    const id=workspaceId();if(!id)return[];
    return (await request(`/api/workspaces/${encodeURIComponent(id)}/templates`)).templates||[];
  }
  async function renderSavedButtons(){
    await waitBuiltIns();const box=document.querySelector('#templates');if(!box)return[];
    box.querySelectorAll('.savedTemplate').forEach(node=>node.remove());
    const templates=await loadTemplates();
    for(const template of templates){
      const button=document.createElement('button');button.type='button';button.className='template savedTemplate';button.dataset.templateId=template.id;button.title=template.description||'Workspace saved template';button.textContent=`★ ${template.name}`;button.onclick=()=>applyTemplate(template);box.appendChild(button);
    }
    return templates;
  }

  async function renderLibrary(){
    const panel=document.querySelector('#hostedPanel');if(!panel)return;
    const id=workspaceId();panel.hidden=false;panel.innerHTML='<div class="row"><h3>Workspace 模板库</h3><button id="savedTemplateClose" class="link">关闭</button></div><p>正在加载…</p>';panel.querySelector('#savedTemplateClose').onclick=()=>{panel.hidden=true};
    try{
      const [me,templates]=await Promise.all([request('/api/me'),loadTemplates()]),role=roleOf(me,id),writable=canWrite(role);
      const list=templates.length?templates.map(template=>`<div class="card"><div class="row"><div><b>${esc(template.name)}</b><br><small>${esc(template.category||'未分类')} · ${(template.keywords||[]).length} keywords · ${(template.competitors||[]).length} competitors</small></div>${writable?`<button class="link savedTemplateDelete" data-template-id="${esc(template.id)}">删除</button>`:''}</div>${template.description?`<p>${esc(template.description)}</p>`:''}</div>`).join(''):'<p>还没有 workspace 自定义模板。</p>';
      const create=currentProject&&writable?`<section class="card"><h4>把当前项目保存为模板</h4><p><small>只保存品类、keywords、competitors；不会保存 client、快照、评论、凭证或运行数据。</small></p><label>模板名</label><input id="savedTemplateName" maxlength="120" value="${esc(`${currentProject.name} 模板`)}"><label>说明（可选）</label><input id="savedTemplateDescription" maxlength="300" value=""><button id="savedTemplateCreate">保存当前研究配置</button><div id="savedTemplateStatus"></div></section>`:currentProject?`<p><small>当前角色 ${esc(role||'unknown')}：可以使用模板，但不能保存或删除。</small></p>`:'<p><small>先打开一个项目，才能把当前研究配置保存为模板。</small></p>';
      panel.innerHTML=`<div class="row"><div><span class="eyebrow">REUSABLE RESEARCH SETUP</span><h3>Workspace 模板库</h3></div><button id="savedTemplateClose" class="link">关闭</button></div>${create}<h4>已保存模板</h4><div id="savedTemplateLibrary">${list}</div>`;
      panel.querySelector('#savedTemplateClose').onclick=()=>{panel.hidden=true};
      const createButton=panel.querySelector('#savedTemplateCreate');
      if(createButton)createButton.onclick=async()=>{
        const status=panel.querySelector('#savedTemplateStatus'),name=panel.querySelector('#savedTemplateName').value,description=panel.querySelector('#savedTemplateDescription').value;status.textContent='保存中…';
        try{
          await request(`/api/workspaces/${encodeURIComponent(id)}/templates`,{method:'POST',body:{name,description,category:currentProject.category||'',keywords:currentProject.keywords||[],competitors:currentProject.competitors||[]}});
          await renderSavedButtons();await renderLibrary();
        }catch(error){status.textContent=error.message}
      };
      panel.querySelectorAll('.savedTemplateDelete').forEach(button=>button.onclick=async()=>{
        button.disabled=true;
        try{await request(`/api/workspaces/${encodeURIComponent(id)}/templates/${encodeURIComponent(button.dataset.templateId)}`,{method:'DELETE'});await renderSavedButtons();await renderLibrary()}catch(error){button.disabled=false;button.textContent=error.message}
      });
    }catch(error){panel.innerHTML=`<div class="row"><h3>Workspace 模板库</h3><button id="savedTemplateClose" class="link">关闭</button></div><p>${esc(error.message)}</p>`;panel.querySelector('#savedTemplateClose').onclick=()=>{panel.hidden=true}}
  }

  async function install(){
    await (window.XHS_STUDIO_READY||Promise.resolve());
    const bar=document.querySelector('#hostedBar');if(!bar||document.querySelector('#hostedTemplates'))return;
    const button=document.createElement('button');button.type='button';button.id='hostedTemplates';button.className='secondary';button.textContent='模板库';button.onclick=()=>renderLibrary();
    const before=document.querySelector('#hostedProjectActions');bar.insertBefore(button,before||null);
    await renderSavedButtons();
  }

  window.addEventListener('xhs:project-opened',event=>{currentProject=event.detail?.project||null});
  window.addEventListener('load',()=>{install().catch(error=>console.error('saved templates init failed',error))});
})();
