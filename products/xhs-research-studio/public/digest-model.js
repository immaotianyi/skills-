((root) => {
  const text=(value,max=500)=>String(value??'').replace(/[\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,max);
  const md=value=>text(value).replace(/([\\`*_{}\[\]()#+\-.!<>])/gu,'\\$1');
  const httpUrl=value=>{try{const url=new URL(String(value||''));return ['http:','https:'].includes(url.protocol)?url.href:''}catch{return''}};
  const unique=values=>[...new Set(values.filter(Boolean))];
  const iso=value=>{const ms=Date.parse(String(value||''));return Number.isFinite(ms)?new Date(ms).toISOString():null};
  const evidenceId=item=>text(item?.id||item?.commentId||item?.noteId,160);

  function evidenceForTerm(analysis,term){
    const cluster=(analysis?.evidenceClusters||[]).find(item=>item?.term===term);
    if(!cluster)return null;
    const commentIds=unique((cluster.comments||[]).map(evidenceId)).slice(0,8);
    const noteIds=unique((cluster.notes||[]).map(evidenceId)).slice(0,8);
    const sourceUrls=unique((cluster.notes||[]).map(note=>httpUrl(note?.sourceUrl))).slice(0,6);
    const ids=unique([...commentIds,...noteIds]);
    return ids.length?{term:text(term,120),count:Number(cluster.count||0),evidenceIds:ids,sourceUrls}:null;
  }

  function safeAlerts(diff){
    return (diff?.alerts||[]).slice(0,8).map(alert=>({
      level:['high','medium','low'].includes(String(alert?.level))?String(alert.level):'medium',
      type:text(alert?.type||'attention',80),
      title:text(alert?.title||'Attention required',240),
      detail:text(alert?.detail||'',500),
    }));
  }

  function rankChanges(diff){
    return (diff?.rankings?.changed||[]).slice(0,8).map(row=>({
      keyword:text(row?.keyword,120),noteId:text(row?.noteId,160),title:text(row?.title||row?.noteId,240),
      before:Number(row?.before||0),after:Number(row?.after||0),delta:Number(row?.delta||0),sourceUrl:httpUrl(row?.sourceUrl),
    }));
  }

  function signalCounts(analysis){
    const signals=analysis?.signals||{};
    return Object.fromEntries(['questions','complaints','purchaseIntent','positive'].map(key=>[key,Number(signals?.[key]?.count||0)]));
  }

  function emergingTerms(diff,analysis){
    return (diff?.themeDelta||[]).filter(item=>Number(item?.delta)>0).slice(0,12)
      .map(item=>({item,evidence:evidenceForTerm(analysis,item?.term)}))
      .filter(row=>row.evidence)
      .slice(0,6)
      .map(({item,evidence})=>({...evidence,before:Number(item.before||0),after:Number(item.after||0),delta:Number(item.delta||0)}));
  }

  function newNotes(diff){
    return (diff?.addedNotes||[]).slice(0,6).map(note=>({
      noteId:text(note?.noteId,160),title:text(note?.title||note?.noteId,240),sourceUrl:httpUrl(note?.sourceUrl),
    })).filter(note=>note.noteId);
  }

  function buildDigest({project={},latestSnapshot=null,previousSnapshot=null,diff=null,branding={},generatedAt=new Date().toISOString()}={}){
    if(!project?.id)throw new TypeError('project is required');
    const analysis=latestSnapshot?.analysis||null;
    const previousAnalysis=previousSnapshot?.analysis||diff?.before||null;
    const latestAt=iso(latestSnapshot?.createdAt||latestSnapshot?.harvest?.source?.capturedAt);
    const previousAt=iso(previousSnapshot?.createdAt||previousSnapshot?.harvest?.source?.capturedAt||diff?.from);
    const quality=analysis?.quality?{
      status:text(analysis.quality.status||'unknown',40),score:Number.isFinite(Number(analysis.quality.score))?Number(analysis.quality.score):null,
      warnings:(analysis.quality.warnings||[]).slice(0,6).map(value=>text(value,300)),
    }:null;
    const coverage=analysis?.coverage?{
      notes:Number(analysis.coverage.notes||0),comments:Number(analysis.coverage.comments||0),authors:Number(analysis.coverage.authors||0),
      gaps:Array.isArray(analysis.coverage.gaps)?analysis.coverage.gaps.length:0,riskState:text(analysis.coverage.riskState||'NORMAL',80),
    }:{notes:0,comments:0,authors:0,gaps:0,riskState:'UNKNOWN'};
    const digest={
      schemaVersion:'xhs-client-digest/1.0',generatedAt:iso(generatedAt)||new Date().toISOString(),
      project:{id:text(project.id,160),name:text(project.name||project.id,200),client:text(project.client||'',160),category:text(project.category||'',160)},
      branding:{agencyName:text(branding?.agencyName||'',120),reportTitle:text(branding?.reportTitle||'',160),footerText:text(branding?.footerText||'',300)},
      period:{from:previousAt,to:latestAt},quality,coverage,
      observedSignals:{before:signalCounts(previousAnalysis),after:signalCounts(analysis)},
      alerts:safeAlerts(diff),rankChanges:rankChanges(diff),emergingTerms:emergingTerms(diff,analysis),newNotes:newNotes(diff),
      limitations:[
        'Counts and ranking positions describe the captured evidence only; they are not population prevalence estimates.',
        'Search ranks are observed positions for recorded keywords and capture times, not universal platform rank.',
        'Comment signals are transparent lexicon rules with local negation handling, not a trained sentiment model.',
        'Emerging themes are included only when the latest evidence cluster contains traceable note/comment IDs.',
        'Coverage gaps and non-NORMAL capture states should be resolved before interpreting trend changes.',
      ],
    };
    return digest;
  }

  function sourceRefs(row){
    const ids=(row?.evidenceIds||[]).map(id=>`\`${md(id)}\``).join(', ');
    const urls=(row?.sourceUrls||[]).map(url=>`<${url}>`).join(' · ');
    return [ids,urls].filter(Boolean).join(' · ');
  }

  function digestMarkdown(digest){
    const title=digest.branding?.reportTitle||`${digest.project.name} Weekly Client Digest`;
    const out=[`# ${md(title)}`];
    if(digest.branding?.agencyName)out.push('',`_${md(digest.branding.agencyName)}_`);
    out.push('',`Project: ${md(digest.project.name)}${digest.project.client?` · Client: ${md(digest.project.client)}`:''}`,
      `Observed period: ${digest.period.from||'n/a'} → ${digest.period.to||'n/a'}`,'',
      '## Evidence status',
      `- Quality: ${md(digest.quality?.status||'unknown')}${digest.quality?.score!==null&&digest.quality?.score!==undefined?` (${digest.quality.score}/100)`:''}`,
      `- Coverage: ${digest.coverage.notes} notes / ${digest.coverage.comments} comments / ${digest.coverage.authors} authors`,
      `- Capture risk: ${md(digest.coverage.riskState)}`,
      `- Explicit gaps: ${digest.coverage.gaps}`);
    for(const warning of digest.quality?.warnings||[])out.push(`- Warning: ${md(warning)}`);

    out.push('','## Attention');
    if(digest.alerts.length)for(const alert of digest.alerts)out.push(`- **${md(alert.level.toUpperCase())} · ${md(alert.title)}**${alert.detail?` — ${md(alert.detail)}`:''}`);
    else out.push('- No threshold-based attention alert was produced for the compared snapshots.');

    out.push('','## Observed signal counts',
      `- Questions: ${digest.observedSignals.before.questions} → ${digest.observedSignals.after.questions}`,
      `- Complaints: ${digest.observedSignals.before.complaints} → ${digest.observedSignals.after.complaints}`,
      `- Purchase-intent signals: ${digest.observedSignals.before.purchaseIntent} → ${digest.observedSignals.after.purchaseIntent}`,
      `- Positive signals: ${digest.observedSignals.before.positive} → ${digest.observedSignals.after.positive}`);

    out.push('','## Observed search-rank changes');
    if(digest.rankChanges.length)for(const row of digest.rankChanges){
      const ref=row.sourceUrl?` · <${row.sourceUrl}>`:row.noteId?` · \`${md(row.noteId)}\``:'';
      out.push(`- ${md(row.keyword)} · ${md(row.title)}: #${row.before} → #${row.after}${ref}`);
    } else out.push('- No observed rank change in the compared snapshots.');

    out.push('','## Emerging evidence themes');
    if(digest.emergingTerms.length)for(const row of digest.emergingTerms)out.push(`- **${md(row.term)}**: ${row.before} → ${row.after} captured comments · evidence ${sourceRefs(row)}`);
    else out.push('- No emerging term met the traceable-evidence requirement.');

    out.push('','## Newly observed notes');
    if(digest.newNotes.length)for(const note of digest.newNotes)out.push(`- ${md(note.title)} · \`${md(note.noteId)}\`${note.sourceUrl?` · <${note.sourceUrl}>`:''}`);
    else out.push('- No newly observed note in the compared snapshots.');

    out.push('','## Interpretation limits');
    for(const limit of digest.limitations)out.push(`- ${md(limit)}`);
    if(digest.branding?.footerText)out.push('',`_${md(digest.branding.footerText)}_`);
    return out.join('\n')+'\n';
  }

  root.XHS_DIGEST_MODEL=Object.freeze({buildDigest,digestMarkdown,evidenceForTerm});
})(typeof globalThis!=='undefined'?globalThis:this);
