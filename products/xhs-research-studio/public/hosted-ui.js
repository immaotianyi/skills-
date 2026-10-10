(() => {
  const nativeFetch=window.fetch.bind(window);
  let hosted=false;
  let status=null;
  let me=null;
  let workspaceId='';
  let currentProjectId='';
  let resolveReady;
  const ready=new Promise(resolve=>{resolveReady=resolve});
  window.XHS_STUDIO_READY=ready;
  window.XHS_HOSTED_HEADERS=()=>workspaceId?{'x-xhs-workspace-id':workspaceId}:{};

  function sameOriginApi(input){
    try{
      const url=new URL(typeof input==='string'?input:input.url,location.href);
      return url.origin===location.origin&&url.pathname.startsWith('/api/');
    }catch{return false}
  }
  function bypassReady(input){
    try{
      const path=new URL(typeof input==='string'?input:input.url,location.href).pathname;
      return ['/api/health','/api/hosted/status','/api/auth/register','/api/auth/login','/api/auth/logout','/api/billing/webhook'].includes(path)||path.startsWith('/api/shared/');
    }catch{return true}
  }

  window.fetch=async(input,init={})=>{
    if(sameOriginApi(input)&&!bypassReady(input)){
      await ready;
      if(hosted&&workspaceId){
        const headers=new Headers(init.headers||(typeof input!=='string'?input.headers:undefined)||{});
        if(!headers.has('x-xhs-workspace-id'))headers.set('x-xhs-workspace-id',workspaceId);
        init={...init,headers};
      }
    }
    return nativeFetch(input,init);
  };

  const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
  function toast(message){const node=document.getElementById('hostedToast');if(!node)return;node.textContent=message;node.hidden=false;clearTimeout(toast.timer);toast.timer=setTimeout(()=>{node.hidden=true},3500)}

  async function raw(path,options={}){
    const headers=new Headers(options.headers||{});
    if(options.body&&!headers.has('content-type'))headers.set('content-type','application/json');
    if(workspaceId&&!headers.has('x-xhs-workspace-id')&&path.startsWith('/api/'))headers.set('x-xhs-workspace-id',workspaceId);
    const response=await nativeFetch(path,{...options,headers});
    const text=await response.text();let body=text;try{body=text?JSON.parse(text):null}catch{}
    if(!response.ok){const error=new Error(body?.error||text||`HTTP ${response.status}`);error.status=response.status;error.code=body?.code;throw error}
    return {response,body};
  }
  const post=(path,body)=>raw(path,{method:'POST',body:JSON.stringify(body||{})});

  function authGate(){
    let gate=document.getElementById('hostedAuthGate');
    if(gate)return gate;
    gate=document.createElement('div');gate.id='hostedAuthGate';
    gate.innerHTML=`<div id="hostedAuthCard"><span class="eyebrow">HOSTED PAID BETA</span><h2>登录 Research Studio</h2><p>托管模式下，项目、运行、用量和客户分享按 workspace 隔离。</p><div class="authTabs"><button type="button" id="authLoginTab">登录</button><button type="button" id="authRegisterTab" class="secondary">注册</button></div><form id="hostedAuthForm"><input name="email" type="email" autocomplete="email" placeholder="邮箱" required><input name="password" type="password" autocomplete="current-password" minlength="12" placeholder="密码（至少 12 位）" required><input name="workspaceName" placeholder="Workspace 名称（注册时）" hidden><button id="authSubmit">登录</button></form><div id="hostedAuthError"></div></div>`;
    document.body.appendChild(gate);
    let mode='login';const form=gate.querySelector('#hostedAuthForm'),workspace=form.elements.workspaceName,submit=gate.querySelector('#authSubmit'),error=gate.querySelector('#hostedAuthError');
    const setMode=next=>{mode=next;workspace.hidden=next!=='register';submit.textContent=next==='register'?'注册并创建 Workspace':'登录';error.textContent='';gate.querySelector('#authLoginTab').className=next==='login'?'':'secondary';gate.querySelector('#authRegisterTab').className=next==='register'?'':'secondary'};
    gate.querySelector('#authLoginTab').onclick=()=>setMode('login');gate.querySelector('#authRegisterTab').onclick=()=>setMode('register');
    form.onsubmit=async event=>{event.preventDefault();error.textContent='';const data=new FormData(form);try{await post(`/api/auth/${mode}`,{email:data.get('email'),password:data.get('password'),workspaceName:data.get('workspaceName')});me=(await raw('/api/me')).body;gate.hidden=true;selectWorkspace();renderHostedBar();renderPanel();resolveReady()}catch(err){error.textContent=err.message}};
    return gate;
  }

  function selectWorkspace(){
    const workspaces=me?.workspaces||[];
    const preferred=localStorage.getItem('xhs-studio-workspace')||'';
    workspaceId=workspaces.some(w=>w.id===preferred)?preferred:(workspaces[0]?.id||'');
    if(workspaceId)localStorage.setItem('xhs-studio-workspace',workspaceId);
  }
  function activeWorkspace(){return (me?.workspaces||[]).find(w=>w.id===workspaceId)||null}
  function roleCanManage(){return ['owner','admin'].includes(activeWorkspace()?.role)}
  function roleCanWrite(){return ['owner','admin','analyst'].includes(activeWorkspace()?.role)}

  function ensureShell(){
    if(document.getElementById('hostedBar'))return;
    document.body.insertAdjacentHTML('afterbegin',`<div id="hostedBar"><strong>Hosted</strong><select id="hostedWorkspace"></select><small id="hostedPlan"></small><span class="hostedGrow"></span><button type="button" id="hostedProjectActions" class="secondary">项目操作</button><button type="button" id="hostedAccount" class="secondary">账户 / 团队</button><button type="button" id="hostedLogout" class="secondary">退出</button></div><div id="hostedPanel" hidden></div><div id="hostedToast" hidden></div>`);
    document.getElementById('hostedPanel').addEventListener('click',event=>event.stopPropagation());
    document.getElementById('hostedAccount').onclick=()=>{const p=document.getElementById('hostedPanel');p.hidden=!p.hidden;if(!p.hidden)renderPanel()};
    document.getElementById('hostedProjectActions').onclick=()=>{const p=document.getElementById('hostedPanel');p.hidden=false;renderProjectActions()};
    document.getElementById('hostedLogout').onclick=async()=>{try{await post('/api/auth/logout',{})}finally{localStorage.removeItem('xhs-studio-workspace');location.reload()}};
  }
  function renderHostedBar(){
    ensureShell();const select=document.getElementById('hostedWorkspace');
    select.innerHTML=(me?.workspaces||[]).map(w=>`<option value="${esc(w.id)}" ${w.id===workspaceId?'selected':''}>${esc(w.name)} · ${esc(w.role)}</option>`).join('');
    select.onchange=()=>{localStorage.setItem('xhs-studio-workspace',select.value);location.reload()};
    const ws=activeWorkspace(),ent=ws?.entitlement||{};document.getElementById('hostedPlan').textContent=`${ent.plan||'unpaid'} · ${ent.status||'inactive'} · runs ${ws?.usage?.runs||0}/${ent.maxRunsMonth||0}`;
  }

  async function billingCheckout(){const plan=document.getElementById('hostedPlanSelect')?.value;if(!plan)return;const result=(await post(`/api/workspaces/${workspaceId}/billing/checkout`,{plan})).body;if(result.url)location.href=result.url}
  async function billingPortal(){const result=(await post(`/api/workspaces/${workspaceId}/billing/portal`,{})).body;if(result.url)location.href=result.url}
  async function invite(){const email=document.getElementById('hostedInviteEmail')?.value,role=document.getElementById('hostedInviteRole')?.value;const result=(await post(`/api/workspaces/${workspaceId}/invitations`,{email,role})).body;await navigator.clipboard.writeText(result.invitation.url);toast('邀请链接已复制');await renderPanel()}

  async function renderPanel(){
    const panel=document.getElementById('hostedPanel');if(!panel)return;const ws=activeWorkspace(),ent=ws?.entitlement||{},plans=status?.billing?.plans||[],configuredPlans=plans.filter(p=>p.configured);
    panel.innerHTML=`<div class="row"><h3>Workspace</h3><button id="hostedClose" class="link">关闭</button></div><p><b>${esc(ws?.name||'')}</b> · ${esc(ws?.role||'')}</p><p>套餐：${esc(ent.plan||'unpaid')} / ${esc(ent.status||'inactive')}<br>项目上限 ${Number(ent.maxProjects||0)} · 月运行 ${Number(ws?.usage?.runs||0)}/${Number(ent.maxRunsMonth||0)}</p><div class="hostedRow"><select id="hostedPlanSelect">${configuredPlans.map(p=>`<option value="${esc(p.id)}">${esc(p.label)} · ${p.maxProjects} projects / ${p.maxRunsMonth} runs</option>`).join('')}</select><button id="hostedCheckout" ${configuredPlans.length?'':'disabled'}>订阅 / 更换套餐</button>${ent.providerCustomerId?'<button id="hostedPortal" class="secondary">发票 / 取消订阅</button>':''}</div>${!configuredPlans.length?'<p><small>当前部署尚未配置可购买的 Stripe Price。</small></p>':''}${roleCanManage()?`<hr><h4>邀请成员</h4><div class="hostedRow"><input id="hostedInviteEmail" type="email" placeholder="成员邮箱"><select id="hostedInviteRole"><option value="analyst">analyst</option><option value="viewer">viewer</option><option value="admin">admin</option></select><button id="hostedInvite">创建邀请</button></div><div id="hostedMembers">加载成员…</div>`:''}`;
    panel.hidden=false;document.getElementById('hostedClose').onclick=()=>{panel.hidden=true};
    const checkout=document.getElementById('hostedCheckout');if(checkout)checkout.onclick=()=>billingCheckout().catch(err=>toast(err.message));
    const portal=document.getElementById('hostedPortal');if(portal)portal.onclick=()=>billingPortal().catch(err=>toast(err.message));
    const inviteBtn=document.getElementById('hostedInvite');if(inviteBtn)inviteBtn.onclick=()=>invite().catch(err=>toast(err.message));
    if(roleCanManage()){
      try{const {body}=await raw(`/api/workspaces/${workspaceId}/members`);const node=document.getElementById('hostedMembers');if(node)node.innerHTML=`<h4>成员</h4>${body.members.map(m=>`<div>${esc(m.email)} · ${esc(m.role)}</div>`).join('')}`}catch(err){toast(err.message)}
    }
  }

  async function generateSynthesis(){if(!currentProjectId)return;const panel=document.getElementById('hostedPanel');panel.hidden=false;panel.innerHTML='<h3>Grounded synthesis</h3><p>正在生成并校验证据引用…</p>';try{const {body}=await post(`/api/projects/${currentProjectId}/synthesis`,{}),s=body.synthesis;panel.innerHTML=`<div class="row"><h3>${esc(s.title)}</h3><button id="hostedClose" class="link">关闭</button></div>${s.claims.map(c=>`<p><b>${esc(c.type)}</b> ${esc(c.text)}<br><small>${c.evidenceIds.map(esc).join(' · ')}</small></p>`).join('')}<h4>反证</h4>${(s.counterEvidence||[]).map(c=>`<p>${esc(c.text)}<br><small>${c.evidenceIds.map(esc).join(' · ')}</small></p>`).join('')||'<p>本次输出未列出反证；仍需人工回看原始证据。</p>'}<h4>限制</h4><ul>${s.limitations.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`;document.getElementById('hostedClose').onclick=()=>{panel.hidden=true}}catch(err){panel.innerHTML=`<h3>Grounded synthesis</h3><p>${esc(err.message)}</p>`}}
  async function createShare(){if(!currentProjectId)return;try{const {body}=await post(`/api/workspaces/${workspaceId}/shares`,{projectId:currentProjectId});await navigator.clipboard.writeText(body.share.url);toast('只读客户分享链接已复制')}catch(err){toast(err.message)}}
  function renderProjectActions(){const panel=document.getElementById('hostedPanel');panel.hidden=false;panel.innerHTML=`<div class="row"><h3>项目交付</h3><button id="hostedClose" class="link">关闭</button></div><p>${currentProjectId?'当前项目已选择':'请先选择项目。'}</p><div class="hostedRow"><button id="hostedSynthesis" ${!currentProjectId||!roleCanWrite()?'disabled':''}>生成 Grounded Synthesis</button><button id="hostedShare" class="secondary" ${!currentProjectId||!roleCanWrite()?'disabled':''}>创建只读分享</button></div>`;document.getElementById('hostedClose').onclick=()=>{panel.hidden=true};document.getElementById('hostedSynthesis').onclick=generateSynthesis;document.getElementById('hostedShare').onclick=createShare}

  async function authenticatedDownload(url){
    const headers=window.XHS_HOSTED_HEADERS();const response=await nativeFetch(url,{headers});if(!response.ok)throw new Error((await response.text())||`HTTP ${response.status}`);const blob=await response.blob(),href=URL.createObjectURL(blob),a=document.createElement('a');a.href=href;const cd=response.headers.get('content-disposition')||'',match=cd.match(/filename="?([^";]+)"?/iu);a.download=match?.[1]||'xhs-export';document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);
  }

  window.addEventListener('xhs:project-opened',event=>{currentProjectId=event.detail?.projectId||''});
  window.addEventListener('load',()=>{
    document.addEventListener('click',event=>{
      if(!hosted)return;
      const button=event.target.closest?.('#csvBtn,#packBtn');if(!button||!currentProjectId)return;
      event.preventDefault();event.stopImmediatePropagation();const url=button.id==='csvBtn'?`/api/projects/${currentProjectId}/export.csv`:`/api/projects/${currentProjectId}/evidence-pack?version=1.2`;authenticatedDownload(url).catch(err=>toast(err.message));
    },true);
  });

  async function init(){
    try{
      const healthResponse=await nativeFetch('/api/health');
      if(!healthResponse.ok){resolveReady();return}
      const health=await healthResponse.json();
      if(health?.hosted!==true){resolveReady();return}
      const response=await nativeFetch('/api/hosted/status');
      if(!response.ok)throw new Error(`Hosted status failed: HTTP ${response.status}`);
      status=await response.json();if(!status?.hosted){resolveReady();return}hosted=true;ensureShell();
      const meResponse=await nativeFetch('/api/me');
      if(meResponse.ok){me=await meResponse.json();selectWorkspace();renderHostedBar();resolveReady();return}
      if(meResponse.status!==401)throw new Error(`Hosted session check failed: HTTP ${meResponse.status}`);
      authGate().hidden=false;
    }catch(error){console.error(error);toast(`Hosted 初始化失败：${error.message}`);resolveReady()}
  }
  init();
})();
