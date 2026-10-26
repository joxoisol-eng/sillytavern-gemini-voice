/**
 * SillyTavern Gemini 语音附件扩展 (v1.2.0 - 真正直接与文字同时发送)
 *
 * 核心设计：
 * 1. 自动读取酒馆已配置的 API URL、Key 与模型：完全不需要在插件里填 Key，绝不上载 GitHub！
 * 2. 像图片一样随文字一次性发送：文字 + 原声音频打包进同一个请求，拒绝奇怪的两步预解析！
 * 3. 角色直接沉浸回复：AI 同时听取你的原声音调与输入的文字，直接扮演角色给出自然回复。
 * 4. 聊天记录生成可重听的语音条：随时回放刚才的真实录音。
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

jQuery(async () => {
  console.log('[GeminiVoice] 正在启动 SillyTavern 语音直接发送扩展 v1.2.0...');

  // 轮询等待输入栏就绪
  let attempts = 0;
  const checkInterval = setInterval(() => {
    attempts++;
    const $textarea = $('#send_textarea');
    const $sendBtn = $('#send_but');

    if ($textarea.length) {
      clearInterval(checkInterval);
      initVoiceUI($sendBtn, $textarea);
    } else if (attempts > 50) {
      clearInterval(checkInterval);
      setTimeout(() => {
        const $t = $('#send_textarea');
        if ($t.length) initVoiceUI($('#send_but'), $t);
      }, 1500);
    }
  }, 200);
});

// 自动从酒馆当前配置读取 API 连接 (免去二次输入 Key)
function getActiveSillyTavernApi() {
  const oai = window.oai_settings || {};
  let apiUrl = oai.custom_url || oai.reverse_proxy || '';
  if (!apiUrl) apiUrl = 'http://127.0.0.1:8317/v1';

  let apiKey = oai.proxy_password || '';
  let model = oai.custom_model || oai.openai_model || 'gemini-3.8-flash-high';

  return { apiUrl, apiKey, model };
}

function initVoiceUI($sendBtn, $textarea) {
  // 清理可能存在的旧元素
  $('#gemini_voice_mic_btn').remove();
  $('#gemini_voice_recording_banner').remove();
  $('#gemini_voice_chip').remove();

  // 注入麦克风大按钮 (触控优化)
  const $micBtn = $(`
    <div id="gemini_voice_mic_btn" class="fa-solid fa-microphone interactable"
         title="点击录制语音附件"
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

  // 录音中的轻量状态条
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

  // 语音挂载小胶囊 (坐在输入框正上方，不遮挡打字框，带大 ✕ 删除按钮)
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

  // 注入到输入框上方
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

  // ==================== 录音控制绑定 ====================

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (attachedBlob) {
        if (typeof toastr !== 'undefined') toastr.info('已有语音附件，可直接发送或点 ✕ 删除再录');
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

  // 点击 ✕ 一键删除不发送
  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  // 拦截发送：当有语音挂载时，与文字一起发送多模态请求
  hookUnifiedSend($sendBtn, $textarea);

  console.log('[GeminiVoice] 扩展 v1.2.0 初始化完成！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音直接发送扩展 v1.2.0 已就绪！(文字+语音同时发送)');
  }
}

// ==================== 录音逻辑 ====================

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
    console.error('[GeminiVoice] 调起麦克风失败:', err);
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
    attachVoiceAttachment(blob, Math.max(1, recordSeconds));
  }
}

function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60).toString().padStart(2, '0');
  const s = (recordSeconds % 60).toString().padStart(2, '0');
  $('#gemini_voice_timer').text(`正在录音 ${m}:${s}`);
}

// 挂载到输入框上方
function attachVoiceAttachment(blob, seconds) {
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
    toastr.success('🎙️ 语音已挂载！直接输入文字即可一起发送');
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

// ==================== 核心：多模态合体发送 ====================

function hookUnifiedSend($sendBtn, $textarea) {
  const handleSend = async (e) => {
    if (attachedBase64) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await executeMultimodalSend($textarea);
    }
  };

  if ($sendBtn.length) {
    $sendBtn.on('click', handleSend);
  }
  $textarea.on('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && attachedBase64) {
      await handleSend(e);
    }
  });
}

async function executeMultimodalSend($textarea) {
  const userText = $textarea.val().trim();
  const audioBase64 = attachedBase64;
  const audioBlob = attachedBlob;
  const audioUrl = attachedUrl;
  const duration = attachedDuration;

  // 清空输入框和挂载条
  $textarea.val('').trigger('input');
  discardVoiceAttachment();

  if (typeof toastr !== 'undefined') {
    toastr.info('正在发送文字与语音给角色...');
  }

  // 1. 立即把用户的语音与文字放入酒馆聊天界面
  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const charName = context.name2 || '角色';
  const userName = context.name1 || '你';

  const userMessageHtml = `
    <div class="st-gemini-voice-bubble">
      <div class="st-voice-player-row">
        <audio class="st-voice-audio" controls src="${audioUrl}"></audio>
        <span style="font-size:12px; font-weight:600; color:#818cf8;">${duration}"</span>
      </div>
      ${userText ? `<div class="st-voice-user-text">💬 ${escapeHtml(userText)}</div>` : ''}
    </div>
  `;

  // 插入用户消息到酒馆聊天流
  appendMessage(userName, true, userMessageHtml);

  try {
    // 2. 直接使用酒馆当前配置的 API 进行请求
    const apiConfig = getActiveSillyTavernApi();
    console.log('[GeminiVoice] 使用酒馆配置发送:', apiConfig.apiUrl, apiConfig.model);

    // 组装历史上下文
    const historyList = (context.chat || []).slice(-8).map(m => {
      const sender = m.is_user ? userName : (m.name || charName);
      return `${sender}: ${m.mes || ''}`;
    }).join('\n');

    // Prompt: 让角色自然回复，同时听取语音与阅读文字，不需要奇怪的中间解析！
    const promptText = (historyList ? `【前序聊天背景】\n${historyList}\n\n` : '') +
      (userText ? `用户发来的话: "${userText}"\n` : '') +
      `【系统提示】：用户随本条消息附带了一段时长 ${duration} 秒的真实语音（可能包含哼歌、说话语气、情绪、停顿）。请仔细聆听这段音频的声音细节，并结合用户发来的文字，以角色身分进行自然、沉浸的回复。`;

    const charReply = await sendDirectToGemini(apiConfig, audioBase64, audioBlob.type || 'audio/webm', promptText);

    // 3. 插入角色回复到聊天流
    appendMessage(charName, false, charReply);

  } catch (err) {
    console.error('[GeminiVoice] 发送多模态请求失败:', err);
    if (typeof toastr !== 'undefined') {
      toastr.error('发送失败：' + (err.message || '网络连接错误'));
    }
  }
}

// 直接向酒馆配置的反代发起原生多模态请求 (真实发送音频数据)
async function sendDirectToGemini(apiConfig, base64Data, mimeType, prompt) {
  let baseUrl = apiConfig.apiUrl.replace(/\/+$/, '');
  const apiKey = apiConfig.apiKey;
  const model = apiConfig.model;

  // 构造标准多模态请求体
  let targetUrl = '';
  let payload = null;

  if (baseUrl.includes('/v1beta')) {
    // Gemini 原生接口格式
    targetUrl = `${baseUrl}/models/${model}:generateContent`;
    if (apiKey) targetUrl += `?key=${apiKey}`;

    payload = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: prompt }
        ]
      }]
    };
  } else {
    // OpenAI 格式反代接口 (兼容 input_audio)
    targetUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    payload = {
      model,
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
  }

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

  // 优先解析 Gemini 原生格式，再解析 OpenAI 格式
  return data.candidates?.[0]?.content?.parts?.[0]?.text ||
         data.choices?.[0]?.message?.content ||
         '（角色未回复）';
}

function appendMessage(name, isUser, contentHtml) {
  const context = window.SillyTavern?.getContext ? window.SillyTavern.getContext() : {};
  const msgObj = {
    name: name,
    is_user: isUser,
    is_system: false,
    send_date: Date.now(),
    mes: contentHtml,
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
