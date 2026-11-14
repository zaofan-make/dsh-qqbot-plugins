/**
 * tts_voice.mjs — 语音合成「使用说明 + 自检」工具
 *
 * 这个工具本身**不替你说话**，它是那块「提示牌」：
 *   · AI 只要在正文里写 [语音合成]文本[/语音合成]，出站扩展 volcengintts.mjs 就会把它变成真语音发出去；
 *   · 不确定语法 / 想知道有哪些情绪 / 想试听一条 → 调本工具。
 *
 * 用法：tts_voice(action="guide" | "emotions" | "test", text="要试听的句子")
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import {
  loadSettings, buildHeaders, resolveVoice, resolveResourceId, pickSpeaker,
  ensureOutDir, describeAuth, DEFAULT_URL,
} from '../lib/settings.mjs';

const GUIDE = [
  '【语音合成 · 用法】',
  '在正文里写标记，出站时会自动剥掉标记、合成语音发出去：',
  '  · 基本：[语音合成]主人早上好～[/语音合成]',
  '  · 开闭同标记也认：[语音合成]主人早上好～[语音合成]',
  '  · 带情绪：[语音合成|撒娇]人家还想再睡五分钟嘛[/语音合成]',
  '  · 细调：[语音合成 情绪=开心 强度=5 语速=1.1 音量=1.1]来了来了！[/语音合成]',
  '',
  '规则：',
  '  1. 标记段会被整段摘掉，剩下的正文照常发；',
  '  2. 如果剥完一个字不剩 → 这条正文不发了，只发语音（纯语音回复）；',
  '  3. 一条正文里可以有多个标记，逐条合成、逐条发；',
  '  4. 音色是主人定好的默认音色，情绪只走「情感参数 + 语速/音量」，不换音色；',
  '    真要用别的音色，写 voice=音色ID 临时覆盖。',
  '  5. 语音不走 [MEDIA:voice|…] 标记，只认 [语音合成]。',
].join('\n');

const EMOTION_LIST = [
  '（火山 emotion 值 + 语速微调；音色不支持时会自动降级为不带情感重试）',
  '开心/高兴/欢快/愉快 → happy，语速+6~10',
  '兴奋/激动 → excited，语速+14~16、音量+6',
  '伤心/难过/失落/委屈 → sad，语速-10',
  '生气/愤怒 → angry，语速+8~10、音量+12~15',
  '惊讶 → surprised，语速+8',
  '冷淡 → coldness，语速-6、音量-6',
  '平静/严肃 → neutral',
  '傲娇 → 只调语速+6（不带情感）',
  '温柔/软萌 → 只调语速-8；撒娇 → 语速-6、音量-4；害羞 → -5',
  '慵懒/困/疲惫 → 语速-14~18',
  '英文别名：happy / sad / angry / excited / surprised / coldness / neutral / tender / shy / calm / tired',
  '强度写法：强度=1~5（对应 emotion_scale，默认 4）',
].join('\n');

/** 取配置（面板 > 旧 tts-config.json > 包内默认） */
function getCfg(env) {
  return loadSettings(env).cfg;
}

/** 解析响应体 → Buffer（单 JSON 或 多行 JSON 分片） */
function parseAudio(raw) {
  let audio = null;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j.data === 'string' && j.data) {
      if (j.code && j.code !== 0 && j.code !== 20000000) throw new Error(`code=${j.code} ${j.message || ''}`);
      audio = Buffer.from(j.data, 'base64');
    }
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
  if (audio) return audio;
  const chunks = [];
  let err = null;
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    let ev = null;
    try { ev = JSON.parse(s); } catch { continue; }
    if (ev && typeof ev.data === 'string' && ev.data) chunks.push(Buffer.from(ev.data, 'base64'));
    if (ev && ev.code && ev.code !== 0 && ev.code !== 20000000) err = `${ev.code} ${ev.message || ''}`;
  }
  if (err) throw new Error(`TTS 失败 ${err}`);
  if (chunks.length) return Buffer.concat(chunks);
  throw new Error(`没有音频数据: ${raw.slice(0, 200)}`);
}

