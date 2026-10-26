/**
 * SillyTavern Gemini 语音附件扩展 (SillyTavern 1.12.14 专属)
 * 特性：
 * 1. 真实麦克风录音，支持哼歌、耳语、叹气、撒娇等复杂声学特征
 * 2. 像图片一样挂载在输入框上方，随时点 ▶ 试听，点 ✕ 秒删丢弃
 * 3. 搭配输入框文字一起发给 Gemini 多模态模型 (Termux 本地反代)
 * 4. 自动提取语气与情绪标签，并在酒馆聊天记录中生成 QQ 风格真实可播放的语音卡片
 */

// 兼容 ES 模块导入与全局 SillyTavern 上下文
let getContext = window.SillyTavern?.getContext || (() => ({}));

// 配置项
const DEFAULT_CONFIG = {
  apiUrl: 'http://127.0.0.1:8317/v1',
  apiKey: '',
  model: 'gemini-1.5-flash',
  format: 'gemini_native' // 'gemini_native' | 'openai_chat'
};

function loadSettings() {
  try {
    const saved = localStorage.getItem('st_gemini_voice_cfg');
    return saved ? { ...DEFAULT_CONFIG, ...JSON.parse(saved) } : { ...DEFAULT_CONFIG };
  } catch (e) {
    return { ...DEFAULT_CONFIG };
  }
}

function saveSettings(cfg) {
  localStorage.setItem('st_gemini_voice_cfg', JSON.stringify(cfg));
}

let config = loadSettings();

// 录音与挂载状态
let mediaRecorder = null;
let audioChunks = [];
let attachedAudioBlob = null;
let attachedAudioBase64 = null;
let attachedAudioUrl = null;
let attachedAudioDuration = 0;
let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

// ==================== UI 注入与初始化 ====================

jQuery(async () => {
  console.log('[GeminiVoice] SillyTavern 语音扩展开始加载...');

  // 1. 等待酒馆主输入框就绪
  const checkInterval = setInterval(() => {
    const $sendBtn = $('#send_but');
    const $textarea = $('#send_textarea');

    if ($sendBtn.length && $textarea.length) {
      clearInterval(checkInterval);
      initVoiceUI($sendBtn, $textarea);
    }
  }, 200);
});

function initVoiceUI($sendBtn, $textarea) {
  // 注入麦克风按钮 (放在发送按钮前)
  const $micBtn = $(`
    <div id="gemini_voice_mic_btn" class="fa-solid fa-microphone interactable"
         title="点击录制语音附件 (长按打开设置)"
         style="cursor:pointer; font-size:1.25em; padding:6px 8px; display:inline-flex; align-items:center; justify-content:center; color:var(--SmartThemeTextColor, inherit);">
    </div>
  `);

  $sendBtn.before($micBtn);

  // 注入录音中的条幅
  const $recordBanner = $(`
    <div id="gemini_voice_recording_banner" class="gemini-voice-recording-banner" style="display:none;">
      <div class="recording-indicator">
        <span class="recording-dot"></span>
        <span id="gemini_voice_timer">正在录音 00:00</span>
      </div>
      <div class="recording-actions">
        <button id="gemini_voice_btn_stop" class="btn-record-stop" type="button">✓ 完成</button>
        <button id="gemini_voice_btn_cancel" class="btn-record-cancel" type="button">✕ 取消</button>
      </div>
    </div>
  `);

  // 注入挂载预览胶囊 (挂在输入框正上方，就像图片附件一样)
  const $attachmentChip = $(`
    <div id="gemini_voice_chip" class="gemini-voice-chip" style="display:none;">
      <div class="gemini-voice-chip-left" id="gemini_voice_chip_play_area" title="点击试听或暂停">
        <button id="gemini_voice_chip_play" class="chip-play-btn" type="button">▶</button>
        <div class="chip-waves" id="gemini_voice_chip_waves">
          <span></span><span></span><span></span><span></span>
        </div>
        <span id="gemini_voice_chip_dur" class="chip-duration">0"</span>
        <span class="chip-label">🎙️ 语音已挂载 (可搭配文字一起发)</span>
      </div>
      <button id="gemini_voice_chip_del" class="chip-del-btn" type="button" title="点击删除此语音附件">✕</button>
    </div>
  `);

  $textarea.before($recordBanner);
  $textarea.before($attachmentChip);

  // ==================== 事件绑定 ====================

  // 麦克风点击触发
  let pressTimer = null;
  $micBtn.on('mousedown touchstart', () => {
    pressTimer = setTimeout(() => {
      openConfigModal();
    }, 700); // 长按 700ms 弹出设置
  });

  $micBtn.on('mouseup touchend', () => {
    clearTimeout(pressTimer);
  });

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (attachedAudioBlob) {
        toastr.info('已有语音附件，请先发送或点 ✕ 删除再录新语音');
        return;
      }
      await startVoiceRecording();
    } else {
      stopVoiceRecording(true);
    }
  });

  // 录音条幅按钮
  $('#gemini_voice_btn_stop').on('click', () => stopVoiceRecording(true));
  $('#gemini_voice_btn_cancel').on('click', () => stopVoiceRecording(false));

  // 试听播放 / 暂停
  $('#gemini_voice_chip_play_area').on('click', togglePreviewAudio);

  // 关键功能：点 ✕ 立即删除不发送
  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  // 试听播放完毕重置
  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  // 拦截酒馆的发送动作
  hookSillyTavernSend($sendBtn, $textarea);

  console.log('[GeminiVoice] 语音挂载控件初始化完成！');
}

