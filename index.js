/**
 * 语音插件 (v2.0.1 - 纯血原生附件流优化版)
 *
 * 本次更新关键优化：
 * 1. 修复多轮对话发送失效问题：精准查找消息队列中的真实用户消息，彻底解决长对话后深度提示词(Depth Prompt)/系统附言导致的音频漏注入。
 * 2. 彻底杜绝麦克风句柄泄漏：每次录音结束/取消时确保严密释放 Android 系统的硬件音频流，多轮使用永不卡死。
 * 3. 试听音量智能放大（3倍增益 + 动态防破音）：接入 Web Audio API GainNode，试听音量大幅提升，清晰饱满不刺耳。
 * 4. 优化 Base64 异步状态竞争，保证录音一结束即可立刻秒发。
 */

import { eventSource, event_types } from '../../../../script.js';

let mediaRecorder = null;
let currentActiveStream = null;
let audioChunks = [];
let pendingAudioBlob = null;
let pendingAudioBase64 = null;
let base64Promise = null;
let pendingAudioUrl = null;
let pendingAudioDuration = 0;
let lastRenderAudioUrl = null;
let lastRenderAudioDuration = 0;

let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

// Web Audio API 试听音量放大器 (3.0倍增益 + 动态压缩防破音)
let audioCtx = null;
let gainNode = null;
let mediaSourceNode = null;

function setupAudioGain(audioElement, multiplier = 3.0) {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    if (!audioCtx) {
      audioCtx = new AudioContextClass();
      gainNode = audioCtx.createGain();
      gainNode.gain.value = multiplier;

      // 动态压缩器：防止声音放大后失真或破音
      const compressor = audioCtx.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-12, audioCtx.currentTime);
      compressor.knee.setValueAtTime(30, audioCtx.currentTime);
      compressor.ratio.setValueAtTime(12, audioCtx.currentTime);
      compressor.attack.setValueAtTime(0.003, audioCtx.currentTime);
      compressor.release.setValueAtTime(0.25, audioCtx.currentTime);

      mediaSourceNode = audioCtx.createMediaElementSource(audioElement);
      mediaSourceNode.connect(gainNode);
      gainNode.connect(compressor);
      compressor.connect(audioCtx.destination);
    }

    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
  } catch (e) {
    console.warn('[VoicePlugin] 音量增益节点初始化跳过:', e);
  }
}

jQuery(async () => {
  console.log('[VoicePlugin] 正在启动纯原生语音附件扩展 v2.0.1...');

  // 轮询等待输入栏就绪
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

  // 核心钩子：监听酒馆原生生成前夕
  registerNativeGenerationHook();
});

