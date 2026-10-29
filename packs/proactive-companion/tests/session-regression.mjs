import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildCarePrompt, wakeWithRegistries } from '../lib/session.mjs';
import { sessionFixture } from './session-fixture.mjs';
import { checkCompanion, localDate } from '../hooks/companion-daemon.mjs';
import { readExtConfig, writeExtConfig } from '../lib/config.mjs';
import command from '../commands/companion.mjs';
import tool from '../tools/companion_manage.mjs';

const root = mkdtempSync(join(tmpdir(), 'companion-session-'));
const calls = [];
const fixture = sessionFixture(root, 'owner', calls);
const env = { dataRoot: root, config: { appId: 'test-app' } };
fixture.manager.config.appId = 'test-app';
const registry = { managersOf: () => [fixture.manager] };
const base = { targetOpenid: 'owner', enabled: true, dailyMax: 1, dailyCount: 0,
  dailyDate: localDate(), lastBubbleTs: 0, consecutiveBubblesWithoutReply: 0,
  windowGreetingEnabled: false, dndStart: '00:00', dndEnd: '00:00', minIntervalHours: 0, mutedDate: '' };
const save = (patch = {}) => writeExtConfig(env, { ...base, ...patch });
try {
  const prompt = buildCarePrompt('idle_care');
  assert.match(prompt, /人设/); assert.match(prompt, /上下文/); assert.match(prompt, /图库工具/);
  assert.match(prompt, /不是对方刚发来的消息/);
  assert.equal(prompt.includes('配置称呼仅供参考'), false);
  assert.deepEqual(await wakeWithRegistries(env, 'owner', prompt, [registry]), { accepted: true, mode: 'original_session' });
  assert.equal(calls[0][0], 'c2c'); assert.equal(calls[0][1], 'owner');
  assert.equal(calls[0][3], 'subagent-settled');
  await assert.rejects(wakeWithRegistries(env, 'stranger', prompt, [registry]), /SESSION_NOT_READY/);
  await assert.rejects(wakeWithRegistries({ ...env, dataRoot: root + '-other' }, 'owner', prompt, [registry]), /HOST_BRIDGE_UNAVAILABLE/);
  await assert.rejects(wakeWithRegistries({ ...env, config: { appId: 'other-app' } }, 'owner', prompt, [registry]), /HOST_BRIDGE_UNAVAILABLE/);
  await assert.rejects(wakeWithRegistries(env, 'owner', prompt, [{ managersOf: () => [fixture.manager, { ...fixture.manager }] }]), /AMBIGUOUS_INSTANCE/);
  fixture.manager.accepted = false;
  await assert.rejects(wakeWithRegistries(env, 'owner', prompt, [registry]), /WAKE_REJECTED/);
  fixture.manager.accepted = true;
  calls.length = 0;
  save();
  const concurrent = await Promise.all([checkCompanion(env, { manual: true }), checkCompanion(env, { manual: true })]);
  assert.equal(concurrent.filter(result => result.accepted).length, 1, 'concurrent manual checks share quota lock');
  assert.equal(calls.length, 1); assert.equal(readExtConfig(env).dailyCount, 1);
  assert.equal(concurrent[0].sent, false, 'a queued followup must never claim QQ delivery');
  save({ enabled: false });
  assert.equal((await checkCompanion(env, { manual: true })).reason, 'disabled');
  save({ dndStart: '00:00', dndEnd: '23:59' });
  if (new Date().getHours() !== 23 || new Date().getMinutes() !== 59) {
    assert.equal((await checkCompanion(env, { manual: true })).reason, 'dnd');
  }
  save({ consecutiveBubblesWithoutReply: 3 });
  assert.equal((await checkCompanion(env, { manual: true })).reason, 'awaiting_reply');
  save();
  const ctx = { env, isOwner: true, command: { raw: 'test' } };
  const result = await command.handler(ctx);
  assert.match(result, /已接纳唤醒/); assert.match(result, /不代表 QQ 已送达/);
  save(); fixture.manager.accepted = false;
  const before = readExtConfig(env);
  const failed = await tool.run({ action: 'trigger_now' }, ctx);
  assert.equal(failed.ok, false); assert.equal(failed.reason, 'send_failed');
  assert.equal(readExtConfig(env).dailyCount, before.dailyCount);
  assert.equal(readExtConfig(env).lastBubbleTs, before.lastBubbleTs);
  assert.match(readExtConfig(env).lastSendError, /WAKE_REJECTED/);

  // Evicted session recovery regression: when active table misses, getOrCreate restores the session
  // and channel healing tools must be invoked before injectToPeer to prevent UNKNOWN_TOOL.
  let createdCalled = false;
  let healedTools = false;
  let healedContext = false;
  let healedRules = false;
  const evictedRegistry = {
    managersOf: () => [{
      dataRoot: root,
      config: { appId: 'test-app' },
      findByPeer: () => undefined,
      getOrCreate: async (scope, peerId) => {
        createdCalled = true;
        return { scope, peerId };
      },
      ensureChannelTools: async (rec) => { if (rec.peerId === 'owner') healedTools = true; },
      ensureChannelContext: async (rec) => { if (rec.peerId === 'owner') healedContext = true; },
      ensureGroupRules: async (rec) => { if (rec.peerId === 'owner') healedRules = true; },
      injectToPeer: async (...args) => { calls.push(args); return true; },
    }],
  };
  assert.deepEqual(await wakeWithRegistries(env, 'owner', prompt, [evictedRegistry]), { accepted: true, mode: 'original_session' });
  assert.equal(createdCalled, true, 'evicted session must be restored via getOrCreate');
  assert.equal(healedTools, true, 'channel tools must be healed on restored session');
  assert.equal(healedContext, true, 'channel context must be healed on restored session');
  assert.equal(healedRules, true, 'group rules must be healed on restored session');

  console.log('PASS session regression: exact instance and target, context prompt, no delivery claim, shared quotas, fail-closed wake, evicted session auto-recovery & tools healing');
} finally { fixture.restore(); rmSync(root, { recursive: true, force: true }); }
