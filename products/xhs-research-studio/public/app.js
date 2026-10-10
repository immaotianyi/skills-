let current = null;
let currentSnapshot = null;
let currentReport = '';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];

async function api(url, opts = {}) {
  const response = await fetch(url, {
    headers: {'content-type':'application/json', ...(opts.headers || {})},
    ...opts,
  });
  const text = await response.text();
  if (!response.ok) {
    let message = text;
    try {
      const parsed = JSON.parse(text);
      message = parsed.error || text;
      if (parsed.details?.length) message += ` (${parsed.details.map(x => `${x.path}: ${x.message}`).join('; ')})`;
    } catch {}
    throw new Error(message);
  }
  return (response.headers.get('content-type') || '').includes('json') ? JSON.parse(text) : text;
}

function lines(value) {
  return String(value || '').split(/\n|,/u).map(x => x.trim()).filter(Boolean);
}

function esc(value = '') {
  return String(value).replace(/[&<>"']/g, char => ({
    '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'
  }[char]));
}

function sourceLink(url, label='source') {
  return url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(label)}</a>` : '—';
}

async function loadTemplates() {
  const {templates} = await api('/api/templates');
  $('#templates').innerHTML = templates.map(t => `<button type="button" class="template" title="${esc(t.description)}">${esc(t.name)}</button>`).join('');
  $$('.template').forEach((button, index) => {
    button.onclick = () => {
      const template = templates[index];
      const form = $('#projectForm');
      form.elements.name.value = template.name;
      form.elements.keywords.value = template.keywords.join('\n');
      form.elements.competitors.value = template.competitors.join('\n');
    };
  });
}

async function loadProjects() {
  const {projects} = await api('/api/projects');
  const box = $('#projects');
  box.innerHTML = '';
  for (const project of projects) {
    const row = document.createElement('div');
    row.className = 'projectItem';
    row.innerHTML = `<strong>${esc(project.name)}</strong><span>${esc(project.category || project.client || '未分类')}</span>`;
    row.onclick = () => openProject(project.id);
    box.appendChild(row);
  }
}

$('#projectForm').onsubmit = async event => {
  event.preventDefault();
  const form = new FormData(event.target);
  const project = await api('/api/projects', {
    method:'POST',
    body:JSON.stringify({
      name:form.get('name'),
      client:form.get('client'),
      category:form.get('category'),
      keywords:lines(form.get('keywords')),
      competitors:lines(form.get('competitors')),
    }),
  });
  event.target.reset();
  await loadProjects();
  await openProject(project.id);
};

$('#refreshBtn').onclick = loadProjects;

$$('.tabs button').forEach(button => {
  button.onclick = () => {
    $$('.tabs button').forEach(x => x.classList.toggle('active', x === button));
    $$('.tab').forEach(x => x.classList.toggle('active', x.id === button.dataset.tab));
    if (button.dataset.tab === 'report') loadReport();
  };
});

async function openProject(id) {
  current = await api(`/api/projects/${id}`);
  $('#empty').hidden = true;
  $('#projectView').hidden = false;
  $('#projectName').textContent = current.project.name;
  $('#projectMeta').textContent = [current.project.client,current.project.category].filter(Boolean).join(' · ') || 'PROJECT';
  const snapshots = current.snapshots || [];
  if (!snapshots.length) {
    currentSnapshot = null;
    renderEmpty();
    return;
  }
  currentSnapshot = await api(`/api/projects/${id}/snapshots/${snapshots.at(-1).id}`);
  render(currentSnapshot.analysis,currentSnapshot.harvest);
  if (snapshots.length >= 2) await loadAttention();
  else renderQualityAttention(currentSnapshot.analysis);
}

function renderEmpty() {
  $('#metrics').innerHTML = '<div class="card">还没有快照。进入「导入数据」粘贴 Harvest JSON。</div>';
  $('#signals').innerHTML = '';
  $('#terms').innerHTML = '';
  $('#topNotes').innerHTML = '';
  $('#evidenceTable').innerHTML = '';
  $('#rankTable').innerHTML = '暂无排名数据';
  $('#clusterList').innerHTML = '';
  $('#clusterEvidence').innerHTML = '';
  $('#attention').innerHTML = '<p>等待第一份快照。</p>';
}

function renderQualityAttention(analysis) {
  const quality = analysis?.quality;
  if (!quality) {
    $('#attention').innerHTML = '<p>当前只有一个快照；再导入一次即可自动识别变化。</p>';
    return;
  }
  if (!quality.warnings?.length) {
    $('#attention').innerHTML = '<p>当前证据质量检查没有发现显著警告；再导入一次即可自动识别变化。</p>';
    return;
  }
  $('#attention').innerHTML = quality.warnings.map(warning => `<div class="attention ${quality.status === 'blocked' ? 'high' : 'medium'}"><b>证据质量提醒</b><span>${esc(warning)}</span></div>`).join('');
}

function render(analysis, harvest) {
  const quality = analysis.quality || {score:'—',status:'unknown',warnings:[]};
  const metrics = [
    ['笔记',analysis.coverage.notes],
    ['评论',analysis.coverage.comments],
    ['作者',analysis.coverage.authors],
    ['数据缺口',analysis.coverage.gaps.length],
    ['证据质量',`${quality.score}/100`],
  ];
  $('#metrics').innerHTML = metrics.map(([key,value]) => `<div class="metric"><b>${esc(value)}</b><span>${esc(key)}</span></div>`).join('');

  const labels = {questions:'问题/追问',complaints:'抱怨/风险',purchaseIntent:'购买意图',positive:'正向'};
  $('#signals').innerHTML = Object.entries(analysis.signals).map(([key,value]) => `<div class="signal"><span>${labels[key] || esc(key)}</span><b>${value.count}</b></div>`).join('');
  $('#terms').innerHTML = analysis.topCommentTerms.map(x => `<span class="chip">${esc(x.term)} · ${x.count}</span>`).join('');

  $('#topNotes').innerHTML = analysis.topNotes.slice(0,12).map(note => `
    <div class="note">
      <div>
        <b>${esc(note.title || note.noteId)}</b>
        <small>${esc(note.author?.nickname || 'unknown')} · 👍 ${note.stats.likes} · ⭐ ${note.stats.collects} · 💬 ${note.stats.comments}${note.sourceUrl ? ` · ${sourceLink(note.sourceUrl)}` : ''}</small>
      </div>
      <div class="score" title="透明审阅排序分数，不是商业价值预测">${note.engagementScore}</div>
    </div>`).join('');

  const rows = harvest.notes.slice(0,100).map(note => `
    <tr>
      <td>${esc(note.title || note.noteId)}</td>
      <td>${esc(note.author?.nickname || '')}</td>
      <td>${note.stats.likes}</td>
      <td>${note.stats.comments}</td>
      <td>${esc(note.captureMethod)}</td>
      <td>${Number(note.confidence ?? 0).toFixed(2)}</td>
      <td>${sourceLink(note.sourceUrl,'打开')}</td>
    </tr>`).join('');
  $('#evidenceTable').innerHTML = `<table><thead><tr><th>笔记</th><th>作者</th><th>赞</th><th>评</th><th>采集</th><th>置信</th><th>来源</th></tr></thead><tbody>${rows}</tbody></table>`;

  renderRanks(analysis.rankings);
  renderClusters(analysis.evidenceClusters || []);
}

function renderRanks(rankings) {
  const groups = Object.entries(rankings?.byKeyword || {});
  if (!groups.length) {
    $('#rankTable').innerHTML = '<p>当前快照没有 queries[].rankingPosition 数据。</p>';
    return;
  }
  $('#rankTable').innerHTML = groups.map(([keyword,rows]) => `
    <h4>${esc(keyword)}</h4>
    <table><thead><tr><th>观察排名</th><th>笔记</th><th>作者</th></tr></thead><tbody>
      ${rows.slice(0,20).map(row => `<tr><td>#${row.rankingPosition}</td><td>${row.sourceUrl ? sourceLink(row.sourceUrl,row.title || row.noteId) : esc(row.title || row.noteId)}</td><td>${esc(row.author || '')}</td></tr>`).join('')}
    </tbody></table>`).join('');
}

function renderClusters(clusters) {
  $('#clusterList').innerHTML = clusters.map((cluster,index) => `<button class="clusterBtn" data-i="${index}" title="词法重复证据组，不是语义 embedding 聚类">${esc(cluster.term)} · ${cluster.count}</button>`).join('');
  $$('.clusterBtn').forEach((button,index) => button.onclick = () => showCluster(clusters[index]));
  if (clusters[0]) showCluster(clusters[0]);
}

function showCluster(cluster) {
  $('#clusterEvidence').innerHTML = `
    <h4>${esc(cluster.term)} 的原始证据</h4>
    <p><small>方法：${esc(cluster.method || 'lexical evidence grouping')}</small></p>
    ${cluster.comments.map(comment => `<blockquote><b>${esc(comment.user || '匿名')}</b> · 👍 ${comment.likes}<br>${esc(comment.content)}</blockquote>`).join('')}
    ${cluster.notes.length ? '<h4>对应笔记</h4>' + cluster.notes.map(note => `<div class="note"><div><b>${esc(note.title || note.noteId)}</b><small>${esc(note.author?.nickname || '')}${note.sourceUrl ? ` · ${sourceLink(note.sourceUrl)}` : ''}</small></div></div>`).join('') : ''}`;
}

function fallbackAttention(diff) {
  const items=[];
  const complaintDelta=diff.after.signals.complaints.count-diff.before.signals.complaints.count;
  if(complaintDelta>=2) items.push({level:complaintDelta>=5?'high':'medium',title:`抱怨信号增加 ${complaintDelta} 条`,detail:`${diff.before.signals.complaints.count} → ${diff.after.signals.complaints.count}`});
  for(const rank of diff.rankings.changed.filter(x=>x.delta<=-3).slice(0,6)) items.push({level:Math.abs(rank.delta)>=5?'high':'medium',title:`搜索排名下跌：${rank.keyword}`,detail:`${rank.title||rank.noteId} #${rank.before} → #${rank.after}`});
  if(diff.after.coverage.riskState&&diff.after.coverage.riskState!=='NORMAL') items.unshift({level:'high',title:`采集状态：${diff.after.coverage.riskState}`,detail:'先处理数据覆盖/门禁问题，再解释趋势。'});
  return items;
}

