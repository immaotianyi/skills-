#!/usr/bin/env node
const chunks=[];
for await(const chunk of process.stdin)chunks.push(chunk);
const payload=JSON.parse(Buffer.concat(chunks).toString('utf8'));
const evidence=payload?.input?.evidence||[];
const firstComment=evidence.find(item=>item.kind==='comment')||evidence[0];
const firstNote=evidence.find(item=>item.kind==='note')||evidence[0];
if(!firstComment||!firstNote){console.error('no evidence');process.exit(9)}
const document={
  title:'CI grounded synthesis',
  claims:[
    {id:'c1',type:'fact',text:'观测样本包含需要进一步核查的问题信号。',evidenceIds:[firstComment.id]},
    {id:'c2',type:'recommendation',text:'后续研究应回到原始笔记与评论核查该信号。',evidenceIds:[firstNote.id]},
  ],
  counterEvidence:[],
  limitations:['该输出基于有边界的观测样本，不代表整体用户群体。'],
};
process.stdout.write(JSON.stringify(document));
