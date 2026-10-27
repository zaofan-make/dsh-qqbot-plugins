import assert from 'node:assert/strict';
import { sessionFixture } from './session-fixture.mjs';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import daemon, { checkCompanion, localDate } from '../hooks/companion-daemon.mjs';
import { normalizeConfig, readExtConfig, writeExtConfig } from '../lib/config.mjs';
import { sendCompanionText } from '../lib/transport.mjs';
const root=mkdtempSync(join(tmpdir(),'companion-idle-test-'));
const sent=[];
const fixture=sessionFixture(root,'owner',sent);
const env={dataRoot:root,config:{owners:['owner']},caps:{api:async()=>({ok:false,err:{code:'NO_CREDENTIALS'}})},text:async(...args)=>{sent.push(args);return true;},logger:{info(){},warn(){}}};
const dir=join(root,'.qqbot','msg-history','c2c_owner');
mkdirSync(dir,{recursive:true});
const now=Date.now();
const base={targetOpenid:'owner',enabled:true,dailyMax:0,dailyCount:99,dailyDate:localDate(),windowGreetingEnabled:false,idlePokeEnabled:true,idleHoursThreshold:0,idleMinutesThreshold:1,minIntervalHours:0.001,dndStart:'00:00',dndEnd:'00:00',lastBubbleTs:0,lastInteractionTs:0,consecutiveBubblesWithoutReply:0,mutedDate:''};
const save=(patch={})=>writeExtConfig(env,{...base,...patch});
try {
  assert.equal(normalizeConfig({}).lastInteractionTs,0);
  assert.equal(normalizeConfig({}).consecutiveBubblesWithoutReply,0);
  save();
  assert.equal((await checkCompanion(env)).reason,'no_interaction_history');
  writeFileSync(join(dir,localDate()+'.jsonl'),JSON.stringify({s:'owner',t:now-120000,x:'hello'})+'\n');
  save();
  assert.equal((await checkCompanion(env)).reason,'queued');
  assert.equal(sent.length,1);
  assert.equal(sent[0][0],'c2c');
   assert.equal(sent[0][1],'owner');
   assert.match(sent[0][2],/原会话|这个私聊会话/);
  assert.equal(readExtConfig(env).dailyCount,100,'zero dailyMax is unlimited');
  assert.equal(readExtConfig(env).consecutiveBubblesWithoutReply,1);
  assert.equal(readExtConfig(env).lastInteractionTs,now-120000);
  assert.equal((await checkCompanion(env)).reason,'cooldown');
  save({minIntervalHours:0,lastBubbleTs:now-1000,consecutiveBubblesWithoutReply:2});
  assert.equal(readExtConfig(env).minIntervalHours,0);
  assert.equal((await checkCompanion(env)).reason,'queued','zero interval disables cooldown');
  assert.equal((await checkCompanion(env)).reason,'awaiting_reply','zero cooldown retains unanswered protection');
  assert.equal(normalizeConfig({minIntervalHours:-1}).minIntervalHours,2.5);
  assert.equal(normalizeConfig({minIntervalHours:''}).minIntervalHours,2.5);
  assert.equal(normalizeConfig({minIntervalHours:null}).minIntervalHours,2.5);
  save({idleHoursThreshold:3});
  assert.equal((await checkCompanion(env)).reason,'waiting_threshold','positive hours takes priority over minutes');
  assert.equal(readExtConfig(env).lastInteractionTs,now-120000,'scan baseline persists on early return');
  save({dailyMax:1,dailyCount:1});
  assert.equal((await checkCompanion(env)).reason,'daily_limit');
  save({mutedDate:localDate()});
  assert.equal((await checkCompanion(env)).reason,'muted_today');
  save({consecutiveBubblesWithoutReply:3,lastBubbleTs:now-60000});
  assert.equal((await checkCompanion(env)).reason,'awaiting_reply');
  save();
  fixture.manager.accepted=false;
  assert.equal((await checkCompanion(env)).reason,'send_failed');
  assert.equal(readExtConfig(env).dailyCount,99,'failed send must not consume quota');
  assert.ok(readExtConfig(env).lastSendError);
  fixture.manager.accepted=true;
  // Bootstrap from yesterday rather than requiring today's first message.
  writeFileSync(join(dir,localDate()+'.jsonl'),'');
  const yesterday=new Date(now-86400000);
  writeFileSync(join(dir,localDate(yesterday)+'.jsonl'),JSON.stringify({s:'owner',t:now-86400000,x:'yesterday'})+'\n');
  save();
  assert.equal((await checkCompanion(env)).reason,'queued');
  // Startup caps alone cannot deliver; must produce a diagnostic, never false success.
  await assert.rejects(sendCompanionText({caps:{api:async()=>({ok:false,err:{code:'NO_CREDENTIALS'}})}},'owner','test'));
  // Test official transport using intercepted fetch only; absolutely no network calls.
  const originalFetch=globalThis.fetch;
  const requests=[];
  try {
    globalThis.fetch=async(url,options)=>{
      requests.push({url:String(url),options});
      return {ok:true,status:200,json:async()=>String(url).includes('getAppAccessToken')?{access_token:'fake-token',expires_in:7200}:{id:'fake-message'}};
    };
    await sendCompanionText({config:{appId:'fake-app',appSecret:'fake-secret'},caps:{api:async()=>({ok:false,err:{code:'NO_CREDENTIALS'}})}},'owner','test');
    assert.equal(requests.length,2);
    assert.ok(requests[0].url.includes('getAppAccessToken'));
    assert.ok(requests[1].url.endsWith('/v2/users/owner/messages'));
    assert.equal(JSON.parse(requests[1].options.body).content,'test');
  } finally {globalThis.fetch=originalFetch;}
  await daemon.run(env); await daemon.run(env); await daemon.dispose();
  console.log('PASS idle regression: real check callback, minutes, unlimited quota, cooldown, mute, backoff, cross-day, failed delivery, startup API fallback');
} finally {await daemon.dispose();fixture.restore();rmSync(root,{recursive:true,force:true});}
