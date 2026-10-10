function cleanFilename(value){return String(value??'').replace(/[\r\n\u0000-\u001f\u007f]/gu,' ').replace(/\s+/gu,' ').trim().slice(0,240)}
function asciiFallback(value,fallback){
  const ascii=cleanFilename(value).normalize('NFKD').replace(/[^\x20-\x7e]/gu,'').replace(/["\\;]/gu,'_').replace(/^[-_. ]+|[-_. ]+$/gu,'').slice(0,180);
  return ascii||cleanFilename(fallback).replace(/[^\x20-\x7e]/gu,'_').replace(/["\\;]/gu,'_').slice(0,180)||'download';
}
function encode5987(value){return encodeURIComponent(value).replace(/['()*]/gu,char=>`%${char.charCodeAt(0).toString(16).toUpperCase()}`)}

export function attachmentContentDisposition(filename,{fallback='download'}={}){
  const safe=cleanFilename(filename)||cleanFilename(fallback)||'download',ascii=asciiFallback(safe,fallback);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encode5987(safe)}`;
}
