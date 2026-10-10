import test from 'node:test';
import assert from 'node:assert/strict';
import { assertHostedDeploymentConfig } from '../lib/hosted-policy.mjs';

test('hosted deployment requires an explicit HTTPS public origin, with localhost-only HTTP exception',()=>{
  assert.deepEqual(assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'0'}),{hosted:false});
  assert.throws(
    ()=>assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'1'}),
    error=>error?.code==='HOSTED_PUBLIC_URL_REQUIRED'&&error?.statusCode===503,
  );
  assert.throws(
    ()=>assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:'http://research.example.com'}),
    error=>error?.code==='HOSTED_HTTPS_REQUIRED',
  );
  assert.throws(
    ()=>assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:'https://research.example.com/path'}),
    error=>error?.code==='HOSTED_PUBLIC_URL_INVALID',
  );
  assert.equal(assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:'https://research.example.com'}).origin,'https://research.example.com');
  assert.equal(assertHostedDeploymentConfig({XHS_STUDIO_HOSTED:'1',XHS_STUDIO_PUBLIC_URL:'http://127.0.0.1:5418'}).local,true);
});
