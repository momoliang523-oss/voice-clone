/* 日语声音克隆 - 前端逻辑 */
(() => {
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => document.querySelectorAll(sel);

  /* ---------- 通用 ---------- */

  let CONFIG = { public_mode: false };
  let toastTimer = null;
  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.add("hidden"), 4000);
  }

  async function api(path, options = {}) {
    const resp = await fetch(path, options);
    if (!resp.ok) {
      let detail = `请求失败 (${resp.status})`;
      try {
        const body = await resp.json();
        if (body.detail) detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
      } catch (_) { /* 非 JSON 响应 */ }
      throw new Error(detail);
    }
    return resp;
  }

  function fmtDuration(sec) {
    if (sec == null) return "—";
    sec = Math.round(sec);
    const m = Math.floor(sec / 60), s = sec % 60;
    return m > 0 ? `${m}分${s.toString().padStart(2, "0")}秒` : `${s}秒`;
  }

  function fmtTime(iso) {
    return iso ? new Date(iso).toLocaleString("zh-CN") : "—";
  }

  /* ---------- 页签 ---------- */

  $("#tabs").addEventListener("click", (e) => {
    const btn = e.target.closest(".tab");
    if (!btn) return;
    $$(".tab").forEach((t) => t.classList.toggle("active", t === btn));
    $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "tab-" + btn.dataset.tab));
    if (btn.dataset.tab === "library") loadLibrary();
    if (btn.dataset.tab === "tts") loadVoicesForTts();
  });

  /* ---------- ① 录音 ---------- */

  let mediaRecorder = null;
  let recChunks = [];
  let recBlob = null;
  let recTimerId = null;
  let recStartAt = 0;
  let audioCtx = null;
  let meterRaf = null;

  function pickMime() {
    const candidates = ["audio/webm;codecs=opus", "audio/mp4", "audio/webm"];
    return candidates.find((m) => window.MediaRecorder && MediaRecorder.isTypeSupported(m)) || "";
  }

  function recFileName() {
    const mime = mediaRecorder ? mediaRecorder.mimeType : pickMime();
    return mime.includes("mp4") ? "recording.m4a" : "recording.webm";
  }

  function micErrorMessage(err) {
    switch (err && err.name) {
      case "NotAllowedError":
      case "SecurityError":
        return "麦克风权限被拒绝。请依次检查:① 点击浏览器地址栏左侧的 🔒/🎙 图标,把麦克风设为「允许」;② macOS「系统设置 → 隐私与安全性 → 麦克风」里勾选你的浏览器;③ Chrome 浏览器可在 chrome://settings/content/microphone 里允许,Safari 在「Safari → 设置 → 网站 → 麦克风」里允许";
      case "NotFoundError":
      case "DevicesNotFoundError":
        return "没有检测到麦克风设备,请确认麦克风已连接并在系统设置里可见";
      case "NotReadableError":
      case "TrackStartError":
        return "麦克风被其他应用占用(如通话/会议软件),请关闭后重试";
      default:
        return `无法访问麦克风:${err ? err.message : "未知错误"}`;
    }
  }

  async function checkMic() {
    const statusEl = $("#mic-status");
    statusEl.textContent = "检测中…";
    let permState = null;
    try {
      permState = (await navigator.permissions.query({ name: "microphone" })).state;
    } catch (_) { /* 部分浏览器不支持 permissions API */ }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      stream.getTracks().forEach((t) => t.stop());
      const devices = await navigator.mediaDevices.enumerateDevices();
      const mics = devices.filter((d) => d.kind === "audioinput" && d.deviceId);
      const stateText = { granted: "已授权", prompt: "每次询问", denied: "已被拒绝" }[permState] || "";
      statusEl.textContent =
        `✅ 麦克风可用${stateText ? `(权限状态:${stateText})` : ""}${mics.length ? `,检测到 ${mics.length} 个输入设备` : ""}。可以开始录音了。`;
    } catch (err) {
      statusEl.textContent = "❌ " + micErrorMessage(err);
    }
  }

  async function startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = pickMime();
      mediaRecorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
      recChunks = [];
      recBlob = null;
      mediaRecorder.ondataavailable = (e) => e.data.size > 0 && recChunks.push(e.data);
      mediaRecorder.onstop = onRecStop;

      // 音量条
      audioCtx = new AudioContext();
      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        analyser.getByteFrequencyData(data);
        const level = data.reduce((a, b) => a + b, 0) / data.length / 255;
        $("#meter-bar").style.width = Math.min(100, level * 300) + "%";
        meterRaf = requestAnimationFrame(tick);
      };
      tick();

      mediaRecorder.start();
      recStartAt = Date.now();
      recTimerId = setInterval(() => {
        const s = Math.floor((Date.now() - recStartAt) / 1000);
        $("#rec-timer").textContent =
          `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
      }, 200);

      $("#btn-record").disabled = true;
      $("#btn-stop").disabled = false;
      $("#rec-preview").classList.add("hidden");
      $("#btn-record").textContent = "🔴 录音中…";
    } catch (err) {
      $("#mic-status").textContent = "❌ " + micErrorMessage(err);
      toast("无法访问麦克风,详见录音区的提示", true);
    }
  }

  function stopRecording() {
    if (!mediaRecorder) return;
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach((t) => t.stop());
    clearInterval(recTimerId);
    cancelAnimationFrame(meterRaf);
    $("#meter-bar").style.width = "0%";
    $("#btn-record").disabled = false;
    $("#btn-record").textContent = "开始录音";
    $("#btn-stop").disabled = true;
    $("#rec-timer").textContent = "00:00";
  }

  function onRecStop() {
    recBlob = new Blob(recChunks, { type: mediaRecorder.mimeType || "audio/webm" });
    const url = URL.createObjectURL(recBlob);
    const audio = $("#rec-audio");
    audio.src = url;
    audio.onloadedmetadata = () => {
      const dur = audio.duration;
      let info = `录制时长:${fmtDuration(dur)}`;
      if (dur < 10) info += " ⚠️ 不足 10 秒,克隆效果可能不佳(服务端会自动垫长)";
      $("#rec-info").textContent = info;
    };
    $("#rec-preview").classList.remove("hidden");
  }

  $("#btn-record").addEventListener("click", startRecording);
  $("#btn-stop").addEventListener("click", stopRecording);
  $("#btn-check-mic").addEventListener("click", checkMic);
  $("#btn-rerecord").addEventListener("click", () => {
    recBlob = null;
    $("#rec-audio").src = "";
    $("#rec-info").textContent = "";
    $("#rec-preview").classList.add("hidden");
  });

  /* ---------- ① 上传文件 ---------- */

  $("#file-input").addEventListener("change", () => {
    const list = $("#file-list");
    list.innerHTML = "";
    for (const f of $("#file-input").files) {
      const li = document.createElement("li");
      li.textContent = `${f.name}(约 ${(f.size / 1024 / 1024).toFixed(2)} MB)`;
      list.appendChild(li);
    }
  });

  /* ---------- ① 克隆 ---------- */

  $("#btn-clone").addEventListener("click", async () => {
    const files = Array.from($("#file-input").files);
    if (!recBlob && files.length === 0) return toast("请先录音或上传音频文件", true);
    if (files.length > 3) return toast("最多上传 3 个音频文件", true);
    if (recBlob && files.length >= 3) return toast("录音 + 上传合计最多 3 个", true);

    const form = new FormData();
    form.append("title", $("#voice-title").value.trim());
    if (recBlob) form.append("files", recBlob, recFileName());
    files.forEach((f) => form.append("files", f));

    const btn = $("#btn-clone");
    btn.disabled = true;
    btn.textContent = "克隆中…(约几秒到1分钟)";
    const result = $("#clone-result");
    result.classList.add("hidden");
    try {
      const resp = await api("/api/clone", { method: "POST", body: form });
      const data = await resp.json();
      result.textContent = `✅ 克隆成功!声音 ID:${data.voice_id}(状态:${data.state})去「② 声音库」查看`;
      result.className = "result ok";
      $("#voice-title").value = "";
    } catch (err) {
      result.textContent = `❌ ${err.message}`;
      result.className = "result error";
    } finally {
      btn.disabled = false;
      btn.textContent = "开始克隆";
    }
  });

  /* ---------- ② 声音库 ---------- */

  const STATE_TEXT = {
    trained: "可用", training: "训练中", created: "创建中",
    failed: "失败", error: "失败", deleted: "已删", deleted_remote: "云端已删",
  };

  function voicePreviewUrl(v) {
    return `/audio/samples/${encodeURIComponent(v.voice_id)}/sample.mp3`;
  }

  async function loadLibrary() {
    const tbody = $("#voice-tbody");
    tbody.innerHTML = "";
    let voices = [];
    try {
      const resp = await api("/api/voices");
      voices = (await resp.json()).voices;
    } catch (err) {
      toast(err.message, true);
      return;
    }
    $("#library-empty").classList.toggle("hidden", voices.length > 0);
    for (const v of voices) {
      const tr = document.createElement("tr");
      const stateCls = v.state === "trained" ? "ok" : (v.state === "training" || v.state === "created") ? "warn" : "bad";
      const actions = CONFIG.public_mode
        ? '<button class="btn small" data-act="play">试听</button>'
        : '<button class="btn small" data-act="play">试听</button><button class="btn small danger" data-act="del">删除</button>';
      tr.innerHTML = `
        <td><b>${escapeHtml(v.title)}</b></td>
        <td class="mono" title="${escapeHtml(v.voice_id)}">${escapeHtml(v.voice_id.slice(0, 12))}…</td>
        <td><span class="badge ${stateCls}">${STATE_TEXT[v.state] || v.state}</span></td>
        <td>${fmtDuration(v.duration)}</td>
        <td class="hint">${fmtTime(v.created_at)}</td>
        <td class="actions">${actions}</td>`;
      tr.querySelector('[data-act="play"]').addEventListener("click", () => playAudio(voicePreviewUrl(v), v.title));
      if (!CONFIG.public_mode) {
        tr.querySelector('[data-act="del"]').addEventListener("click", () => deleteVoice(v));
      }
      tbody.appendChild(tr);
    }
  }

  function playAudio(url, title) {
    const player = document.createElement("audio");
    player.controls = true;
    player.src = url;
    player.onerror = () => toast(`没有 ${title} 的试听样本`, true);
    const wrapper = $("#global-player");
    wrapper.innerHTML = "";
    wrapper.appendChild(player);
    player.play().catch(() => { /* 用户手动点播放 */ });
  }

  async function deleteVoice(v) {
    if (!confirm(`确定删除「${v.title}」吗?会同时删除 Fish 云端模型,不可恢复。`)) return;
    try {
      await api(`/api/voices/${encodeURIComponent(v.voice_id)}`, { method: "DELETE" });
      toast(`已删除「${v.title}」`);
      loadLibrary();
    } catch (err) {
      toast(err.message, true);
    }
  }

  $("#btn-sync").addEventListener("click", async () => {
    toast("正在与云端同步…");
    try {
      await api("/api/voices/sync");
      toast("同步完成");
      loadLibrary();
    } catch (err) {
      toast(`同步失败:${err.message}`, true);
    }
  });

  /* ---------- ③ TTS ---------- */

  async function loadVoicesForTts() {
    const sel = $("#tts-voice");
    const prev = sel.value;
    sel.innerHTML = "";
    try {
      const resp = await api("/api/voices");
      const voices = (await resp.json()).voices.filter((v) => v.state !== "deleted_remote");
      if (voices.length === 0) {
        sel.innerHTML = '<option value="">(还没有可用声音,先去克隆)</option>';
        return;
      }
      for (const v of voices) {
        const opt = document.createElement("option");
        opt.value = v.voice_id;
        opt.textContent = `${v.title}${v.state === "trained" ? "" : `(${STATE_TEXT[v.state] || v.state})`}`;
        sel.appendChild(opt);
      }
      if (prev) sel.value = prev;
    } catch (err) {
      toast(err.message, true);
    }
  }

  $("#tts-text").addEventListener("input", () => {
    $("#tts-count").textContent = `${$("#tts-text").value.length} / 1000`;
  });

  $("#btn-tts").addEventListener("click", async () => {
    const text = $("#tts-text").value.trim();
    const voiceId = $("#tts-voice").value;
    if (!text) return toast("请输入日语文本", true);
    if (!voiceId) return toast("请先选择声音(没有的话去克隆一个)", true);

    const btn = $("#btn-tts");
    btn.disabled = true;
    btn.textContent = "生成中…";
    try {
      const resp = await api("/api/tts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text, voice_id: voiceId }),
      });
      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const audio = $("#tts-audio");
      audio.src = url;
      $("#tts-download").href = url;
      $("#tts-result").classList.remove("hidden");
      toast("生成成功");
    } catch (err) {
      toast(err.message, true);
    } finally {
      btn.disabled = false;
      btn.textContent = "生成语音";
    }
  });

  /* ---------- ④ 扣子插件 ---------- */

  async function loadPluginInfo() {
    try {
      const resp = await api("/openapi.json");
      const spec = await resp.json();
      $("#plugin-server").textContent = spec.servers?.[0]?.url || "—";
    } catch (_) { /* 忽略 */ }
  }

  /* ---------- 工具 ---------- */

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  /* ---------- 初始化 ---------- */

  function applyPublicMode() {
    // 公开模式: 隐藏克隆页签与同步按钮,默认切到合成页
    document.querySelector('.tab[data-tab="clone"]').classList.add("hidden");
    $("#tab-clone").classList.remove("active");
    $("#btn-sync").classList.add("hidden");
    const ttsTab = document.querySelector('.tab[data-tab="tts"]');
    ttsTab.classList.add("active");
    $("#tab-tts").classList.add("active");
    loadVoicesForTts();
  }

  (async () => {
    try {
      const resp = await api("/api/config");
      CONFIG = await resp.json();
    } catch (_) { /* 保持默认(本地个人模式) */ }
    if (CONFIG.public_mode) {
      applyPublicMode();
    }
    loadLibrary();
    loadPluginInfo();
  })();
})();
