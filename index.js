/**
 * 语音插件 (v2.1.0 - 真正的酒馆原生附件流，修复 audio_url 规范传真音频)
 *
 * 核心逻辑：
 * 1. 像发图片一样发语音：录音完成后挂载在输入框上方，打字后点击酒馆自带的【发送】按钮。
 * 2. 100% 走酒馆原生通道：不碰任何外部 API 请求，直接通过酒馆原生后台与密钥发送，绝不报 miss api key！
 * 3. 严格遵循酒馆 prompt-converters 规范：注入官方 audio_url，酒馆后端会自动转为 Gemini 的 inlineData 真实音频传给模型！
 * 4. 预览与一键删除：挂载时可点 ▶ 试听，点 ✕ 立即丢弃不发送。
 */

import { eventSource, event_types } from '../../../../script.js';

let mediaRecorder = null;
let audioChunks = [];
let pendingAudioBlob = null;
let pendingAudioBase64 = null;
let pendingAudioUrl = null;
let pendingAudioDuration = 0;
let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

jQuery(async () => {
  console.log('[VoicePlugin] 正在启动纯原生语音附件扩展 v2.1.0...');

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

  // 核心钩子：监听酒馆原生生成前夕 (CHAT_COMPLETION_SETTINGS_READY)
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

  // 录音中轻量条幅
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

  // 语音附件预览胶囊 (挂在输入框正上方，支持试听与 ✕ 丢弃)
  const $attachmentChip = $(`
    <div id="gemini_voice_chip" class="gemini-voice-chip"
         style="display:none; width:fit-content; max-width:min(260px, calc(100vw - 40px)); margin:4px 8px; padding:4px 8px 4px 10px; border-radius:18px; box-sizing:border-box; z-index:10; align-items:center; justify-content:space-between; gap:6px;">
      <div class="gemini-voice-chip-left" id="gemini_voice_chip_play_area" title="点击试听或暂停" style="display:flex; align-items:center; gap:6px; cursor:pointer;">
        <button id="gemini_voice_chip_play" class="chip-play-btn" type="button" style="width:26px; height:26px; border-radius:13px; font-size:10px; flex-shrink:0;">▶</button>
        <div class="chip-waves" id="gemini_voice_chip_waves">
          <span></span><span></span><span></span><span></span>
        </div>
        <span id="gemini_voice_chip_dur" class="chip-duration" style="font-size:13px; font-weight:700; color:#a5b4fc;">0"</span>
        <span class="chip-label" style="font-size:12px; font-weight:500;">🎙️ 语音附件 (可试听)</span>
      </div>
      <button id="gemini_voice_chip_del" class="chip-del-btn" type="button" title="点击删除语音附件"
              style="width:28px; height:28px; border-radius:14px; font-size:15px; font-weight:bold; margin-left:6px; flex-shrink:0; cursor:pointer; touch-action:manipulation;">✕</button>
    </div>
  `);

  // 严格插在 #nonQRFormItems 正上方，绝不遮挡输入框
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
        if (typeof toastr !== 'undefined') toastr.info('已有语音附件，请先发送或点 ✕ 删除再录');
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

  // 点击 ✕ 立即删除不发送
  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  console.log('[VoicePlugin] 插件 v2.1.0 UI 就绪！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音插件 v2.1.0 已就绪！');
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

// 挂载到输入框上方 (仿图片附件)
function attachAudioAsPending(blob, seconds) {
  pendingAudioBlob = blob;
  pendingAudioDuration = seconds;
  if (pendingAudioUrl) URL.revokeObjectURL(pendingAudioUrl);
  pendingAudioUrl = URL.createObjectURL(blob);
  previewAudio.src = pendingAudioUrl;

  const reader = new FileReader();
  reader.onloadend = () => {
    pendingAudioBase64 = reader.result.split(',')[1];
  };
  reader.readAsDataURL(blob);

  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').css('display', 'inline-flex').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');

  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音附件已挂载！直接输入文字即可一起发送');
  }
}

function discardVoiceAttachment() {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }
  if (pendingAudioUrl) {
    URL.revokeObjectURL(pendingAudioUrl);
    pendingAudioUrl = null;
  }
  pendingAudioBlob = null;
  pendingAudioBase64 = null;
  pendingAudioDuration = 0;

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

// ==================== 核心：酒馆原生请求拦截挂载 ====================

function registerNativeGenerationHook() {
  // 监听酒馆原生生成参数准备就绪事件 (发生在酒馆向后台发请求的前一瞬间)
  eventSource.on(event_types.CHAT_COMPLETION_SETTINGS_READY, (generate_data) => {
    if (!pendingAudioBase64 || !generate_data || !Array.isArray(generate_data.messages)) {
      return;
    }

    console.log('[VoicePlugin] 捕获到酒馆原生发送！正在注入真实音频数据流...');

    const lastUserMsg = generate_data.messages[generate_data.messages.length - 1];
    if (!lastUserMsg || lastUserMsg.role !== 'user') return;

    const base64Data = pendingAudioBase64;
    const mimeType = pendingAudioBlob?.type || 'audio/webm';
    const originalText = typeof lastUserMsg.content === 'string' ? lastUserMsg.content : '';

    const multimodalContent = [];

    // 1. 酒馆官方原生 audio_url 规范 (SillyTavern prompt-converters 识别后会自动转为 Gemini 原生 inlineData！)
    multimodalContent.push({
      type: 'audio_url',
      audio_url: {
        url: `data:${mimeType};base64,${base64Data}`
      }
    });

    // 2. 标准 OpenAI input_audio 格式 (如果反代走的是纯 OpenAI 转发协议)
    multimodalContent.push({
      type: 'input_audio',
      input_audio: {
        data: base64Data,
        format: mimeType.includes('mp4') ? 'mp4' : 'wav'
      }
    });

    // 3. 用户输入的文字正文 (原汁原味，不加画蛇添足的伪系统提示)
    if (originalText) {
      multimodalContent.push({
        type: 'text',
        text: originalText
      });
    } else {
      multimodalContent.push({
        type: 'text',
        text: '（发送了一段语音）'
      });
    }

    lastUserMsg.content = multimodalContent;

    console.log('[VoicePlugin] 原生音频 Part 注入成功！通过酒馆原生 API 一同送达 AI。');

    setTimeout(() => {
      discardVoiceAttachment();
    }, 100);
  });

  // 渲染用户消息上的播放器 (仅限前端展示，不污染 mes 正文)
  eventSource.on(event_types.USER_MESSAGE_RENDERED, (messageId) => {
    if (pendingAudioUrl) {
      const $lastMsg = $('.mes[mesid="' + messageId + '"], .mes:last');
      if ($lastMsg.length && $lastMsg.find('.st-voice-player-row').length === 0) {
        const playerHtml = `
          <div class="st-gemini-voice-bubble" style="margin-bottom:6px;">
            <div class="st-voice-player-row" style="display:flex; align-items:center; gap:8px;">
              <audio class="st-voice-audio" controls src="${pendingAudioUrl}" style="height:32px; max-width:210px;"></audio>
              <span style="font-size:12px; font-weight:600; color:#818cf8;">${pendingAudioDuration}"</span>
            </div>
          </div>
        `;
        $lastMsg.find('.mes_text').prepend(playerHtml);
      }
    }
  });
}
