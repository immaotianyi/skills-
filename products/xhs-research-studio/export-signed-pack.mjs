#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { buildEvidencePack, verifyEvidencePack } from './lib/evidence-pack.mjs';

const args=process.argv.slice(2);
const projectId=args.shift();
const take=name=>{const i=args.indexOf(`--${name}`);if(i<0)return '';const v=args[i+1]||'';args.splice(i,2);return v;};
const base=take('base')||process.env.XHS_STUDIO_URL||'http://127.0.0.1:5418';
const requestedSnapshot=take('snapshot');
const outFile=take('out');

async function get(url){
  const response=await fetch(base+url);
  const text=await response.text();
  if(!response.ok) throw new Error(`${response.status} ${text}`);
  return JSON.parse(text);
}

function usage(){
  process.stdout.write('Usage: node export-signed-pack.mjs PROJECT_ID [--snapshot SNAPSHOT_ID] [--out evidence-pack.json] [--base http://127.0.0.1:5418]\n');
}

try{
  if(!projectId||projectId==='--help'||projectId==='help'){usage();process.exit(projectId?0:1)}
  const projectState=await get(`/api/projects/${encodeURIComponent(projectId)}`);
  const snapshots=projectState.snapshots||[];
  const snapshotId=requestedSnapshot||snapshots.at(-1)?.id;
  if(!snapshotId) throw new Error('project has no snapshots');
  const snapshot=await get(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`);
  if(!snapshot.integrity) throw new Error('snapshot is unsigned; create a new signed snapshot before exporting a signed pack');
  if(snapshot.integrityStatus?.verified!==true) throw new Error('snapshot integrity is not verified');
  const pack=buildEvidencePack(projectState.project,snapshot);
  const verification=verifyEvidencePack(pack);
  if(!verification.ok) throw new Error(`generated pack failed self-verification: ${JSON.stringify(verification.errors)}`);
  const text=JSON.stringify(pack,null,2)+'\n';
  if(outFile){
    await fs.mkdir(path.dirname(path.resolve(outFile)),{recursive:true});
    await fs.writeFile(outFile,text,'utf8');
    process.stdout.write(`${outFile}\n`);
  } else process.stdout.write(text);
}catch(err){
  console.error(`xhs-signed-pack: ${err.message||err}`);
  process.exit(1);
}