function localizedAlert(alert) {
  const titles = {
    'complaint-growth':'抱怨信号增加',
    'rank-drop':'搜索排名下跌',
    'fast-mover':'内容加速增长',
    'new-high-signal-note':'新出现高信号笔记',
    'capture-risk':'采集状态异常',
  };
  return {...alert,title:titles[alert.type] || alert.title};
}

async function loadAttention() {
  if (!current) return;
  try {
    const {diff} = await api(`/api/projects/${current.project.id}/diff`);
    const items = (diff.alerts?.length ? diff.alerts : fallbackAttention(diff)).map(localizedAlert);
    $('#attention').innerHTML = items.length
      ? items.map(item => `<div class="attention ${esc(item.level)}"><b>${esc(item.title)}</b><span>${esc(item.detail)}</span></div>`).join('')
      : '<p>最近两次快照没有达到阈值的异常变化。</p>';
  } catch {
    $('#attention').innerHTML = '<p>需要至少两个快照。</p>';
  }
}

$('#fileInput').onchange = async event => {
  const file = event.target.files[0];
  if (file) $('#jsonInput').value = await file.text();
};

$('#ingestBtn').onclick = async () => {
  if (!current) return;
  try {
    const raw = JSON.parse($('#jsonInput').value);
    $('#ingestStatus').textContent = '正在校验、分析并保存…';
    currentSnapshot = await api(`/api/projects/${current.project.id}/ingest`, {method:'POST',body:JSON.stringify(raw)});
    const warnings = currentSnapshot.validation?.inputWarnings?.length || currentSnapshot.validation?.warnings?.length || 0;
    $('#ingestStatus').textContent = `已保存快照 ${currentSnapshot.id}${warnings ? ` · ${warnings} 个校验提醒` : ''}`;
    render(currentSnapshot.analysis,currentSnapshot.harvest);
    current = await api(`/api/projects/${current.project.id}`);
    if ((current.snapshots || []).length >= 2) await loadAttention();
    else renderQualityAttention(currentSnapshot.analysis);
  } catch (error) {
    $('#ingestStatus').textContent = `失败：${error.message}`;
  }
};

