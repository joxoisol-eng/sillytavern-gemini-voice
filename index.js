/**
 * 语音插件 (v2.2.0 - 适配 SillyTavern 1.12.14 专属多模态引擎)
 *
 * 核心真相：
 * SillyTavern 1.12.14 官方原生底层仅支持图片附件，完全不支持音频附件传输（音频在发送时会被酒馆底层直接丢弃）。
 * 本插件通过直接将真实音频 Base64 + 用户文字打包送给 Gemini，真正实现多模态交互！
 * 拒绝生硬的预解析与格式化标签，AI 直接听取你的原声、音调与文字，以角色身份自然沉浸回复。
 */

let mediaRecorder = null;
let audioChunks = [];
let attachedBlob = null;
let attachedBase64 = null;
let attachedUrl = null;
let attachedDuration = 0;
let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

// 本地配置读取与保存
const DEFAULT_CONFIG = {
  apiUrl: 'http://127.0.0.1:8317/v1',
  apiKey: '',
  model: 'gemini-3.8-flash-high',
  format: 'auto' // 'auto' | 'gemini_native' | 'openai_chat'
};

function getPluginConfig() {
  try {
    const saved = localStorage.getItem('voice_plugin_config');
    const oai = window.oai_settings || {};
    const detectedUrl = oai.custom_url || oai.reverse_proxy || DEFAULT_CONFIG.apiUrl;
    const detectedModel = oai.custom_model || oai.openai_model || DEFAULT_CONFIG.model;

    return saved ? { ...DEFAULT_CONFIG, apiUrl: detectedUrl, model: detectedModel, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG, apiUrl: detectedUrl, model: detectedModel };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function savePluginConfig(cfg) {
  localStorage.setItem('voice_plugin_config', JSON.stringify(cfg));
}

let config = getPluginConfig();

jQuery(async () => {
  console.log('[VoicePlugin] SillyTavern 1.12.14 专属多模态语音插件 v2.2.0 加载中...');

  let attempts = 0;
  const checkInterval = setInterval(() => {
    attempts++;
    const $textarea = $('#send_textarea');
    const $sendBtn = $('#send_but');

    if ($textarea.length) {
      clearInterval(checkInterval);
      initVoiceUI($sendBtn, $textarea);
    } else if (attempts > 60) {
      clearInterval(checkInterval);
      setTimeout(() => {
        const $t = $('#send_textarea');
        if ($t.length) initVoiceUI($('#send_but'), $t);
      }, 1500);
    }
  }, 200);
});

function initVoiceUI($sendBtn, $textarea) {
  $('#gemini_voice_mic_btn').remove();
  $('#gemini_voice_recording_banner').remove();
  $('#gemini_voice_chip').remove();

  // 注入麦克风按钮 (手机大触控优化，点击录音，长按打开配置)
  const $micBtn = $(`
    <div id="gemini_voice_mic_btn" class="fa-solid fa-microphone interactable"
         title="点击录制语音，长按设置 API Key"
         style="cursor:pointer; font-size:1.35em; min-width:38px; min-height:38px; display:inline-flex; align-items:center; justify-content:center; color:var(--SmartThemeTextColor, inherit); touch-action:manipulation; margin:0 4px;">
    </div>
  `);

  if ($sendBtn.length) {
    $sendBtn.before($micBtn);
  } else if ($('#chat_input_controls').length) {
    $('#chat_input_controls').append($micBtn);
  } else {
    $textarea.after($micBtn);
  }

  // 录音中的轻量条幅
  const $recordBanner = $(`
    <div id="gemini_voice_recording_banner" class="gemini-voice-recording-banner"
         style="display:none; max-width:min(280px, calc(100vw - 40px)); margin:4px 8px; box-sizing:border-box;">
      <div class="recording-indicator" style="display:flex; align-items:center; gap:6px; font-weight:600; font-size:12px;">
        <span class="recording-dot" style="width:8px; height:8px; border-radius:4px; background:#ef4444;"></span>
        <span id="gemini_voice_timer">00:00</span>
      </div>
      <div class="recording-actions" style="display:flex; gap:6px;">
        <button id="gemini_voice_btn_stop" class="btn-record-stop" type="button" style="padding:3px 8px; background:#ef4444; color:#fff; border:none; border-radius:6px; font-size:11px;">✓ 完成</button>
        <button id="gemini_voice_btn_cancel" class="btn-record-cancel" type="button" style="padding:3px 6px; background:transparent; color:#94a3b8; border:1px solid #475569; border-radius:6px; font-size:11px;">✕</button>
      </div>
    </div>
  `);

  // 语音挂载小胶囊 (紧凑小药丸设计，位于输入栏正上方，带 ▶ 试听与 ✕ 丢弃按钮)
  const $attachmentChip = $(`
    <div id="gemini_voice_chip" class="gemini-voice-chip"
         style="display:none; width:fit-content; max-width:min(260px, calc(100vw - 40px)); margin:4px 8px; padding:4px 8px 4px 10px; border-radius:18px; box-sizing:border-box; z-index:10; align-items:center; justify-content:space-between; gap:6px;">
      <div class="gemini-voice-chip-left" id="gemini_voice_chip_play_area" title="点击试听或暂停" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <button id="gemini_voice_chip_play" class="chip-play-btn" type="button" style="width:26px; height:26px; border-radius:13px; font-size:10px; flex-shrink:0;">▶</button>
        <div class="chip-waves" id="gemini_voice_chip_waves">
          <span></span><span></span><span></span><span></span>
        </div>
        <span id="gemini_voice_chip_dur" class="chip-duration" style="font-size:13px; font-weight:700; color:#a5b4fc;">0"</span>
        <span class="chip-label" style="font-size:12px; font-weight:500;">🎙️ 已挂载</span>
      </div>
      <button id="gemini_voice_chip_del" class="chip-del-btn" type="button" title="点击删除语音附件"
              style="width:28px; height:28px; border-radius:14px; font-size:15px; font-weight:bold; margin-left:6px; flex-shrink:0; cursor:pointer; touch-action:manipulation;">✕</button>
    </div>
  `);

  const $nonQR = $('#nonQRFormItems');
  if ($nonQR.length) {
    $nonQR.before($recordBanner);
    $nonQR.before($attachmentChip);
  } else if ($('#send_form').length) {
    $('#send_form').prepend($recordBanner);
    $('#send_form').prepend($attachmentChip);
  } else {
    $textarea.before($recordBanner);
    $textarea.before($attachmentChip);
  }

  // ==================== 事件交互 ====================

  let pressTimer = null;
  $micBtn.on('touchstart mousedown', () => {
    pressTimer = setTimeout(() => {
      openConfigModal();
    }, 600); // 长按 600ms 打开设置
  });

  $micBtn.on('touchend touchcancel mouseup mouseleave', () => {
    clearTimeout(pressTimer);
  });

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (attachedBlob) {
        if (typeof toastr !== 'undefined') toastr.info('已有语音附件，请直接发送或点 ✕ 删除再录');
        return;
      }
      await startVoiceRecording();
    } else {
      stopVoiceRecording(true);
    }
  });

  $('#gemini_voice_btn_stop').on('click', () => stopVoiceRecording(true));
  $('#gemini_voice_btn_cancel').on('click', () => stopVoiceRecording(false));

  $('#gemini_voice_chip_play_area').on('click', togglePreviewAudio);

  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  // 绑定发送拦截：有语音时执行多模态直接发送
  hookSend($sendBtn, $textarea);

  console.log('[VoicePlugin] v2.2.0 初始化完成！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音插件 v2.2.0 已就绪！(长按麦克风可配置 Key)');
  }
}

