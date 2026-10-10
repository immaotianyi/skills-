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
  process.stdout.write('Usage: XHS_STUDIO_PACK_INTEGRITY_KEY=<32+ byte secret> node export-signed-pack.mjs PROJECT_ID [--snapshot SNAPSHOT_ID] [--out evidence-pack.json] [--base http://127.0.0.1:5418]\n');
  process.stdout.write('The source Studio must also use XHS_STUDIO_INTEGRITY_KEY so the selected snapshot is authenticated, not checksum-only.\n');
}

function packIntegrityOptions(){
  const key=String(process.env.XHS_STUDIO_PACK_INTEGRITY_KEY||'');
  if(!key) throw new Error('XHS_STUDIO_PACK_INTEGRITY_KEY is required for a signed Evidence Pack');
  if(Buffer.byteLength(key,'utf8')<32) throw new Error('XHS_STUDIO_PACK_INTEGRITY_KEY must be at least 32 UTF-8 bytes');
  return {key,keyId:String(process.env.XHS_STUDIO_PACK_INTEGRITY_KEY_ID||'pack-v1')};
}

try{
  if(!projectId||projectId==='--help'||projectId==='help'){usage();process.exit(projectId?0:1)}
  const projectState=await get(`/api/projects/${encodeURIComponent(projectId)}`);
  const snapshots=projectState.snapshots||[];
  const snapshotId=requestedSnapshot||snapshots.at(-1)?.id;
  if(!snapshotId) throw new Error('project has no snapshots');
  const snapshot=await get(`/api/projects/${encodeURIComponent(projectId)}/snapshots/${encodeURIComponent(snapshotId)}`);
  if(!snapshot.integrity) throw new Error('snapshot is unsigned; create a new authenticated snapshot before exporting a signed pack');
  if(snapshot.integrityStatus?.verified!==true) throw new Error('snapshot integrity is not verified');
  if(snapshot.integrityStatus?.authenticated!==true) throw new Error('snapshot is checksum-only; configure XHS_STUDIO_INTEGRITY_KEY and ingest a new snapshot before signed export');
  const options=packIntegrityOptions();
  const pack=buildEvidencePack(projectState.project,snapshot,options);
  const verification=verifyEvidencePack(pack,options);
  if(!verification.ok||!verification.authenticated) throw new Error(`generated pack failed authenticated self-verification: ${JSON.stringify(verification.errors)}`);
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
