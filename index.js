/**
 * SillyTavern Gemini 语音附件扩展 (SillyTavern 1.12.14 原生多模态增强版)
 *
 * 核心设计升级：
 * 1. 100% 走酒馆原生通道：直接复用你在酒馆里配置好的 API、模型与密钥，绝不在插件里重复配置！
 * 2. 像图片一样随文字一起发：录完音挂载在输入框，打字后点发送，文字与音频在同一个请求里一次性发给 Gemini！
 * 3. 拒绝奇怪的两步预解析：AI 在同一轮对话中直接“听见语音 + 看见文字”，体验与微信/QQ多模态完全一致！
 * 4. 原地试听与一键丢弃：挂载时自带 ▶ 试听播放条，点 ✕ 秒删丢弃不发送。
 */

let mediaRecorder = null;
let audioChunks = [];
let recordedBlob = null;
let recordedUrl = null;
let recordedDuration = 0;
let previewAudio = new Audio();
let isRecording = false;
let recordTimer = null;
let recordSeconds = 0;

jQuery(async () => {
  console.log('[GeminiVoice] SillyTavern 原生语音附件扩展正在初始化...');

  // 确保酒馆开启多模态媒体内联 (media_inlining)
  enableNativeMediaInlining();

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

// 自动确保酒馆设置开启了多模态附件支持
function enableNativeMediaInlining() {
  try {
    if (window.oai_settings) {
      window.oai_settings.media_inlining = true;
    }
  } catch (e) {}
}

function initVoiceUI($sendBtn, $textarea) {
  // 清理可能存在的历史元素
  $('#gemini_voice_mic_btn').remove();
  $('#gemini_voice_recording_banner').remove();
  $('#gemini_voice_chip').remove();

  console.log('[GeminiVoice] 正在注入麦克风及原生挂载控件...');

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

  // 录音中的轻量状态条 (放在输入区域外部正上方)
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

  // 语音挂载小药丸胶囊 (带试听与删除)
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

  // 插入在输入组件之上，绝不遮挡输入框
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

  // ==================== 事件绑定 ====================

  $micBtn.on('click', async (e) => {
    e.preventDefault();
    if (!isRecording) {
      if (recordedBlob) {
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

  // 点击 ✕ 立即删除不发送
  $('#gemini_voice_chip_del').on('click', (e) => {
    e.stopPropagation();
    discardVoiceAttachment();
  });

  previewAudio.onended = () => {
    $('#gemini_voice_chip_play').text('▶');
    $('#gemini_voice_chip_waves').removeClass('playing');
  };

  // 监听酒馆原生发送事件：发送后自动清理挂载状态
  const nativeSendHandler = () => {
    if (recordedBlob) {
      setTimeout(() => {
        discardVoiceAttachment(false); // 发送后清理，不弹提示
      }, 300);
    }
  };

  if ($sendBtn.length) {
    $sendBtn.on('click', nativeSendHandler);
  }
  $textarea.on('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      nativeSendHandler();
    }
  });

  console.log('[GeminiVoice] 原生语音挂载扩展 v1.1.0 就绪！');
  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ Gemini 原生语音附件已就绪！直接复用酒馆当前 API 与模型');
  }
}

// ==================== 录音引擎 ====================

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
    attachVoiceAsNativeFile(blob, Math.max(1, recordSeconds));
  }
}

function updateTimerDisplay() {
  const m = Math.floor(recordSeconds / 60).toString().padStart(2, '0');
  const s = (recordSeconds % 60).toString().padStart(2, '0');
  $('#gemini_voice_timer').text(`正在录音 ${m}:${s}`);
}

// ==================== 核心：将录音挂载到酒馆原生文件队列 ====================

function attachVoiceAsNativeFile(blob, seconds) {
  recordedBlob = blob;
  recordedDuration = seconds;
  if (recordedUrl) URL.revokeObjectURL(recordedUrl);
  recordedUrl = URL.createObjectURL(blob);
  previewAudio.src = recordedUrl;

  // 1. 将音频 Blob 封装成原生 File 对象
  const ext = blob.type.includes('mp4') ? 'mp4' : 'webm';
  const audioFile = new File([blob], `voice_${seconds}s.${ext}`, { type: blob.type });

  // 2. 注入到酒馆原生 #file_form_input 队列中
  const fileInput = document.getElementById('file_form_input');
  if (fileInput) {
    try {
      const dataTransfer = new DataTransfer();
      dataTransfer.items.add(audioFile);
      fileInput.files = dataTransfer.files;
      // 触发酒馆的附件识别逻辑
      $(fileInput).trigger('change');
      // 隐藏酒馆自带生硬的纯文本文件名条，用我们精致的播放胶囊呈现
      $('#file_form').addClass('displayNone');
    } catch (e) {
      console.warn('[GeminiVoice] DataTransfer 写入受限:', e);
    }
  }

  // 3. 展示试听与删除小胶囊
  $('#gemini_voice_chip_dur').text(`${seconds}"`);
  $('#gemini_voice_chip').css('display', 'inline-flex').slideDown(180);
  $('#gemini_voice_mic_btn').addClass('attached');

  enableNativeMediaInlining();

  if (typeof toastr !== 'undefined') {
    toastr.success('🎙️ 语音已挂载！像图片一样随输入框文字一起发送');
  }
}

// 移除/丢弃语音附件
function discardVoiceAttachment(notify = true) {
  if (previewAudio) {
    previewAudio.pause();
    previewAudio.src = '';
  }
  if (recordedUrl) {
    URL.revokeObjectURL(recordedUrl);
    recordedUrl = null;
  }
  recordedBlob = null;
  recordedDuration = 0;

  // 清空酒馆原生附件队列
  const fileInput = document.getElementById('file_form_input');
  if (fileInput) {
    fileInput.value = '';
    $('#file_form').trigger('reset').addClass('displayNone');
  }

  $('#gemini_voice_chip_play').text('▶');
  $('#gemini_voice_chip_waves').removeClass('playing');
  $('#gemini_voice_chip').slideUp(150);
  $('#gemini_voice_mic_btn').removeClass('attached');

  if (notify && typeof toastr !== 'undefined') {
    toastr.info('已丢弃语音附件');
  }
}

// 试听播放 / 暂停
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
