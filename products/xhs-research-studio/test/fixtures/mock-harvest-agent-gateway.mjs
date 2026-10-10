#!/usr/bin/env node
import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const fixture=JSON.parse(await fs.readFile(path.join(root,'public','demo-harvest.json'),'utf8'));
const port=Number(process.env.XHS_AGENT_GATEWAY_PORT||55421);

async function readJson(req){const chunks=[];for await(const chunk of req)chunks.push(chunk);return JSON.parse(Buffer.concat(chunks).toString('utf8'))}
function send(res,status,body){res.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});res.end(JSON.stringify(body))}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='POST'||req.url!=='/jobs')return send(res,404,{error:'not found'});
    if(req.headers['x-xhs-agent-bridge']!=='1.0')return send(res,400,{error:'missing agent bridge version'});
    const job=await readJson(req);
    if(job?.schemaVersion!=='xhs-authorized-browser-agent-job/1.0')return send(res,400,{error:'bad job schema'});
    if(job?.skill?.id!=='xiaohongshu-harvest'||!String(job?.skill?.prompt||'').includes('window.__INITIAL_STATE__'))return send(res,400,{error:'Harvest skill prompt missing'});
    if(!Array.isArray(job?.plan?.project?.keywords)||!Array.isArray(job?.plan?.project?.competitors))return send(res,400,{error:'project research plan missing'});
    if(job?.plan?.safety?.bypassCaptcha!==false||job?.plan?.safety?.bypassLogin!==false)return send(res,400,{error:'unsafe plan'});
    const mode=String(process.env.XHS_AGENT_GATEWAY_MODE||'success');
    if(mode==='manual')return send(res,200,{status:'manual_action_required',reason:'Mock authorized browser requires operator login.',riskState:'LOGIN_REQUIRED',gaps:['Search results require login.']});
    return send(res,200,{status:'completed',harvest:fixture});
  }catch(error){return send(res,500,{error:error.message})}
});
server.listen(port,'127.0.0.1',()=>console.error(`mock Harvest agent gateway listening on 127.0.0.1:${port}`));
for(const signal of ['SIGTERM','SIGINT'])process.once(signal,()=>server.close(()=>process.exit(0)));