$('#diffBtn').onclick = async () => {
  if (!current) return;
  try {
    const {diff} = await api(`/api/projects/${current.project.id}/diff`);
    $('#diffCard').hidden = false;
    $('#diff').innerHTML = `
      <p>当前样本新增笔记 <b>${diff.addedNotes.length}</b> · 之前观察到但本次未出现 <b>${diff.notObservedNotes?.length ?? diff.removedNotes.length}</b></p>
      <h4>增长最快</h4>
      ${diff.topMovers.slice(0,8).map(x=>`<div class="signal"><span>${esc(x.title||x.noteId)}</span><b class="${x.score>=0?'deltaUp':'deltaDown'}">${x.score>=0?'+':''}${x.score}</b></div>`).join('')}
      <h4>上升主题</h4>
      ${diff.themeDelta.filter(x=>x.delta>0).slice(0,10).map(x=>`<span class="chip">${esc(x.term)} +${x.delta}</span>`).join(' ')}`;
  } catch {
    $('#diffCard').hidden = false;
    $('#diff').textContent = '需要至少两个快照才能对比。';
  }
};

$('#rankDiffBtn').onclick = async () => {
  if (!current) return;
  try {
    const {diff} = await api(`/api/projects/${current.project.id}/diff`);
    const ranks = diff.rankings;
    $('#rankDiff').innerHTML = `
      <h4>观察排名变化</h4>
      ${ranks.changed.slice(0,20).map(x=>`<div class="signal"><span>${esc(x.keyword)} · ${esc(x.title||x.noteId)} · #${x.before} → #${x.after}</span><b class="${x.delta>0?'deltaUp':'deltaDown'}">${x.delta>0?'↑':'↓'}${Math.abs(x.delta)}</b></div>`).join('') || '<p>没有检测到相同结果的排名变化。</p>'}
      <h4>新观察到</h4>
      ${ranks.entered.slice(0,12).map(x=>`<span class="chip">${esc(x.keyword)} #${x.rankingPosition} ${esc(x.title||x.noteId)}</span>`).join(' ') || '—'}`;
  } catch {
    $('#rankDiff').textContent = '需要至少两个带排名数据的快照。';
  }
};

async function loadReport() {
  if (!current || !currentSnapshot) {
    $('#reportText').textContent = '暂无快照';
    return;
  }
  currentReport = await api(`/api/projects/${current.project.id}/report`);
  $('#reportText').textContent = currentReport;
}

$('#csvBtn').onclick = () => {
  if (current) location.href = `/api/projects/${current.project.id}/export.csv`;
};

$('#packBtn').onclick = () => {
  if (current) location.href = `/api/projects/${current.project.id}/evidence-pack`;
};

$('#copyReport').onclick = async () => {
  await navigator.clipboard.writeText(currentReport || $('#reportText').textContent);
  $('#copyReport').textContent = '已复制';
  setTimeout(() => $('#copyReport').textContent = '复制 Markdown',1200);
};

$('#printReport').onclick = async () => {
  await loadReport();
  window.print();
};

$('#planBtn').onclick = async () => {
  if (!current) return;
  const {plan} = await api(`/api/projects/${current.project.id}/plan`);
  await navigator.clipboard.writeText(plan);
  $('#planBtn').textContent = '已复制 Harvest 计划';
  setTimeout(() => $('#planBtn').textContent = '复制 Harvest 计划',1500);
};

$('#demoBtn').onclick = async () => {
  let projects = (await api('/api/projects')).projects;
  let project = projects.find(x => x.name === 'Demo · 敏感肌防晒');
  if (!project) {
    project = await api('/api/projects', {
      method:'POST',
      body:JSON.stringify({
        name:'Demo · 敏感肌防晒',
        client:'Demo Brand',
        category:'护肤/防晒',
        keywords:['敏感肌防晒','防晒辣眼睛','防晒搓泥'],
        competitors:['A品牌','B品牌','C品牌'],
      }),
    });
  }
  const demo = await fetch('/demo-harvest.json').then(r => r.json());
  await api(`/api/projects/${project.id}/ingest`, {method:'POST',body:JSON.stringify(demo)});
  await loadProjects();
  await openProject(project.id);
};

Promise.all([loadProjects(),loadTemplates()]).catch(error => {
  console.error(error);
});
