#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const args=process.argv.slice(2);
const command=args.shift();
const take=name=>{const i=args.indexOf(`--${name}`);if(i<0)return '';const v=args[i+1]||'';args.splice(i,2);return v;};
const base=take('base')||process.env.XHS_STUDIO_URL||'http://127.0.0.1:5418';

async function request(path,opts={}) {
  const r=await fetch(base+path,{headers:{'content-type':'application/json'},...opts});
  const text=await r.text();
  if(!r.ok) throw new Error(`${r.status} ${text}`);
  return (r.headers.get('content-type')||'').includes('json') ? JSON.parse(text) : text;
}
function list(v){return String(v||'').split(',').map(x=>x.trim()).filter(Boolean)}
function out(v){process.stdout.write(typeof v==='string'?v:JSON.stringify(v,null,2)+'\n')}
function usage(){out(`XHS Research Studio CLI\n\nCommands:\n  health\n  projects\n  create --name NAME [--client NAME] [--category NAME] [--keywords a,b] [--competitors a,b]\n  plan PROJECT_ID\n  ingest PROJECT_ID HARVEST.json\n  report PROJECT_ID\n  diff PROJECT_ID\n  ranks PROJECT_ID\n  evidence PROJECT_ID [--term TERM]\n\nOptions:\n  --base http://127.0.0.1:5418\n  or XHS_STUDIO_URL environment variable\n`)}

try {
  if(!command||command==='help'||command==='--help'){usage();process.exit(0)}
  if(command==='health') return out(await request('/api/health'));
  if(command==='projects') return out(await request('/api/projects'));
  if(command==='create') {
    const body={name:take('name'),client:take('client'),category:take('category'),keywords:list(take('keywords')),competitors:list(take('competitors'))};
    if(!body.name) throw new Error('--name is required');
    return out(await request('/api/projects',{method:'POST',body:JSON.stringify(body)}));
  }
  const projectId=args.shift();
  if(!projectId) throw new Error('PROJECT_ID is required');
  if(command==='plan') return out((await request(`/api/projects/${projectId}/plan`)).plan);
  if(command==='ingest') {
    const file=args.shift(); if(!file) throw new Error('HARVEST.json is required');
    const raw=JSON.parse(await fs.readFile(file,'utf8'));
    return out(await request(`/api/projects/${projectId}/ingest`,{method:'POST',body:JSON.stringify(raw)}));
  }
  if(command==='report') return out(await request(`/api/projects/${projectId}/report`));
  if(command==='diff') return out(await request(`/api/projects/${projectId}/diff`));
  if(command==='ranks') return out(await request(`/api/projects/${projectId}/ranks`));
  if(command==='evidence') {
    const term=take('term');
    return out(await request(`/api/projects/${projectId}/evidence${term?`?term=${encodeURIComponent(term)}`:''}`));
  }
  throw new Error(`unknown command: ${command}`);
} catch(err) {
  console.error(`xhs-studio: ${err.message||err}`);
  process.exit(1);
}