// ==================== 录音引擎 (标准原生浏览器通道) ====================

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
    toastr.error('调起麦克风失败：' + (err.message || err.name));
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
    attachVoiceBlob(blob, Math.max(1, recordSeconds));
  }
}

function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60).toString().padStart(2, '0');
  const s = (recordSeconds % 60).toString().padStart(2, '0');
  $('#gemini_voice_timer').text(`正在录音 ${m}:${s}`);
}

// 挂载音频到输入框上方
function attachVoiceBlob(blob, seconds) {
  attachedAudioBlob = blob;
  attachedAudioDuration = seconds;
  if (attachedAudioUrl) URL.revokeObjectURL(attachedAudioUrl);
  attachedAudioUrl = URL.createObjectURL(blob);
  previewAudio.src = attachedAudioUrl;

  // 转换 Base64
  const reader = new FileReader();
  reader.onloadend = () => {
    attachedAudioBase64 = reader.result.split(',')[1];
  };
  reader.readAsDataURL(blob);

  // 更新挂载胶囊 UI
  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');
  toastr.success('🎙️ 语音已挂载！可试听或直接输入文字一起发送');
}

// 丢弃删除语音附件
function discardVoiceAttachment() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }
  if (attachedAudioUrl) {
    URL.revokeObjectURL(attachedAudioUrl);
    attachedAudioUrl = null;
  }
  attachedAudioBlob = null;
  attachedAudioBase64 = null;
  attachedAudioDuration = 0;

  $('#gemini_voice_chip_play').text('▶');
  $('#gemini_voice_chip_waves').removeClass('playing');
  $('#gemini_voice_chip').slideUp(150);
  $('#gemini_voice_mic_btn').removeClass('attached');
  toastr.info('已移除语音附件');
}

// 试听播放切换
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

// ==================== 拦截酒馆发送与 Gemini 多模态请求 ====================

function hookSillyTavernSend($sendBtn, $textarea) {
  // 点击发送按钮拦截
  $sendBtn.on('click', async (e) => {
    if (attachedAudioBase64) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await handleVoiceAndTextSend($textarea);
    }
  });

  // 键盘回车拦截
  $textarea.on('keydown', async (e) => {
    if (e.key === 'Enter' && !e.shiftKey && attachedAudioBase64) {
      e.preventDefault();
      e.stopImmediatePropagation();
      await handleVoiceAndTextSend($textarea);
    }
  });
}

async function handleVoiceAndTextSend($textarea) {
  const userText = $textarea.val().trim();
  const audioBase64 = attachedAudioBase64;
  const audioBlob = attachedAudioBlob;
  const audioUrl = attachedAudioUrl;
  const duration = attachedAudioDuration;

  // 清空输入框与附件胶囊
  $textarea.val('').trigger('input');
  discardVoiceAttachment();

  toastr.info('正在发送语音给 Gemini 分析语气与内容...');

  try {
    const context = getSillyTavernContext();
    const charName = context.name2 || '角色';
    const userName = context.name1 || '你';

    // 组装前序对话上下文
    const historyList = (context.chat || []).slice(-8).map(m => {
      const sender = m.is_user ? userName : (m.name || charName);
      return `${sender}: ${m.mes || ''}`;
    }).join('\n');

    const prompt = (historyList ? `【前序剧情对话】\n${historyList}\n\n` : '') +
      (userText ? `【用户附带输入的话】: ${userText}\n` : '') +
      `这是用户对你说的真实语音。请仔细聆听用户的音调、语气、情绪、停顿或哼唱细节。
第一行必须严格按以下格式输出文字转写与语气标注：
[TRANSCRIPT: 说话内容文字 | TONE: 语气与情绪，如轻快甜美、轻哼微喘、慵懒撒娇、委屈哽咽、认真温柔等]
从第二行开始，作为当前角色根据用户的内容与语气进行沉浸式回复。`;

    const { transcript, tone, reply } = await callGeminiMultimodal(audioBase64, audioBlob.type || 'audio/webm', prompt);

    // 1. 在酒馆中生成用户专属 QQ 风格语音卡片
    const userVoiceHtml = `
      <div class="st-gemini-voice-bubble">
        <div class="st-voice-player-row">
          <audio class="st-voice-audio" controls src="${audioUrl}"></audio>
          <span style="font-size:12px; font-weight:600; color:#818cf8;">${duration}"</span>
        </div>
        ${userText ? `<div class="st-voice-user-text">💬 ${escapeHtml(userText)}</div>` : ''}
        <div class="st-voice-transcript">“${escapeHtml(transcript)}”</div>
        <div class="st-voice-tone-badge">🏷️ 语气: ${escapeHtml(tone)}</div>
      </div>
    `;

    // 插入用户消息
    appendMessageToSillyTavern(userName, true, userVoiceHtml);

    // 2. 插入角色回复
    appendMessageToSillyTavern(charName, false, reply);

    toastr.success(`Gemini 已感知语气并回复！[${tone}]`);

  } catch (err) {
    console.error('[GeminiVoice] 发送请求失败:', err);
    toastr.error('发送失败：' + (err.message || '网络连接失败'));
  }
}