// ==================== 录音控制 ====================

async function startVoiceRecording() {
  audioChunks = [];
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });

    let mimeType = 'audio/webm;codecs=opus';
    if (!MediaRecorder.isTypeSupported(mimeType)) {
      if (MediaRecorder.isTypeSupported('audio/webm')) mimeType = 'audio/webm';
      else if (MediaRecorder.isTypeSupported('audio/mp4')) mimeType = 'audio/mp4';
      else mimeType = '';
    }

    mediaRecorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) audioChunks.push(e.data);
    };

    mediaRecorder.onstop = () => {
      stream.getTracks().forEach(t => t.stop());
    };

    mediaRecorder.start(150);
    isRecording = true;
    recordSeconds = 0;

    $('#gemini_voice_mic_btn').addClass('recording');
    $('#gemini_voice_recording_banner').slideDown(150);
    updateTimerDisplay();

    recordTimer = setInterval(() => {
      recordSeconds++;
      updateTimerDisplay();
    }, 1000);

  } catch (err) {
    console.error('[VoicePlugin] 调起麦克风失败:', err);
    if (typeof toastr !== 'undefined') {
      toastr.error('调起麦克风失败：' + (err.message || err.name));
    }
  }
}

function stopVoiceRecording(save = true) {
  if (!isRecording) return;
  clearInterval(recordTimer);
  isRecording = false;
  $('#gemini_voice_mic_btn').removeClass('recording');
  $('#gemini_voice_recording_banner').slideUp(150);

  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    mediaRecorder.stop();
  }

  if (save && audioChunks.length > 0) {
    const mime = mediaRecorder?.mimeType || 'audio/webm';
    const blob = new Blob(audioChunks, { type: mime });
    attachAudioAsPending(blob, Math.max(1, recordSeconds));
  }
}