/** 独立合成（与出站扩展同一套接口，避免 import 副作用） */
async function synthDirect(text, env, voiceOverride) {
  const cfg = getCfg(env);
  // ★ 同样要走 pickSpeaker，否则「中文名｜id」整串会被当音色发出去
  const speaker = pickSpeaker(cfg, voiceOverride);
  const urls = [cfg.baseUrl || DEFAULT_URL, ...(Array.isArray(cfg.altBaseUrls) ? cfg.altBaseUrls : [])].filter(Boolean);
  let lastErr = null;

  for (const url of urls) {
    try {
      const body = JSON.stringify({
        user: { uid: cfg.uid || 'dsh-tts-voice' },
        req_params: {
          text,
          speaker,
          model: cfg.model || 'seed-tts-2.0-expressive',
          additions: JSON.stringify({ use_tag_parser: true }),
          audio_params: { format: cfg.format || 'mp3', sample_rate: Number(cfg.sampleRate) || 24000 },
        },
      });
      const resp = await fetch(url, { method: 'POST', headers: buildHeaders(cfg, speaker), body });
      const raw = await resp.text();
      if (!resp.ok) throw new Error(`HTTP ${resp.status}: ${raw.slice(0, 250)}`);
      const audio = parseAudio(raw);
      const outDir = ensureOutDir(cfg);
      const path = join(outDir, `test_${Date.now()}.${cfg.format || 'mp3'}`);
      writeFileSync(path, audio);
      return path;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('合成失败');
}

export default {
  name: 'tts_voice',
  description:
    '火山方舟语音合成（豆包 TTS 2.0）。**在正文里写标记**，发出去时会自动变成语音消息（标记本身不外显）：'
    + '① 简单：[语音合成]文本[/语音合成]；'
    + '② 带情绪：[语音合成|撒娇]文本[/语音合成]；'
    + '③ 细调（推荐）：[语音合成 情绪=撒娇 强度=4 语速=0.8 音量=0.95]文本[/语音合成] —— '
    + '参数空格/逗号分隔，语速与音量支持 0.8 这种倍率或 -20 这种百分比，音色=音色ID 可单条换音色。'
    + '⚠️ 复刻音色不支持 [气声耳语]/[轻吸气] 这类标签（会被当正文念出来），也不支持'
    + '"用温柔点的语气说"这类语音指令；想要软/慢/贴耳，用 语速+音量 + 正文里的「……」制造气口。'
    + 'action: guide=完整用法 / emotions=情绪对照表 / test=合成一条测试语音 / status=看配置。',
  inputSchema: {
    action: {
      type: 'string',
      description: 'guide=用法说明(默认) | emotions=情绪对照表 | test=合成一条测试语音并发送',
    },
    text: { type: 'string', description: 'action=test 时要合成的测试文本' },
    voice: { type: 'string', description: '（可选）临时指定音色 ID，只对本次 test 生效' },
  },
  run: async (args, env) => {
    const action = String(args?.action || 'guide').toLowerCase();

    if (action === 'status') {
      const { cfg, sources, candidates, dataRoot } = loadSettings(env);
      const st = describeAuth(cfg);
      const lines = [
        '【TTS 状态】',
        st.ok ? `鉴权：已配置（${st.mode === 'legacy' ? '旧版 AppId+Token' : '新版 API Key'}）` : '鉴权：❌ 未配置 —— 去「TTS 语音合成」设置页填 API Key',
        st.apiKey ? `  API Key：${st.apiKey}` : '',
        st.appId ? `  AppId：${st.appId}` : '',
        st.accessToken ? `  AccessToken：${st.accessToken}` : '',
        `默认音色：${cfg.customSpeaker || cfg.defaultSpeaker}`,
        `Resource-Id：${st.resourceId}` + (cfg.resourceId === 'auto' ? '（自动判定）' : '（手工指定）'),
        `模型：${st.model}`,
        `输出目录：${cfg.outDir}`,
        `dataRoot：${dataRoot || '(未识别)'}`,
        '',
        '实际读到的配置文件（后面的覆盖前面的）：',
        ...(sources.length ? sources.map((x) => '  · ' + x) : ['  （一个都没有，全走包内默认值）']),
        '',
        '将会尝试的路径：',
        ...candidates.map((x) => '  - ' + x),
      ].filter(Boolean);
      return { ok: true, msg: lines.join('\n') };
    }

    if (action === 'emotions') {
      return { ok: true, msg: '【情绪 → 情感/语调对照】\n' + EMOTION_LIST + '\n\n写法：[语音合成|撒娇]…[/语音合成] 或 [语音合成 情绪=撒娇]…[/语音合成]' };
    }

    if (action === 'test') {
      const text = String(args?.text || '').trim() || '主人早上好～这是鲸鱼娘的语音测试，听见了就回人家一声嘛。';
      try {
        const path = await synthDirect(text, env, args?.voice);
        let sent = false;
        // ① 首选宿主的 sender（sendMedia(target, kind, { localPath })）
        const sender = env && env.sender;
        const target = env && env.replyTarget;
        if (sender && typeof sender.sendMedia === 'function' && target) {
          try { await sender.sendMedia(target, 'voice', { localPath: path }); sent = true; } catch { /* 降级 */ }
        }
        // ② 退路：出站操控器
        if (!sent) {
          const ob = globalThis[Symbol.for('im-qqbot.outbound')];
          if (ob && typeof ob.sendMedia === 'function') sent = await ob.sendMedia({ path, kind: 'voice' });
        }
        return {
          ok: true,
          msg: sent
            ? `已合成并发出测试语音：${text}\n文件：${path}`
            : `已合成音频，但没找到可用发送通道（outbound API 缺失）。文件在：${path}`,
        };
      } catch (e) {
        return { ok: false, msg: `测试合成失败：${(e && e.message) || e}` };
      }
    }

    return { ok: true, msg: GUIDE + '\n\n（想查情绪词：action=emotions；想试听：action=test, text="句子"）' };
  },
};
