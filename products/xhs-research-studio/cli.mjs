#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';

const args=process.argv.slice(2);
const command=args.shift();
const take=name=>{const i=args.indexOf(`--${name}`);if(i<0)return '';const v=args[i+1]||'';args.splice(i,2);return v;};
const base=take('base')||process.env.XHS_STUDIO_URL||'http://127.0.0.1:5418';

async function request(urlPath,opts={}) {
  const response=await fetch(base+urlPath,{headers:{'content-type':'application/json',...(opts.headers||{})},...opts});
  const text=await response.text();
  if(!response.ok) {
    let message=text;
    try {
      const parsed=JSON.parse(text);
      message=parsed.error||text;
      if(parsed.details?.length) message+=` (${parsed.details.map(x=>`${x.path}: ${x.message}`).join('; ')})`;
    } catch {}
    throw new Error(`${response.status} ${message}`);
  }
  return {
    value:(response.headers.get('content-type')||'').includes('json')?JSON.parse(text):text,
    headers:response.headers,
  };
}
function list(v){return String(v||'').split(',').map(x=>x.trim()).filter(Boolean)}
function out(v){process.stdout.write(typeof v==='string'?v:JSON.stringify(v,null,2)+'\n')}
async function writeOrStdout(value,file=''){
  const text=typeof value==='string'?value:JSON.stringify(value,null,2)+'\n';
  if(!file){process.stdout.write(text);return}
  await fs.mkdir(path.dirname(path.resolve(file)),{recursive:true});
  await fs.writeFile(file,text,'utf8');
  process.stdout.write(`${file}\n`);
}
function usage(){out(`XHS Research Studio CLI\n\nCommands:\n  health\n  projects\n  validate HARVEST.json\n  analyze HARVEST.json\n  create --name NAME [--client NAME] [--category NAME] [--keywords a,b] [--competitors a,b]\n  plan PROJECT_ID\n  ingest PROJECT_ID HARVEST.json\n  report PROJECT_ID [--out report.md]\n  diff PROJECT_ID\n  ranks PROJECT_ID\n  evidence PROJECT_ID [--term TERM]\n  pack PROJECT_ID [--version 1.1|1.2] [--require-authenticated 1] [--out evidence-pack.json]\n  csv PROJECT_ID [--out evidence.csv]\n\nOptions:\n  --base http://127.0.0.1:5418\n  or XHS_STUDIO_URL environment variable\n`)}

async function fileJson(file){
  if(!file)throw new Error('HARVEST.json is required');
  try{return JSON.parse(await fs.readFile(file,'utf8'))}
  catch(err){throw new Error(`cannot read/parse ${file}: ${err.message}`)}
}

async function main(){
  if(!command||command==='help'||command==='--help'){usage();return}
  if(command==='health'){out((await request('/api/health')).value);return}
  if(command==='projects'){out((await request('/api/projects')).value);return}
  if(command==='validate'){
    const raw=await fileJson(args.shift());
    out((await request('/api/validate',{method:'POST',body:JSON.stringify(raw)})).value);return;
  }
  if(command==='analyze'){
    const raw=await fileJson(args.shift());
    out((await request('/api/analyze',{method:'POST',body:JSON.stringify(raw)})).value);return;
  }
  if(command==='create'){
    const body={name:take('name'),client:take('client'),category:take('category'),keywords:list(take('keywords')),competitors:list(take('competitors'))};
    if(!body.name)throw new Error('--name is required');
    out((await request('/api/projects',{method:'POST',body:JSON.stringify(body)})).value);return;
  }
  const projectId=args.shift();
  if(!projectId)throw new Error('PROJECT_ID is required');
  if(command==='plan'){out((await request(`/api/projects/${projectId}/plan`)).value.plan);return}
  if(command==='ingest'){
    const raw=await fileJson(args.shift());
    out((await request(`/api/projects/${projectId}/ingest`,{method:'POST',body:JSON.stringify(raw)})).value);return;
  }
  if(command==='report'){
    const file=take('out');
    await writeOrStdout((await request(`/api/projects/${projectId}/report`)).value,file);return;
  }
  if(command==='diff'){out((await request(`/api/projects/${projectId}/diff`)).value);return}
  if(command==='ranks'){out((await request(`/api/projects/${projectId}/ranks`)).value);return}
  if(command==='evidence'){
    const term=take('term');
    out((await request(`/api/projects/${projectId}/evidence${term?`?term=${encodeURIComponent(term)}`:''}`)).value);return;
  }
  if(command==='pack'){
    const file=take('out');
    const version=take('version');
    const requireAuthenticated=take('require-authenticated');
    const params=new URLSearchParams();
    if(version)params.set('version',version);
    if(requireAuthenticated)params.set('requireAuthenticated',requireAuthenticated);
    const query=params.size?`?${params.toString()}`:'';
    await writeOrStdout((await request(`/api/projects/${projectId}/evidence-pack${query}`)).value,file);return;
  }
  if(command==='csv'){
    const file=take('out');
    await writeOrStdout((await request(`/api/projects/${projectId}/export.csv`)).value,file);return;
  }
  throw new Error(`unknown command: ${command}`);
}

main().catch(err=>{console.error(`xhs-studio: ${err.message||err}`);process.exit(1)});