function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60).toString().padStart(2, '0');
  const s = (recordSeconds % 60).toString().padStart(2, '0');
  $('#gemini_voice_timer').text(`正在录音 ${m}:${s}`);
}

function attachAudioAsPending(blob, seconds) {
  attachedBlob = blob;
  attachedDuration = seconds;
  if (attachedUrl) URL.revokeObjectURL(attachedUrl);
  attachedUrl = URL.createObjectURL(blob);
  previewAudio.src = attachedUrl;

  const reader = new FileReader();
  reader.onloadend = () => {
    attachedBase64 = reader.result.split(',')[1];
  };
  reader.readAsDataURL(blob);

  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').css('display', 'inline-flex').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');

  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音已挂载！直接输入文字一起发送');
  }
}

function discardVoiceAttachment() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }
  if (attachedUrl) {
    URL.revokeObjectURL(attachedUrl);
    attachedUrl = null;
  }
  attachedBlob = null;
  attachedBase64 = null;
  attachedDuration = 0;

  $('#gemini_voice_chip_play').text('▶');
  $('#gemini_voice_chip_waves').removeClass('playing');
  $('#gemini_voice_chip').slideUp(150);
  $('#gemini_voice_mic_btn').removeClass('attached');
}

function togglePreviewAudio() {
  if (!previewAudio.src) return;
  if (previewAudio.paused) {
    previewAudio.play();
    $('#gemini_voice_chip_play').text('⏸');
    $('#gemini_voice_chip_waves').addClass('playing');
  } else {
    previewAudio.pause();
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  }
}

// ==================== 核心：多模态真正与文字打包发送 ====================

function hookSend($sendBtn, $textarea) {
  const doSend = async (e) => {
    if (attachedBase64) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await executeDirectSend($textarea);
    }
  };

  if ($sendBtn.length) {
    $sendBtn.on('click', doSend);
  }
  $textarea.on('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && attachedBase64) {
      await doSend(e);
    }
  });
}

async function executeDirectSend($textarea) {
  const userText = $textarea.val().trim();
  const audioBase64 = attachedBase64;
  const audioBlob = attachedBlob;
  const audioUrl = attachedUrl;
  const duration = attachedDuration;

  // 清空输入框和胶囊
  $textarea.val('').trigger('input');
  discardVoiceAttachment();

  if (typeof toastr !== 'undefined') {
    toastr.info('正在发送文字与真实语音给角色...');
  }

  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const charName = context.name2 || '角色';
  const userName = context.name1 || '你';

  // 1. 在酒馆中生成用户专属的语音卡片 (显示可播放的原声条 + 用户文字)
  const userHtml = `
    <div class="st-gemini-voice-bubble">
      <div class="st-voice-player-row">
        <audio class="st-voice-audio" controls src="${audioUrl}"></audio>
        <span style="font-size:12px; font-weight:600; color:#818cf8;">${duration}"</span>
      </div>
      ${userText ? `<div class="st-voice-user-text">💬 ${escapeHtml(userText)}</div>` : ''}
    </div>
  `;

  // 消息正文只保留文字提示，绝对不漏泄 blob: 标签给后续对话！
  const cleanSummary = userText ? `${userText} (附带 ${duration}秒 真实语音)` : `(附带 ${duration}秒 真实语音)`;
  appendMessage(userName, true, cleanSummary, userHtml);

  try {
    const cfg = getPluginConfig();
    const mimeType = audioBlob?.type || 'audio/webm';

    // 组装历史上下文
    const historyList = (context.chat || []).slice(-8).map(m => {
      const sender = m.is_user ? userName : (m.name || charName);
      return `${sender}: ${m.mes || ''}`;
    }).join('\n');

    // 自然人设立意：要求角色直接沉浸回复，绝对不需要任何奇怪的文字转写或机械分析！
    const promptText = (historyList ? `【前序聊天背景】\n${historyList}\n\n` : '') +
      (userText ? `用户发送的文字: "${userText}"\n` : '') +
      `【系统提示】：用户在发送本条消息时随附了一段真实原声音频（可能是哼歌、说话语气、情绪或叹气）。请仔细聆听音频的声音细节，并结合用户发来的文字，以角色身份进行自然、生动、沉浸的回复。`;

    const charReply = await requestDirectMultimodal(cfg, audioBase64, mimeType, promptText);

    // 2. 插入角色回复到聊天记录
    appendMessage(charName, false, charReply, null);

  } catch (err) {
    console.error('[VoicePlugin] 发送失败:', err);
    let msg = err.message || '网络连接失败';
    if (msg.includes('miss api key') || msg.includes('missing api key')) {
      msg = '反代缺少 API Key！请长按输入框旁的麦克风图标输入你的 Key 并保存。';
      openConfigModal();
    }
    if (typeof toastr !== 'undefined') {
      toastr.error('发送失败：' + msg);
    }
  }
}