function initVoiceUI($sendBtn, $textarea) {
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

  // 语音挂载小胶囊 (带试听与删除)
  const $attachmentChip = $(`
    <div id="gemini_voice_chip" class="gemini-voice-chip"
         style="display:none; width:fit-content; max-width:min(260px, calc(100vw - 40px)); margin:4px 8px; padding:4px 8px 4px 10px; border-radius:18px; box-sizing:border-box; z-index:10; align-items:center; justify-content:space-between; gap:6px;">
      <div class="gemini-voice-chip-left" id="gemini_voice_chip_play_area" title="点击试听或暂停(已音量放大)" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <button id="gemini_voice_chip_play" class="chip-play-btn" type="button" style="width:26px; height:26px; border-radius:13px; font-size:10px; flex-shrink:0;">▶</button>
        <div class="chip-waves" id="gemini_voice_chip_waves">
          <span></span><span></span><span></span><span></span>
        </div>
        <span id="gemini_voice_chip_dur" class="chip-duration" style="font-size:13px; font-weight:700; color:#a5b4fc;">0"</span>
        <span class="chip-label" style="font-size:12px; font-weight:500;">🎙️ 语音附件 (试听)</span>
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

  // ==================== 录音控制绑定 ====================

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (pendingAudioBlob) {
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

  console.log('[VoicePlugin] 插件 v2.0.1 就绪！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音插件 v2.0.1 已就绪！(已增强音量与长对话稳定性)');
  }
}

// ==================== 录音逻辑 ====================

async function startVoiceRecording() {
  audioChunks = [];
  try {
    // 如果有未关闭的残留流，先彻底释放
    if (currentActiveStream) {
      try {
        currentActiveStream.getTracks().forEach(t => t.stop());
      } catch (e) {}
      currentActiveStream = null;
    }

    // 录音拾音优化：启用自动增益(AGC)，关闭暴力降噪以保留自然声学泛音
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        sampleRate: 48000,
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: true
      }
    });

    currentActiveStream = stream;

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
      if (currentActiveStream) {
        currentActiveStream.getTracks().forEach(t => t.stop());
        currentActiveStream = null;
      }
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
    try { mediaRecorder.stop(); } catch (e) {}
  }

  // 严格释放手机音频设备，防止多轮录音后句柄耗尽
  if (currentActiveStream) {
    try {
      currentActiveStream.getTracks().forEach(t => t.stop());
    } catch (e) {}
    currentActiveStream = null;
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

// 挂载到输入框上方
function attachAudioAsPending(blob, seconds) {
  pendingAudioBlob = blob;
  pendingAudioDuration = seconds;
  if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
  pendingAudioUrl = URL.createObjectURL(blob);
  previewAudio.src = pendingAudioUrl;

  // 异步预转 Base64，确保在用户快速点击发送时立即可用
  base64Promise = new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      pendingAudioBase64 = reader.result.split(',')[1];
      resolve(pendingAudioBase64);
    };
    reader.readAsDataURL(blob);
  });

  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').css('display', 'inline-flex').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');

  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音附件已挂载！直接输入文字一起发送');
  }
}

function discardVoiceAttachment() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }

  // 仅在当前 URL 没有被历史聊天消息使用时释放
  if (pendingAudioUrl && pendingAudioUrl !== lastRenderAudioUrl) {
    try { URL.revokeObjectURL(pendingAudioUrl); } catch (e) {}
  }

  pendingAudioBlob = null;
  pendingAudioBase64 = null;
  base64Promise = null;
  pendingAudioUrl = null;
  pendingAudioDuration = 0;

  $('#gemini_voice_chip_play').text('▶');
  $('#gemini_voice_chip_waves').removeClass('playing');
  $('#gemini_voice_chip').slideUp(150);
  $('#gemini_voice_mic_btn').removeClass('attached');
}

function togglePreviewAudio() {
  if (!previewAudio.src) return;

  // 激活 Web Audio API 3.0倍硬件音量放大
  setupAudioGain(previewAudio, 3.0);

  if (previewAudio.paused) {
    previewAudio.play().then(() => {
      $('#gemini_voice_chip_play').text('⏸');
      $('#gemini_voice_chip_waves').addClass('playing');
    }).catch(err => {
      console.warn('[VoicePlugin] 试听播放失败:', err);
    });
  } else {
    previewAudio.pause();
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  }
}

// ==================== 核心：酒馆原生请求挂载 ====================

function registerNativeGenerationHook() {
  // 当用户点击酒馆原生发送时，在此把挂载的语音注入到发送报文中
  eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, async (generate_data) => {
    // 1. 如果 Base64 仍在转换中，等待其就绪
    if (!pendingAudioBase64 && base64Promise) {
      await base64Promise;
    }

    if (!pendingAudioBase64 || !generate_data || !Array.isArray(generate_data.messages)) {
      return;
    }

    console.log('[VoicePlugin] 捕获到酒馆原生发送！正在注入真实音频附件...');

    // 关键修复：长对话后，末尾经常有系统深度提示词(Depth Prompt)或作者附言！
    // 必须从后往前查找真正的用户消息，绝不能盲目取 messages[messages.length - 1]！
    const lastUserMsg = generate_data.messages.slice().reverse().find(m => m.role === 'user');
    if (!lastUserMsg) {
      console.warn('[VoicePlugin] 未能在生成消息列表中定位到 user 消息');
      return;
    }

    const base64Data = pendingAudioBase64;
    const mimeType = pendingAudioBlob?.type || 'audio/webm';
    const originalText = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';

    const multimodalContent = [];

    // 1. 酒馆官方标准 audio_url 规范 (酒馆后端自动转为 Gemini 原生 inlineData 多模态流)
    multimodalContent.push({
      type: 'audio_url',
      audio_url: {
        url: `data:${mimeType};base64,${base64Data}`
      }
    });

    // 2. OpenAI 官方标准 input_audio 规范 (针对 OpenAI 兼容协议)
    multimodalContent.push({
      type: 'input_audio',
      input_audio: {
        data: base64Data,
        format: mimeType.includes('mp4') ? 'mp4' : 'wav'
      }
    });

    // 3. 用户输入的文字正文
    if (originalText) {
      multimodalContent.push({
        type: 'text',
        text: originalText
      });
    }

    lastUserMsg.content = multimodalContent;

    console.log('[VoicePlugin] 原生音频 Part 注入完成！交由酒馆核心发送。');

    // 暂存用于聊天气泡渲染的 URL，防止被 discardVoiceAttachment 提前销毁
    lastRenderAudioUrl = pendingAudioUrl;
    lastRenderAudioDuration = pendingAudioDuration;

    setTimeout(() => {
      discardVoiceAttachment();
    }, 100);
  });

  // 渲染用户消息上的播放器 (仅限前端展示，不污染 mes 正文)
  eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
    if (lastRenderAudioUrl) {
      const $lastMsg = $('.mes[mesid="' + messageId + '"], .mes:last');
      if ($lastMsg.length && $lastMsg.find('.st-voice-player-row').length === 0) {
        const playerHtml = `
          <div class="st-gemini-voice-bubble" style="margin-bottom:6px;">
            <div class="st-voice-player-row" style="display:flex; align-items:center; gap:8px;">
              <audio class="st-voice-audio" controls src="${lastRenderAudioUrl}" style="height:32px; max-width:210px;"></audio>
              <span style="font-size:12px; font-weight:600; color:#818cf8;">${lastRenderAudioDuration}"</span>
            </div>
          </div>
        `;
        $lastMsg.find('.mes_text').prepend(playerHtml);
        lastRenderAudioUrl = null;
      }
    }
  });
}