// 调用 Gemini 原生或 OpenAI 格式接口
async function callGeminiMultimodal(base64Data, mimeType, prompt) {
  let baseUrl = config.apiUrl.trim().replace(/\/+$/, '');
  const apiKey = config.apiKey.trim();
  const model = config.model.trim();
  const format = config.format;

  let rawText = '';

  if (format === 'gemini_native') {
    let targetUrl = baseUrl.includes('/v1beta') ?
      `${baseUrl}/models/${model}:generateContent` :
      `${baseUrl.replace(/\/v1$/, '')}/v1beta/models/${model}:generateContent`;

    if (apiKey) targetUrl += `?key=${apiKey}`;

    const payload = {
      contents: [{
        role: 'user',
        parts: [
          { inlineData: { mimeType, data: base64Data } },
          { text: prompt }
        ]
      }]
    };

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'x-goog-api-key': apiKey } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`API HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rawText = data.candidates?.[0]?.content?.parts?.[0]?.text || '';

  } else {
    const targetUrl = baseUrl.endsWith('/v1') ? `${baseUrl}/chat/completions` : `${baseUrl}/v1/chat/completions`;
    const payload = {
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

    const res = await fetch(targetUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) throw new Error(`OpenAI API ${res.status}: ${await res.text()}`);
    const data = await res.json();
    rawText = data.choices?.[0]?.message?.content || '';
  }

  // 提取转写与语气
  let transcript = '（语音）';
  let tone = '自然';
  let reply = rawText;

  const match = rawText.match(/\[TRANSCRIPT:\s*(.*?)\s*\|\s*TONE:\s*(.*?)\s*\]/i);
  if (match) {
    transcript = match[1] || transcript;
    tone = match[2] || tone;
    reply = rawText.replace(match[0], '').trim();
  }

  return { transcript, tone, reply };
}

// 写入酒馆聊天
function appendMessageToSillyTavern(name, isUser, contentHtml) {
  const context = getSillyTavernContext();
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

function getSillyTavernContext() {
  if (window.SillyTavern?.getContext) return window.SillyTavern.getContext();
  return {
    name1: '你',
    name2: '角色',
    chat: []
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ==================== 配置模态框 ====================

function openConfigModal() {
  $('.gemini-voice-modal-backdrop').remove();

  const modalHtml = `
    <div class="gemini-voice-modal-backdrop">
      <div class="gemini-voice-modal">
        <h3>⚙️ Gemini 语音附件配置</h3>
        <div class="field-row">
          <label>API 地址 (Termux 反代)</label>
          <input type="text" id="gv_cfg_url" value="${config.apiUrl}">
        </div>
        <div class="field-row">
          <label>API Key (默认留空或填 sk-..)</label>
          <input type="password" id="gv_cfg_key" value="${config.apiKey}">
        </div>
        <div class="field-row">
          <label>模型名称</label>
          <input type="text" id="gv_cfg_model" value="${config.model}">
        </div>
        <div class="field-row">
          <label>协议格式</label>
          <select id="gv_cfg_format">
            <option value="gemini_native" ${config.format === 'gemini_native' ? 'selected' : ''}>Gemini 原生 (/v1beta/models/...)</option>
            <option value="openai_chat" ${config.format === 'openai_chat' ? 'selected' : ''}>OpenAI 格式 (/v1/chat/completions)</option>
          </select>
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
    config.apiUrl = $('#gv_cfg_url').val().trim();
    config.apiKey = $('#gv_cfg_key').val().trim();
    config.model = $('#gv_cfg_model').val().trim();
    config.format = $('#gv_cfg_format').val();
    saveSettings(config);
    $('.gemini-voice-modal-backdrop').remove();
    toastr.success('Gemini 语音配置已保存！');
  });
}
