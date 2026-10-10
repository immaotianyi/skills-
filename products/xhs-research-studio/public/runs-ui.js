(() => {
  let projectId = '';
  let refreshTimer = null;

  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));

  async function request(path, options={}) {
    const response = await fetch(path, {
      headers:{'content-type':'application/json', ...(options.headers || {})},
      ...options,
    });
    const text = await response.text();
    let body = text;
    try { body = text ? JSON.parse(text) : null; } catch {}
    if (!response.ok) throw new Error(body?.error || text || `HTTP ${response.status}`);
    return body;
  }

  function statusMessage(message, isError=false) {
    const node=$('runStatusMessage');
    if(!node) return;
    node.textContent=message || '';
    node.className=isError?'attention high':'';
  }

  function budget() {
    return {
      maxNotes:Number($('runBudgetNotes')?.value || 80),
      maxComments:Number($('runBudgetComments')?.value || 2000),
      maxSeconds:Number($('runBudgetSeconds')?.value || 300),
    };
  }

  function formatTime(value) {
    const date=new Date(value || '');
    return Number.isFinite(date.getTime()) ? date.toLocaleString() : '—';
  }

  function stateLabel(state) {
    return ({
      queued:'排队中', running:'执行中', manual_action_required:'需要人工接管',
      completed:'已完成', failed:'失败', cancelled:'已取消',
    })[state] || state || '未知';
  }

  function renderSystem(system) {
    const node=$('runSystemStatus');
    if(!node) return;
    node.innerHTML=system.executorConfigured
      ? '<span class="chip">自动执行器：已配置</span><span class="chip">安全门禁：启用</span>'
      : '<span class="chip">自动执行器：未配置</span><p>启动 run 后会安全进入“需要人工接管”，不会伪造采集成功。可继续使用「导入数据」完成授权/人工采集后的入库。</p>';
  }

  function runActions(run) {
    const buttons=[];
    if(['queued','running'].includes(run.state)) buttons.push(`<button class="secondary runAction" data-action="cancel" data-run="${esc(run.id)}">取消</button>`);
    if(['manual_action_required','failed'].includes(run.state)) {
      buttons.push(`<button class="secondary runAction" data-action="resume" data-run="${esc(run.id)}">重新执行</button>`);
      buttons.push(`<button class="secondary runAction" data-action="cancel" data-run="${esc(run.id)}">关闭</button>`);
    }
    return buttons.join(' ');
  }

  function renderRuns(runs) {
    const node=$('runList');
    if(!node) return;
    if(!runs.length){node.innerHTML='<p>还没有采集运行。</p>';return}
    node.innerHTML=[...runs].reverse().slice(0,30).map(run=>`
      <div class="note">
        <div>
          <b>${esc(stateLabel(run.state))}</b>
          <small>${esc(run.trigger || 'manual')} · ${formatTime(run.createdAt)} · notes ${Number(run.counts?.notes||0)} / comments ${Number(run.counts?.comments||0)}</small>
          ${run.riskState && run.riskState!=='NORMAL' ? `<small>风险状态：${esc(run.riskState)}</small>` : ''}
          ${run.stoppedBecause ? `<small>${esc(run.stoppedBecause)}</small>` : ''}
          ${run.error?.message ? `<small>错误：${esc(run.error.message)}</small>` : ''}
          ${run.snapshotId ? `<small>快照：${esc(run.snapshotId)}</small>` : ''}
        </div>
        <div>${runActions(run)}</div>
      </div>`).join('');
    node.querySelectorAll('.runAction').forEach(button=>{
      button.addEventListener('click',()=>runAction(button.dataset.action,button.dataset.run));
    });
  }

  function scheduleActions(schedule) {
    return `
      <button class="secondary scheduleAction" data-action="toggle" data-schedule="${esc(schedule.id)}" data-enabled="${schedule.enabled?'1':'0'}">${schedule.enabled?'停用':'启用'}</button>
      <button class="secondary scheduleAction" data-action="run-now" data-schedule="${esc(schedule.id)}">立即运行</button>`;
  }

  function renderSchedules(schedules) {
    const node=$('scheduleList');
    if(!node) return;
    if(!schedules.length){node.innerHTML='<p>还没有计划任务。</p>';return}
    node.innerHTML=schedules.map(schedule=>`
      <div class="note">
        <div>
          <b>${schedule.enabled?'已启用':'已停用'} · 每 ${Number(schedule.intervalMinutes)} 分钟</b>
          <small>下次：${formatTime(schedule.nextRunAt)}</small>
          <small>上次：${esc(schedule.lastRunState || '尚未运行')}${schedule.lastRunAt?` · ${formatTime(schedule.lastRunAt)}`:''}</small>
          ${schedule.lastError ? `<small>上次错误：${esc(schedule.lastError)}</small>` : ''}
        </div>
        <div>${scheduleActions(schedule)}</div>
      </div>`).join('');
    node.querySelectorAll('.scheduleAction').forEach(button=>{
      button.addEventListener('click',()=>scheduleAction(button.dataset.action,button.dataset.schedule,button.dataset.enabled==='1'));
    });
  }

  function pollIfNeeded(runs) {
    if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null}
    if(runs.some(run=>['queued','running'].includes(run.state)) && projectId){
      refreshTimer=setTimeout(()=>refresh().catch(()=>{}),1000);
    }
  }

  async function refresh() {
    if(!projectId) return;
    const expected=projectId;
    const [runData,scheduleData]=await Promise.all([
      request(`/api/projects/${encodeURIComponent(expected)}/runs`),
      request(`/api/projects/${encodeURIComponent(expected)}/schedules`),
    ]);
    if(expected!==projectId) return;
    renderSystem(runData.system || {});
    renderRuns(runData.runs || []);
    renderSchedules(scheduleData.schedules || []);
    pollIfNeeded(runData.runs || []);
  }

  async function startRun() {
    if(!projectId) return;
    statusMessage('正在创建采集运行…');
    try{
      await request(`/api/projects/${encodeURIComponent(projectId)}/runs`,{method:'POST',body:JSON.stringify({budget:budget()})});
      statusMessage('运行已创建。');
      await refresh();
    }catch(error){statusMessage(`启动失败：${error.message}`,true)}
  }

  async function runAction(action, runId) {
    if(!projectId||!runId) return;
    try{
      const endpoint=action==='resume'?'resume':'cancel';
      await request(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/${endpoint}`,{method:'POST',body:'{}'});
      statusMessage(action==='resume'?'已重新排队。':'已提交取消。');
      await refresh();
    }catch(error){statusMessage(`操作失败：${error.message}`,true)}
  }

  async function createSchedule() {
    if(!projectId) return;
    const intervalMinutes=Number($('scheduleInterval')?.value || 1440);
    const localStart=$('scheduleStartAt')?.value || '';
    const body={intervalMinutes,budget:budget()};
    if(localStart){
      const date=new Date(localStart);
      if(!Number.isFinite(date.getTime())){statusMessage('计划开始时间无效。',true);return}
      body.startAt=date.toISOString();
    }
    try{
      await request(`/api/projects/${encodeURIComponent(projectId)}/schedules`,{method:'POST',body:JSON.stringify(body)});
      statusMessage('计划任务已创建。');
      await refresh();
    }catch(error){statusMessage(`创建计划失败：${error.message}`,true)}
  }

  async function scheduleAction(action,scheduleId,enabled) {
    if(!projectId||!scheduleId) return;
    try{
      if(action==='toggle'){
        await request(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}`,{method:'PATCH',body:JSON.stringify({enabled:!enabled})});
      } else {
        await request(`/api/projects/${encodeURIComponent(projectId)}/schedules/${encodeURIComponent(scheduleId)}/run-now`,{method:'POST',body:'{}'});
      }
      statusMessage(action==='toggle'?'计划状态已更新。':'已触发一次运行。');
      await refresh();
    }catch(error){statusMessage(`计划操作失败：${error.message}`,true)}
  }

  $('runStartBtn')?.addEventListener('click',startRun);
  $('runRefreshBtn')?.addEventListener('click',()=>refresh().catch(error=>statusMessage(`刷新失败：${error.message}`,true)));
  $('scheduleCreateBtn')?.addEventListener('click',createSchedule);

  window.addEventListener('xhs:project-opened',event=>{
    projectId=String(event.detail?.projectId||'');
    if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=null}
    statusMessage('');
    refresh().catch(error=>statusMessage(`加载运行状态失败：${error.message}`,true));
  });
})();
