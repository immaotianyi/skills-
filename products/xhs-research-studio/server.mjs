#!/usr/bin/env node
const hosted=['1','true','yes'].includes(String(process.env.XHS_STUDIO_HOSTED||'').toLowerCase());
await import(hosted?'./server-v3.mjs':'./server-v2.mjs');