// 核心网络层：将音频 Base64 作为真正的多模态数据发给反代
async function requestDirectMultimodal(cfg, base64Data, mimeType, prompt) {
  let baseUrl = cfg.apiUrl.replace(/\/+$/, '');
  const apiKey = cfg.apiKey;
  const model = cfg.model;

  // 优先尝试 Gemini 原生接口 (Gemini 处理 Base64 音频最完美)
  const isGeminiFormat = cfg.format === 'gemini_native' || baseUrl.includes('/v1beta') || !baseUrl.endsWith('/v1');

  if (isGeminiFormat) {
    let cleanBase = baseUrl.replace(/\/v1$/, '');
    let targetUrl = `${cleanBase}/v1beta/models/${model}:generateContent`;
    if (apiKey) targetUrl += `?key=${apiKey}`;

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType: mimeType, data: base64Data } },
          { text: prompt }
        ]
      }]
    };

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-goog-api-key': apiKey, 'Authorization': `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (res.ok) {
      const data = await res.json();
      const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (reply) return reply;
    } else {
      console.warn('[VoicePlugin] Gemini 原生接口未响应，尝试 OpenAI 兼容格式...');
    }
  }

  // 备用 / 默认：OpenAI 格式 (兼容 input_audio)
  const targetUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
  const payload = {
    model: model,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'input_audio',
          input_audio: {
            data: base64Data,
            format: mimeType.includes('mp4') ? 'mp4' : 'wav'
          }
        },
        { type: 'text', text: prompt }
      ]
    }]
  };

  const res = await fetch(targetUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { 'Authorization': `Bearer ${apiKey}`, 'x-goog-api-key': apiKey } : {})
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`API HTTP ${res.status}: ${errText}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content ||
         data.candidates?.[0]?.content?.parts?.[0]?.text ||
         '（角色未回复）';
}

function appendMessage(name, isUser, rawText, displayHtml = null) {
  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const msgObj = {
    name: name,
    is_user: isUser,
    is_system: false,
    send_date: Date.now(),
    mes: displayHtml || rawText,
    extra: {}
  };

  if (context.chat && Array.isArray(context.chat)) {
    context.chat.push(msgObj);
    if (typeof context.addOneMessage === 'function') {
      context.addOneMessage(msgObj);
    } else if (typeof window.addOneMessage === 'function') {
      window.addOneMessage(msgObj);
    }
    if (typeof context.saveChat === 'function') {
      context.saveChat();
    }
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== 配置模态框 (长按麦克风弹出) ====================

function openConfigModal() {
  $('.gemini-voice-modal-backdrop').remove();

  const cfg = getPluginConfig();

  const modalHtml = `
    <div class="gemini-voice-modal-backdrop">
      <div class="gemini-voice-modal">
        <h3>⚙️ 语音插件配置</h3>
        <p style="font-size:11px; color:#9ca3af; margin-bottom:10px;">配置仅保存在你当前手机浏览器本地，绝不上载 GitHub。</p>
        <div class="field-row">
          <label>API 地址 (Termux 反代)</label>
          <input type="text" id="gv_cfg_url" value="${cfg.apiUrl}">
        </div>
        <div class="field-row">
          <label>API Key / 鉴权密码</label>
          <input type="password" id="gv_cfg_key" value="${cfg.apiKey}" placeholder="填入你的反代或 Gemini Key">
        </div>
        <div class="field-row">
          <label>模型名称</label>
          <input type="text" id="gv_cfg_model" value="${cfg.model}">
        </div>
        <div class="modal-btns">
          <button id="gv_cfg_cancel" class="btn-cancel-gv">取消</button>
          <button id="gv_cfg_save" class="btn-primary-gv">保存配置</button>
        </div>
      </div>
    </div>
  `;

  $('body').append(modalHtml);

  $('#gv_cfg_cancel').on('click', () => $('.gemini-voice-modal-backdrop').remove());
  $('#gv_cfg_save').on('click', () => {
    const newCfg = {
      apiUrl: $('#gv_cfg_url').val().trim(),
      apiKey: $('#gv_cfg_key').val().trim(),
      model: $('#gv_cfg_model').val().trim(),
      format: cfg.format
    };
    savePluginConfig(newCfg);
    config = newCfg;
    $('.gemini-voice-modal-backdrop').remove();
    if (typeof toastr !== 'undefined') toastr.success('配置已保存！');
  });
}
