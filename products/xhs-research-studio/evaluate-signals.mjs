#!/usr/bin/env node
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { evaluateSignalClassifier } from './lib/evaluation.mjs';

const args=process.argv.slice(2);
const input=args.shift();
const take=name=>{const i=args.indexOf(`--${name}`);if(i<0)return '';const v=args[i+1]||'';args.splice(i,2);return v;};
const outFile=take('out');

function usage(){
  process.stdout.write('Usage: node evaluate-signals.mjs LABELS.json|LABELS.jsonl [--out report.json]\n');
  process.stdout.write('Each record: {"id":"...","content":"...","labels":{"questions":false,"complaints":true,"purchaseIntent":false,"positive":false},"reviewer":"reviewer-id","category":"optional","sourceRef":"optional"}\n');
}

async function loadRecords(file){
  const text=await fs.readFile(file,'utf8');
  if(file.toLowerCase().endsWith('.jsonl')){
    return text.split(/\r?\n/u).map(x=>x.trim()).filter(Boolean).map((line,i)=>{
      try{return JSON.parse(line)}catch(err){throw new Error(`invalid JSONL at line ${i+1}: ${err.message}`)}
    });
  }
  const parsed=JSON.parse(text);
  if(!Array.isArray(parsed)) throw new Error('JSON evaluation corpus must be an array');
  return parsed;
}

try{
  if(!input||input==='--help'||input==='help'){usage();process.exit(input?0:1)}
  const result=evaluateSignalClassifier(await loadRecords(input));
  const text=JSON.stringify(result,null,2)+'\n';
  if(outFile){
    await fs.mkdir(path.dirname(path.resolve(outFile)),{recursive:true});
    await fs.writeFile(outFile,text,'utf8');
    process.stdout.write(`${outFile}\n`);
  } else process.stdout.write(text);
} catch(err){
  console.error(`xhs-signal-eval: ${err.message||err}`);
  process.exit(1);
}
