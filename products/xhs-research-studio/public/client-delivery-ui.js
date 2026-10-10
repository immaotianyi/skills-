import { buildClientDeliveryCsv, buildEvidenceDelivery, buildClientDeliveryHtml, clientDeliveryFilename } from './client-delivery-model.js';

let currentProjectId='';
const esc=value=>String(value??'').replace(/[&<>"']/gu,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));

async function read(path,{type='json'}={}){
  const response=await fetch(path);
  if(!response.ok)throw new Error((await response.text())||`HTTP ${response.status}`);
  return{response,body:type==='text'?await response.text():await response.json()};
}
function workspaceId(){return String(localStorage.getItem('xhs-studio-workspace')||'')}
function download(content,type,filename){
  const blob=new Blob([content],{type}),href=URL.createObjectURL(blob),link=document.createElement('a');
  link.href=href;link.download=filename;document.body.appendChild(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1500);
}
async function context(){
  if(!currentProjectId)throw new Error('请先选择项目。');
  const id=workspaceId();if(!id)throw new Error('当前没有 workspace。');
  const projectResult=await read(`/api/projects/${encodeURIComponent(currentProjectId)}`),snapshots=projectResult.body.snapshots||[],latest=snapshots.at(-1);
  if(!latest)throw new Error('当前项目还没有快照。');
  const [snapshotResult,brandingResult,reportResult]=await Promise.all([
    read(`/api/projects/${encodeURIComponent(currentProjectId)}/snapshots/${encodeURIComponent(latest.id)}`),
    read(`/api/workspaces/${encodeURIComponent(id)}/branding`),
    read(`/api/projects/${encodeURIComponent(currentProjectId)}/report`,{type:'text'}),
  ]);
  return{project:projectResult.body.project,snapshot:snapshotResult.body,branding:brandingResult.body.branding||{},markdown:reportResult.body};
}

function status(text,isError=false){const node=document.getElementById('clientDeliveryStatus');if(node){node.textContent=text;node.dataset.error=isError?'1':'0'}}

async function downloadCsv(){
  status('正在生成品牌化 CSV…');
  try{const c=await context(),csv=buildClientDeliveryCsv(c);download(csv,'text/csv;charset=utf-8',clientDeliveryFilename(c.project,'client-evidence.csv'));status('品牌化 CSV 已生成。')}catch(error){status(error.message,true)}
}
async function downloadEvidenceDelivery(){
  status('正在生成 Evidence Delivery…');
  try{
    const c=await context(),packResult=await read(`/api/projects/${encodeURIComponent(currentProjectId)}/evidence-pack?version=1.2`),authenticated=packResult.response.headers.get('x-xhs-evidence-pack-authenticated')==='true';
    const delivery=buildEvidenceDelivery({...c,evidencePack:packResult.body,verification:{ok:true,authenticated,checksumOnly:!authenticated&&packResult.body?.integrity?.algorithm==='sha256'}});
    download(JSON.stringify(delivery,null,2)+'\n','application/json;charset=utf-8',clientDeliveryFilename(c.project,'client-evidence.json'));
    status(`Evidence Delivery 已生成；canonical pack ${authenticated?'已认证':'未认证/仅校验和'}。`);
  }catch(error){status(error.message,true)}
}
async function downloadPrintHtml(){
  status('正在生成打印 / PDF HTML…');
  try{const c=await context(),html=buildClientDeliveryHtml(c);download(html,'text/html;charset=utf-8',clientDeliveryFilename(c.project,'client-report.html'));status('打印版 HTML 已生成；打开后可打印或另存为 PDF。')}catch(error){status(error.message,true)}
}

async function render(){
  const panel=document.getElementById('hostedPanel');if(!panel)return;
  panel.hidden=false;
  if(!currentProjectId){panel.innerHTML='<div class="row"><h3>客户交付</h3><button id="clientDeliveryClose" class="link">关闭</button></div><p>请先选择一个项目。</p>';panel.querySelector('#clientDeliveryClose').onclick=()=>{panel.hidden=true};return}
  panel.innerHTML=`<div class="row"><div><span class="eyebrow">CLIENT DELIVERY</span><h3>品牌化客户交付</h3></div><button id="clientDeliveryClose" class="link">关闭</button></div><p>原始 CSV 与 canonical Evidence Pack 保持不变。这里生成的是独立交付层：品牌信息不会改写来源、capture method、confidence、Evidence Pack integrity 或方法限制。</p><div class="hostedRow"><button id="clientDeliveryCsv">品牌化 CSV</button><button id="clientDeliveryEvidence" class="secondary">Evidence Delivery JSON</button><button id="clientDeliveryPrint" class="secondary">打印 / PDF HTML</button></div><div id="clientDeliveryStatus"></div><p><small>Evidence Delivery 的外层品牌 envelope 明确不声明认证；其内嵌 canonical Evidence Pack 保持服务器原样，并单独标注 pack 的认证状态。</small></p>`;
  panel.querySelector('#clientDeliveryClose').onclick=()=>{panel.hidden=true};
  panel.querySelector('#clientDeliveryCsv').onclick=downloadCsv;
  panel.querySelector('#clientDeliveryEvidence').onclick=downloadEvidenceDelivery;
  panel.querySelector('#clientDeliveryPrint').onclick=downloadPrintHtml;
}

async function install(){
  await (window.XHS_STUDIO_READY||Promise.resolve());
  const bar=document.getElementById('hostedBar');if(!bar||document.getElementById('hostedClientDelivery'))return;
  const button=document.createElement('button');button.type='button';button.id='hostedClientDelivery';button.className='secondary';button.textContent='客户交付';button.onclick=()=>render();
  const before=document.getElementById('hostedProjectActions');bar.insertBefore(button,before||null);
}

window.addEventListener('xhs:project-opened',event=>{currentProjectId=String(event.detail?.projectId||'')});
window.addEventListener('load',()=>{install().catch(error=>console.error('client delivery init failed',error))});
