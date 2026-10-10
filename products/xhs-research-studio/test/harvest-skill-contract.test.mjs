import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const productRoot=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const repoRoot=path.resolve(productRoot,'../..');
const skillPath=path.join(repoRoot,'.skills','03-domains','xiaohongshu-harvest.yaml');

test('Harvest skill keeps hard-stop platform safety states', async () => {
  const skill=await fs.readFile(skillPath,'utf8');
  for(const state of ['THROTTLED','LOGIN_REQUIRED','CAPTCHA','ACCESS_DENIED','BLOCKED']) {
    assert.match(skill,new RegExp(`\\b${state}\\b`),`missing safety state ${state}`);
  }
  assert.match(skill,/不绕过登录、验证码、访问控制或平台风控/);
  assert.match(skill,/CAPTCHA：出现人机验证；停止自动任务/);
  assert.match(skill,/ACCESS_DENIED \/ BLOCKED：停止该 session/);
  assert.match(skill,/不自动换账号\/IP继续/);
  assert.match(skill,/不做自动点赞\/评论\/关注\/发布/);
});

test('Harvest skill keeps v2 provenance and first-class evidence fields', async () => {
  const skill=await fs.readFile(skillPath,'utf8');
  for(const required of [
    'window.__INITIAL_STATE__',
    'rankingPosition',
    'capturedAt',
    'captureMethod',
    'confidence',
    'sourceUrl',
    'schemaVersion: "2.0"',
    'comments[]',
    'meta.riskState',
    'meta.gaps',
    'meta.sampleBudget',
    'meta.stoppedBecause',
  ]) assert.ok(skill.includes(required),`Harvest contract missing ${required}`);
  assert.match(skill,/状态树优先/);
  assert.match(skill,/OCR 只作为兜底/);
  assert.match(skill,/没有来源的推断不得伪装成抓取事实/);
});

test('Harvest research mode preserves bounded progressive sampling semantics', async () => {
  const skill=await fs.readFile(skillPath,'utf8');
  assert.match(skill,/先取 20–50 条候选/);
  assert.match(skill,/扩到 100–200/);
  assert.match(skill,/新增主题趋于饱和即停止/);
  assert.match(skill,/不要把“研究”默认解释成“全量抓取”/);
});
