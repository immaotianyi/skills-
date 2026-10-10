#!/usr/bin/env node
import { promises as fs } from 'node:fs';

const chunks=[];
for await (const chunk of process.stdin)chunks.push(chunk);
const plan=JSON.parse(Buffer.concat(chunks).toString('utf8'));
if(plan?.safety?.bypassCaptcha!==false||plan?.safety?.bypassLogin!==false||plan?.safety?.onBlockedState!=='manual_action_required'){
  console.error('unsafe plan');
  process.exit(7);
}
if(!plan?.project?.id||!plan?.runId){console.error('missing plan identity');process.exit(8)}

const mode=String(process.env.XHS_EXECUTOR_MODE||'success');
if(mode==='hang')setTimeout(()=>{},60_000);
else if(mode==='manual'){
  process.stdout.write(JSON.stringify({status:'manual_action_required',reason:'CAPTCHA presented; user interaction required.',riskState:'CAPTCHA',gaps:['comments unavailable until user resolves CAPTCHA']})+'\n');
}else if(mode==='unsafe-harvest'){
  const file=process.env.XHS_EXECUTOR_FIXTURE_PATH;
  const harvest=JSON.parse(await fs.readFile(file,'utf8'));
  harvest.meta={...(harvest.meta||{}),riskState:'LOGIN_REQUIRED',loginRequired:true,stoppedBecause:'Login is required.'};
  process.stdout.write(JSON.stringify({status:'completed',harvest})+'\n');
}else if(mode==='huge'){
  process.stdout.write(JSON.stringify({status:'completed',harvest:{padding:'x'.repeat(200_000)}}));
}else{
  const file=process.env.XHS_EXECUTOR_FIXTURE_PATH;
  if(!file){console.error('missing fixture');process.exit(9)}
  const harvest=JSON.parse(await fs.readFile(file,'utf8'));
  process.stdout.write(JSON.stringify({status:'completed',harvest})+'\n');
}
