// overlay.js — Content script: floating record button on visio pages
// Injected by manifest.json into matching visio URLs

(function() {
  'use strict';

  if (document.getElementById('mirai-overlay')) return;

  const B = (typeof browser !== 'undefined') ? browser : chrome;

  // ──────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────
  let isRecording = false;
  let isMinimized = false;
  let startTs = null;
  let timerInterval = null;
  let minimizeTimeout = null;
  let detectedPlatform = '';
  let detectedMeetingId = '';
  let needsPassword = false;

  // ──────────────────────────────────────────────
  // Detect platform & meeting ID
  // ──────────────────────────────────────────────
  const url = window.location.href.toLowerCase();
  const host = window.location.hostname.toLowerCase();

  if (url.includes('visio.numerique')) {
    detectedPlatform = 'visio';
  } else if (url.includes('webconf.numerique') || (url.includes('webconf') && !url.includes('comu'))) {
    detectedPlatform = 'webconf';
  } else if (url.includes('comu') || (url.includes('webconf') && url.includes('comu'))) {
    detectedPlatform = 'comu';
    needsPassword = true;
  } else if (url.includes('webinaire')) {
    detectedPlatform = 'webinaire';
  } else if (url.includes('webex')) {
    detectedPlatform = 'webex';
    needsPassword = true;
  } else if (url.includes('meet.google') || url.includes('gmeet')) {
    detectedPlatform = 'gmeet';
  } else if (url.includes('teams')) {
    detectedPlatform = 'teams';
    needsPassword = true;
  }

  if (!detectedPlatform) return;

  // Extract meeting ID
  if (host.includes('webconf.numerique') || host.includes('visio.numerique')) {
    const parts = window.location.pathname.split('/').filter(Boolean);
    if (parts.length > 0) detectedMeetingId = parts[0].split(/[?#]/)[0];
  }
  if (!detectedMeetingId) {
    const patterns = [/\/meet\/([\w-]+)/i, /meeting\/([\w-]+)/i, /\/(\d{9,})/i, /\/r\/([\w-]+)/i, /\/webinar\/(\d+)/i];
    for (const regex of patterns) {
      const match = url.match(regex);
      if (match && match[1]) { detectedMeetingId = match[1]; break; }
    }
  }

  // ──────────────────────────────────────────────
  // Create overlay
  // ──────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'mirai-overlay';
  overlay.innerHTML = `
    <div id="mirai-pill">
      <button id="mirai-rec-btn" title="Demarrer l'enregistrement MirAI">
        <span id="mirai-rec-dot"></span>
      </button>
      <span id="mirai-timer">REC</span>
      <div id="mirai-fields">
        <input id="mirai-login" type="text" placeholder="Identifiant reunion" />
        <input id="mirai-password" type="password" placeholder="Mot de passe" />
      </div>
      <span id="mirai-status"></span>
      <button id="mirai-minimize" title="Reduire">&#8722;</button>
      <button id="mirai-close" title="Masquer">&times;</button>
    </div>
    <div id="mirai-mini">
      <span id="mirai-mini-dot"></span>
      <span id="mirai-mini-timer"></span>
    </div>
    <div id="mirai-wizard">
      <div id="mirai-wizard-title">IAssistant-Direct <span style="opacity:.6">(by Mirai)</span></div>
      <div id="mirai-wizard-body">
        Capturez et transcrivez automatiquement vos r&eacute;unions en ligne
        (Webconf, Visio, COMU, Webex, Meet, Teams&hellip;).
        <br><br>
        Pour activer le plug-in, connectez-vous avec votre compte minist&eacute;riel
        en cliquant ci-dessous.
      </div>
      <button id="mirai-wizard-login">Se connecter pour activer</button>
      <button id="mirai-wizard-cancel">Annuler</button>
      <div id="mirai-wizard-status"></div>
    </div>
  `;

  const style = document.createElement('style');
  style.textContent = `
    #mirai-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483647;
      font-family: system-ui, -apple-system, sans-serif;
      font-size: 13px;
      cursor: grab;
      user-select: none;
    }
    #mirai-overlay.dragging {
      cursor: grabbing;
      transition: none !important;
    }

    /* ── Full pill ── */
    #mirai-pill {
      display: flex;
      align-items: center;
      gap: 8px;
      background: rgba(20, 20, 20, 0.55);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      padding: 8px 12px;
      border-radius: 28px;
      box-shadow: 0 2px 16px rgba(0,0,0,0.15);
      color: rgba(255,255,255,0.85);
      transition: all 0.35s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0.6;
      transform-origin: bottom right;
      animation: mirai-fadein 0.4s ease;
    }
    #mirai-pill:hover {
      opacity: 1;
      background: rgba(20, 20, 20, 0.8);
      box-shadow: 0 4px 24px rgba(0,0,0,0.25);
    }
    @keyframes mirai-fadein {
      from { opacity: 0; transform: translateY(10px) scale(0.95); }
      to { opacity: 0.6; transform: translateY(0) scale(1); }
    }
    #mirai-pill.hidden { display: none; }

    /* ── Onboarding wizard (no token) ── */
    #mirai-wizard {
      display: none;
      width: 280px;
      background: rgba(20, 20, 20, 0.92);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      padding: 16px 18px;
      border-radius: 16px;
      box-shadow: 0 6px 28px rgba(0,0,0,0.35);
      color: rgba(255,255,255,0.9);
      cursor: default;
      animation: mirai-fadein 0.3s ease;
    }
    #mirai-wizard.show { display: block; opacity: 1; }
    #mirai-wizard-title { font-size: 14px; font-weight: 700; margin-bottom: 8px; }
    #mirai-wizard-body { font-size: 12px; line-height: 1.45; color: rgba(255,255,255,0.78); margin-bottom: 14px; }
    #mirai-wizard-login {
      display: block; width: 100%; box-sizing: border-box;
      background: #0072cf; color: #fff; border: none; border-radius: 10px;
      padding: 9px 12px; font-size: 13px; font-weight: 600; cursor: pointer;
      transition: background 0.2s;
    }
    #mirai-wizard-login:hover { background: #0a84ff; }
    #mirai-wizard-cancel {
      display: block; width: 100%; box-sizing: border-box; margin-top: 8px;
      background: transparent; color: rgba(255,255,255,0.6); border: none;
      padding: 6px; font-size: 12px; cursor: pointer; text-decoration: underline;
    }
    #mirai-wizard-cancel:hover { color: rgba(255,255,255,0.9); }
    #mirai-wizard-status { font-size: 11px; color: #d29922; margin-top: 8px; min-height: 14px; text-align: center; }

    /* ── Mini mode ── */
    #mirai-mini {
      display: none;
      align-items: center;
      gap: 5px;
      background: rgba(20, 20, 20, 0.4);
      backdrop-filter: blur(12px);
      -webkit-backdrop-filter: blur(12px);
      padding: 6px 10px;
      border-radius: 20px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.12);
      color: rgba(255,255,255,0.7);
      cursor: pointer;
      transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
      opacity: 0.35;
      transform: scale(0.9);
      transform-origin: bottom right;
      float: right;
    }
    #mirai-mini:hover {
      opacity: 0.9;
      transform: scale(1);
      background: rgba(20, 20, 20, 0.7);
      box-shadow: 0 4px 20px rgba(0,0,0,0.2);
    }
    #mirai-mini.visible {
      display: flex;
      animation: mirai-shrink 0.4s cubic-bezier(0.4, 0, 0.2, 1);
    }
    @keyframes mirai-shrink {
      from { opacity: 0; transform: scale(1.2); }
      to { opacity: 0.35; transform: scale(0.9); }
    }
    @keyframes mirai-expand {
      from { opacity: 0; transform: scale(0.8); }
      to { opacity: 0.6; transform: scale(1); }
    }

    #mirai-mini-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #888;
      display: block;
    }
    #mirai-mini-dot.recording {
      background: #e53935;
      animation: mirai-pulse 1.5s infinite;
    }
    #mirai-mini-timer {
      font-size: 11px;
      font-weight: 600;
      letter-spacing: 0.3px;
    }

    /* ── Record button ── */
    #mirai-rec-btn {
      width: 34px;
      height: 34px;
      border-radius: 50%;
      border: 2px solid rgba(255,255,255,0.25);
      background: transparent;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      transition: all 0.2s ease;
      padding: 0;
      flex-shrink: 0;
    }
    #mirai-rec-btn:hover {
      border-color: rgba(255,255,255,0.5);
      transform: scale(1.08);
    }
    /* Not recording: white dot */
    #mirai-rec-dot {
      width: 14px;
      height: 14px;
      border-radius: 50%;
      background: rgba(255,255,255,0.7);
      display: block;
      transition: all 0.3s ease;
    }
    /* Recording: red pulsing dot */
    #mirai-rec-btn.recording {
      border-color: rgba(229,57,53,0.5);
    }
    #mirai-rec-btn.recording #mirai-rec-dot {
      background: #e53935;
      animation: mirai-pulse 1.5s infinite;
    }
    @keyframes mirai-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }

    /* ── Timer ── */
    #mirai-timer {
      font-size: 12px;
      font-weight: 600;
      min-width: 30px;
      letter-spacing: 0.3px;
      color: rgba(255,255,255,0.7);
      transition: color 0.3s ease;
    }
    #mirai-pill.rec-active #mirai-timer {
      color: #fff;
      font-weight: 700;
      text-shadow: 0 0 8px rgba(255,255,255,0.9), 0 0 16px rgba(255,255,255,0.5);
    }
    #mirai-pill.rec-active {
      opacity: 0.75;
    }
    #mirai-pill.rec-active #mirai-rec-dot {
      box-shadow: 0 0 8px rgba(255,255,255,0.8), 0 0 14px rgba(229,57,53,0.6);
    }
    #mirai-pill.rec-active:hover #mirai-timer {
      color: #e53935;
      text-shadow: none;
    }
    #mirai-pill.rec-active:hover #mirai-rec-dot {
      box-shadow: none;
    }

    /* ── Status ── */
    #mirai-status {
      font-size: 11px;
      color: rgba(255,255,255,0.5);
      max-width: 140px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    /* ── Fields ── */
    #mirai-fields {
      display: none;
      gap: 5px;
    }
    #mirai-fields.visible { display: flex; }
    #mirai-fields input {
      background: rgba(255,255,255,0.1);
      border: 1px solid rgba(255,255,255,0.15);
      border-radius: 6px;
      color: #fff;
      padding: 4px 7px;
      font-size: 11px;
      width: 120px;
      outline: none;
      transition: border-color 0.2s;
    }
    #mirai-fields input::placeholder { color: rgba(255,255,255,0.3); }
    #mirai-fields input:focus { border-color: rgba(255,255,255,0.4); }

    /* ── Buttons ── */
    #mirai-minimize, #mirai-close {
      background: none;
      border: none;
      color: rgba(255,255,255,0.3);
      font-size: 15px;
      cursor: pointer;
      padding: 0 1px;
      line-height: 1;
      transition: color 0.2s;
    }
    #mirai-minimize:hover, #mirai-close:hover { color: rgba(255,255,255,0.7); }
  `;

  document.documentElement.appendChild(style);
  document.documentElement.appendChild(overlay);

  // ──────────────────────────────────────────────
  // DOM refs
  // ──────────────────────────────────────────────
  const pill = document.getElementById('mirai-pill');
  const mini = document.getElementById('mirai-mini');
  const miniDot = document.getElementById('mirai-mini-dot');
  const miniTimer = document.getElementById('mirai-mini-timer');
  const recBtn = document.getElementById('mirai-rec-btn');
  const timerEl = document.getElementById('mirai-timer');
  const statusEl = document.getElementById('mirai-status');
  const fieldsEl = document.getElementById('mirai-fields');
  const loginInput = document.getElementById('mirai-login');
  const passwordInput = document.getElementById('mirai-password');
  const minimizeBtn = document.getElementById('mirai-minimize');
  const closeBtn = document.getElementById('mirai-close');

  // ──────────────────────────────────────────────
  // Error with reconnect link
  // ──────────────────────────────────────────────
  function showReconnectOrError(err) {
    statusEl.innerHTML = '';
    const link = document.createElement('span');
    link.textContent = 'Se connecter';
    link.style.cssText = 'cursor:pointer;text-decoration:underline;color:#6cb4ff;font-weight:600;';
    link.addEventListener('click', () => {
      statusEl.textContent = 'Connexion...';
      B.runtime.sendMessage({ type: 'overlay:pkceLogin' }, (response) => {
        if (response?.ok) {
          statusEl.textContent = '';
        } else {
          statusEl.textContent = 'Echec';
          setTimeout(() => showReconnectOrError(''), 3000);
        }
      });
    });
    statusEl.appendChild(link);
  }

  // Load saved visio credentials from storage (same format as popup.js)
  B.storage.local.get({ visioCredentials: {} }, (data) => {
    const creds = data.visioCredentials || {};
    const saved = creds[detectedPlatform];

    if (saved?.login && loginInput) {
      loginInput.value = saved.login;
      loginInput.style.opacity = '0.7';
    } else if (detectedMeetingId && loginInput) {
      loginInput.value = detectedMeetingId;
      loginInput.style.opacity = '0.7';
    }

    if (saved?.password && passwordInput) {
      passwordInput.value = saved.password;
      // Password already saved — no need to show fields
      needsPassword = false;
    }

    if (!needsPassword && passwordInput) {
      passwordInput.style.display = 'none';
    }
  });

  // ──────────────────────────────────────────────
  // Minimize / Expand
  // ──────────────────────────────────────────────
  function minimize() {
    isMinimized = true;
    pill.classList.add('hidden');
    mini.classList.add('visible');
    miniDot.className = isRecording ? 'recording' : '';
    if (minimizeTimeout) clearTimeout(minimizeTimeout);
  }

  function expand() {
    isMinimized = false;
    mini.classList.remove('visible');
    pill.classList.remove('hidden');
    pill.style.animation = 'mirai-expand 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
    // Auto-minimize again after 5s if recording
    scheduleAutoMinimize();
  }

  function scheduleAutoMinimize() {
    if (minimizeTimeout) clearTimeout(minimizeTimeout);
    if (isRecording) {
      minimizeTimeout = setTimeout(minimize, 4000);
    }
  }

  minimizeBtn.addEventListener('click', minimize);
  mini.addEventListener('click', expand);

  // Keep pill visible while hovering
  pill.addEventListener('mouseenter', () => {
    if (minimizeTimeout) clearTimeout(minimizeTimeout);
  });
  pill.addEventListener('mouseleave', () => {
    scheduleAutoMinimize();
  });

  // ──────────────────────────────────────────────
  // Timer
  // ──────────────────────────────────────────────
  function formatTime(ms) {
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const sec = s % 60;
    return (m < 10 ? '0' : '') + m + ':' + (sec < 10 ? '0' : '') + sec;
  }

  function startTimer() {
    if (timerInterval) return;
    timerInterval = setInterval(() => {
      if (startTs) {
        const t = formatTime(Date.now() - startTs);
        timerEl.textContent = t;
        miniTimer.textContent = t;
      }
    }, 1000);
  }

  function stopTimer() {
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = null;
    timerEl.textContent = 'REC';
    miniTimer.textContent = '';
  }

  // ──────────────────────────────────────────────
  // Check ongoing recording (+ listen for changes)
  // ──────────────────────────────────────────────
  let isOtherTab = false;

  function checkRecordingState() {
    B.storage.local.get({ recordings: [] }, (data) => {
      const recs = data.recordings || [];
      const currentUrl = window.location.href;
      const urlPath = currentUrl.replace(/https?:\/\//, '').split('?')[0];

      // Match THIS page by: login/meeting ID in URL, or platform match, or URL overlap
      const currentLogin = loginInput?.value?.trim() || detectedMeetingId;
      const thisPageRec = recs.find(r => {
        if (r.status !== 'CAPTURE_IN_PROGRESS' && r.status !== 'CAPTURE_PENDING') return false;
        // Match by login/meeting ID in current URL
        if (r.login && currentUrl.includes(r.login)) return true;
        if (currentLogin && r.login === currentLogin) return true;
        // Match by URL overlap
        if (r.url && urlPath.includes(r.url.replace(/https?:\/\//, '').split('?')[0])) return true;
        return false;
      });

      // Any other active rec (not matching this page)
      const otherRec = !thisPageRec ? recs.find(r => r.status === 'CAPTURE_IN_PROGRESS' || r.status === 'CAPTURE_PENDING') : null;

      if (thisPageRec) {
        if (!isRecording || isOtherTab) {
          isRecording = true;
          isOtherTab = false;
          startTs = thisPageRec.ts ? new Date(thisPageRec.ts).getTime() : Date.now();
          recBtn.classList.add('recording'); pill.classList.add('rec-active');
          miniDot.className = 'recording'; miniTimer.className = 'recording';
          startTimer();
          statusEl.textContent = '';
          statusEl.style.color = '';
          scheduleAutoMinimize();
        }
      } else if (otherRec) {
        // Other tab recording — stay fully neutral here
        isRecording = false;
        isOtherTab = true;
        recBtn.classList.remove('recording'); pill.classList.remove('rec-active');
        miniDot.className = ''; miniTimer.className = '';
        stopTimer();
        statusEl.textContent = '';
        statusEl.style.color = '';
      } else {
        if (isRecording || isOtherTab) {
          isRecording = false;
          isOtherTab = false;
          recBtn.classList.remove('recording'); pill.classList.remove('rec-active');
          miniDot.className = ''; miniTimer.className = '';
          stopTimer();
          statusEl.textContent = '';
          statusEl.style.color = '';
        }
      }
    });
  }

  // Check if recording is active: ask background to check API directly
  B.runtime.sendMessage({
    type: 'overlay:checkActive',
    platform: detectedPlatform,
    login: loginInput?.value?.trim() || detectedMeetingId,
    url: window.location.href
  }, (response) => {
    if (response?.active) {
      isRecording = true;
      startTs = response.ts ? new Date(response.ts).getTime() : Date.now();
      recBtn.classList.add('recording'); pill.classList.add('rec-active');
      miniDot.className = 'recording';
      startTimer();
      statusEl.textContent = '';
      scheduleAutoMinimize();
      console.info('[MirAI Overlay] Active recording found:', response.meetingId);
    } else {
      checkRecordingState();
    }
  });

  // Listen for storage changes (recording started from popup or overlay)
  B.storage.onChanged.addListener((changes) => {
    if (changes.recordings) checkRecordingState();
  });

  // ──────────────────────────────────────────────
  // Record button
  // ──────────────────────────────────────────────
  recBtn.addEventListener('click', async () => {
    if (isRecording) {
      statusEl.textContent = 'Arret...';
      B.runtime.sendMessage({
        type: 'overlay:stopRecording',
        url: window.location.href
      }, (response) => {
        if (response?.ok) {
          isRecording = false;
          recBtn.classList.remove('recording'); pill.classList.remove('rec-active');
          stopTimer();
          miniDot.className = '';
          statusEl.textContent = 'Termine';
          // Expand to show "Termine" then fade
          if (isMinimized) expand();
          setTimeout(() => { statusEl.textContent = ''; }, 3000);
        } else {
          showReconnectOrError(response?.error || 'Erreur');
        }
      });
      return;
    }

    const login = loginInput?.value?.trim() || '';
    const password = passwordInput?.value?.trim() || '';

    if (!login) {
      fieldsEl.classList.add('visible');
      loginInput.focus();
      statusEl.textContent = 'Identifiant requis';
      return;
    }
    if (needsPassword && !password) {
      fieldsEl.classList.add('visible');
      passwordInput.focus();
      statusEl.textContent = 'Mot de passe requis';
      return;
    }

    statusEl.textContent = 'Demarrage...';
    recBtn.disabled = true;

    B.runtime.sendMessage({
      type: 'overlay:startRecording',
      data: {
        url: window.location.href,
        platform: detectedPlatform,
        login: login,
        password: password
      }
    }, (response) => {
      recBtn.disabled = false;
      if (response?.ok) {
        isRecording = true;
        startTs = Date.now();
        recBtn.classList.add('recording'); pill.classList.add('rec-active');
        fieldsEl.classList.remove('visible');
        startTimer();
        statusEl.textContent = '';
        miniDot.className = 'recording';
        // Auto-minimize after 4s
        scheduleAutoMinimize();
      } else {
        const err = response?.error || 'Erreur';
        showReconnectOrError(err);
      }
    });
  });

  // Enter in fields
  [loginInput, passwordInput].forEach(input => {
    if (input) input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') recBtn.click();
    });
  });

  // Close button = minimize (same as −)
  closeBtn.addEventListener('click', minimize);

  // Listen for show/hide messages from popup or background
  B.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === 'overlay:show') {
      overlay.style.display = '';
      // Force expand regardless of isMinimized state
      isMinimized = true;
      expand();
      sendResponse({ ok: true });
    }
    if (msg?.type === 'overlay:hide') {
      overlay.style.display = 'none';
      sendResponse({ ok: true });
    }
  });

  // ──────────────────────────────────────────────
  // Drag & drop with position memory
  // ──────────────────────────────────────────────
  let isDragging = false;
  let dragStartX = 0, dragStartY = 0;
  let overlayStartX = 0, overlayStartY = 0;
  let hasMoved = false;

  overlay.addEventListener('mousedown', (e) => {
    // Don't drag when clicking buttons or inputs
    if (e.target.closest('button, input')) return;
    isDragging = true;
    hasMoved = false;
    dragStartX = e.clientX;
    dragStartY = e.clientY;
    const rect = overlay.getBoundingClientRect();
    overlayStartX = rect.left;
    overlayStartY = rect.top;
    overlay.classList.add('dragging');
    e.preventDefault();
  });

  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    const dx = e.clientX - dragStartX;
    const dy = e.clientY - dragStartY;
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) hasMoved = true;
    if (!hasMoved) return;

    let newX = overlayStartX + dx;
    let newY = overlayStartY + dy;

    // Clamp to viewport
    const w = overlay.offsetWidth;
    const h = overlay.offsetHeight;
    newX = Math.max(0, Math.min(window.innerWidth - w, newX));
    newY = Math.max(0, Math.min(window.innerHeight - h, newY));

    // Switch from bottom/right to top/left positioning
    overlay.style.bottom = 'auto';
    overlay.style.right = 'auto';
    overlay.style.left = newX + 'px';
    overlay.style.top = newY + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!isDragging) return;
    isDragging = false;
    overlay.classList.remove('dragging');
    if (hasMoved) {
      // Save position
      const pos = { left: overlay.style.left, top: overlay.style.top };
      B.storage.local.set({ miraiOverlayPos: pos });
    }
  });

  // Restore saved position
  B.storage.local.get({ miraiOverlayPos: null }, (data) => {
    if (data.miraiOverlayPos) {
      overlay.style.bottom = 'auto';
      overlay.style.right = 'auto';
      overlay.style.left = data.miraiOverlayPos.left;
      overlay.style.top = data.miraiOverlayPos.top;
    }
  });

  // Show platform briefly
  statusEl.textContent = detectedPlatform.charAt(0).toUpperCase() + detectedPlatform.slice(1);
  setTimeout(() => { if (!isRecording) statusEl.textContent = ''; }, 3000);

  // ──────────────────────────────────────────────
  // Onboarding wizard — montre quoi faire + invite a se connecter (pas de token)
  // ──────────────────────────────────────────────
  const pillEl = document.getElementById('mirai-pill');
  const miniEl = document.getElementById('mirai-mini');
  const wizardEl = document.getElementById('mirai-wizard');
  const wizardLoginBtn = document.getElementById('mirai-wizard-login');
  const wizardCancelBtn = document.getElementById('mirai-wizard-cancel');
  const wizardStatus = document.getElementById('mirai-wizard-status');

  function showWizard() {
    pillEl.classList.add('hidden');
    miniEl.style.display = 'none';
    wizardEl.classList.add('show');
  }
  function hideWizard() {
    wizardEl.classList.remove('show');
    pillEl.classList.remove('hidden');
  }

  wizardLoginBtn.addEventListener('click', () => {
    wizardStatus.textContent = 'Connexion...';
    wizardLoginBtn.disabled = true;
    B.runtime.sendMessage({ type: 'overlay:pkceLogin' }, (response) => {
      wizardLoginBtn.disabled = false;
      if (response?.ok) {
        wizardStatus.textContent = '';
        hideWizard();
        statusEl.textContent = 'Connecte';
        setTimeout(() => { if (!isRecording) statusEl.textContent = ''; }, 3000);
      } else {
        wizardStatus.textContent = 'Echec de connexion, reessayez.';
      }
    });
  });

  // Annuler : referme le wizard et reduit l'overlay (non intrusif).
  wizardCancelBtn.addEventListener('click', () => {
    hideWizard();
    minimize();
  });

  // Au demarrage : si pas de token valide, afficher le wizard d'onboarding.
  B.runtime.sendMessage({ type: 'overlay:checkAuth' }, (resp) => {
    if (resp && resp.authed === false) showWizard();
  });

  console.info(`[MirAI Overlay] Loaded on ${detectedPlatform}, meeting: ${detectedMeetingId || 'unknown'}`);
})();
