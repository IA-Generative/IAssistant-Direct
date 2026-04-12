const recBtn = document.getElementById('rec-btn');
const statusLine = document.getElementById('status-line');
const timerEl = document.getElementById('timer');
const favBtn = document.getElementById('fav');
const historyList = document.getElementById('history-list');
const tabsList = document.getElementById('tabs-list');
const refreshTabsBtn = document.getElementById('refresh-tabs');
const reloginBtnTop = document.getElementById('relogin-btn');
const loaderImg = document.getElementById('loader');
const currentRecordingEl = document.getElementById('current-recording');
// Champs manuels ajoutés dans le popup
const platformSelect = document.getElementById('platform-select');
const manualLogin = document.getElementById('manual-login');
const manualPassword = document.getElementById('manual-password');

// 🔹 Ajout d'un bouton "Afficher" à droite du label "Mot de passe"
const passwordLabel = document.querySelector('label[for="manual-password"]');
if (manualPassword && passwordLabel) {
  const showPassBtn = document.createElement('span');
  showPassBtn.textContent = 'Afficher';
  showPassBtn.style.cursor = 'pointer';
  showPassBtn.style.fontSize = '11px';
  showPassBtn.style.marginLeft = '8px';
  showPassBtn.style.color = '#0078d4';
  showPassBtn.style.textDecoration = 'underline';
  showPassBtn.title = 'Afficher ou masquer le mot de passe';

  // Insérer le bouton à droite du label, au-dessus du champ
  passwordLabel.insertAdjacentElement('beforeend', showPassBtn);

  showPassBtn.addEventListener('click', () => {
    if (manualPassword.type === 'password') {
      manualPassword.type = 'text';
      showPassBtn.textContent = 'Masquer';
    } else {
      manualPassword.type = 'password';
      showPassBtn.textContent = 'Afficher';
    }
  });
}

const allowedKeywords = ['webconf', 'visio', 'comu', 'webinaire', 'webex', 'gmeet', 'teams'];

let credsCache = null;
let credsValid = false;

// UUID global de l'utilisateur Keycloak
let miraiUserUUID = null;

let timerInterval = null, startTs = null, isRecording = false, activeTabUrl = '';
// 🔹 Objet global pour stocker la session MirAI en cours
let currentMiraiRecord = null;

function showLoader(show){ 
  loaderImg.style.display = show ? 'inline-block' : 'none'; 

}


async function updateCurrentUrl() {
  try {
    // (Re)lookup DOM elements at runtime to avoid null references when popup loads
    const _platformSelect = document.getElementById('platform-select');
    const _recBtn = document.getElementById('rec-btn');
    const _currentUrlEl = document.getElementById('current-url');
    const _favBtn = document.getElementById('fav');

    const _currentRecordingEl = document.getElementById('current-recording');
    const _statusLine = document.getElementById('status-line');

    const _manualLoginEl = document.getElementById('manual-login');
    const _manualPasswordEl = document.getElementById('manual-password');

    const tabs = await CompatAPI.queryTabs({ active: true, currentWindow: true });
    const t = tabs[0];

    if (!(t && t.url)) return;

    activeTabUrl = t.url;
    const lowerUrl = t.url.toLowerCase();

    if (_currentUrlEl) _currentUrlEl.textContent = t.url;

    // Is current tab allowed for auto-recording?
    const isAllowed = allowedKeywords.some(k => lowerUrl.includes(k));

    // Determine ongoing recording for THIS tab only
    let isOngoingRec = null;
    try {
      const data = await CompatAPI.storageGet({ recordings: [] });
      const recs = data.recordings || [];
      const currentPath = lowerUrl.replace(/https?:\/\//, '').split('?')[0];

      isOngoingRec = recs.find(r => {
        if (r.status !== 'CAPTURE_IN_PROGRESS' && r.status !== 'CAPTURE_PENDING') return false;
        if (r.login && lowerUrl.includes(r.login)) return true;
        if (r.url && currentPath.includes(r.url.replace(/https?:\/\//, '').split('?')[0])) return true;
        return false;
      }) || null;
    } catch (e) {
      console.warn("[MirAI] Impossible de déterminer l'état d'enregistrement depuis storage:", e);
    }

    // ------------------------------------------------------------------
    // 1) If a recording is ongoing: force recording UI state and resume
    // ------------------------------------------------------------------
    if (isOngoingRec) {
      // Visual state
      if (typeof recBtn !== 'undefined' && recBtn) {
        recBtn.classList.add('recording');
        recBtn.style.backgroundColor = 'red';
        recBtn.setAttribute('aria-pressed', 'true');
        recBtn.disabled = false; // user must be able to stop
        recBtn.style.opacity = '1';
      }
      if (_statusLine) _statusLine.textContent = '🎥  Enregistrement en cours...';

      isRecording = true;

      // Resume timer from persisted start timestamp if available
      const resumedTs = isOngoingRec.ts ? Date.parse(isOngoingRec.ts) : NaN;
      startTimer(Number.isFinite(resumedTs) ? resumedTs : null);

      if (_currentRecordingEl) {
        _currentRecordingEl.textContent = `🎥 Enregistrement en cours : ${activeTabUrl}`;
        _currentRecordingEl.style.color = '#d32f2f';
      }

      // Populate login/password fields for display
      if (_manualLoginEl) {
        _manualLoginEl.value = isOngoingRec.login || '';
        _manualLoginEl.style.backgroundColor = '#e6f7ff';
        _manualLoginEl.style.fontStyle = 'italic';
        _manualLoginEl.title = 'Identifiant de visio (enregistrement en cours)';
      }

      const ongoingPlatform = (isOngoingRec.platform || isOngoingRec.name_platform || _platformSelect?.value || '')
        .toString()
        .toLowerCase();

      if (_platformSelect && ongoingPlatform) {
        _platformSelect.value = ongoingPlatform;
        _platformSelect.disabled = true;
        _platformSelect.style.backgroundColor = '#d3d3d3';
        _platformSelect.style.fontStyle = 'italic';
        _platformSelect.title = 'Plateforme verrouillée (enregistrement en cours)';
      }

      if (_manualPasswordEl) {
        if (['webconf', 'webinaire', 'gmeet'].includes(ongoingPlatform)) {
          _manualPasswordEl.type = 'password';
          _manualPasswordEl.disabled = true;
          _manualPasswordEl.value = '';
          _manualPasswordEl.placeholder = 'Mot de passe non requis';
          _manualPasswordEl.style.backgroundColor = '#c7c7c7ff';
          _manualPasswordEl.style.fontStyle = 'italic';
          _manualPasswordEl.style.color = '#555';
        } else {
          _manualPasswordEl.type = 'password';
          _manualPasswordEl.disabled = false;
          _manualPasswordEl.value = '';
          _manualPasswordEl.placeholder = isOngoingRec.password || 'Mot de passe';
          _manualPasswordEl.style.backgroundColor = '';
          _manualPasswordEl.style.fontStyle = 'normal';
          _manualPasswordEl.style.color = '';
        }
      }

      // Even if ongoing, keep bookmark indicator updated
      const bmData = await CompatAPI.storageGet({ bookmarks: [] });
      const isBm = (bmData.bookmarks || []).includes(t.url);
      if (_favBtn) {
        _favBtn.textContent = isBm ? '★' : '☆';
        _favBtn.title = isBm ? 'Retirer le bookmark' : 'Ajouter aux bookmarks';
      }

      return; // stop here: no auto-detection override while recording
    }

    // ------------------------------------------------------------------
    // 2) No recording ongoing: normal auto-detection and UI rules
    // ------------------------------------------------------------------

    // Auto-detect platform from URL
    let detectedPlatform = '';
    if (lowerUrl.includes('visio.numerique')) {
      detectedPlatform = 'visio';
    } else if (lowerUrl.includes('webconf.numerique')) {
      detectedPlatform = 'webconf';
    } else if (lowerUrl.includes('webconf') && (lowerUrl.includes('comu') || lowerUrl.includes('minint'))) {
      detectedPlatform = 'comu';
    } else if (lowerUrl.includes('webconf')) {
      detectedPlatform = 'webconf';
    } else if (lowerUrl.includes('comu')) {
      detectedPlatform = 'comu';
    } else if (lowerUrl.includes('webinaire')) {
      detectedPlatform = 'webinaire';
    } else if (lowerUrl.includes('webex')) {
      detectedPlatform = 'webex';
    } else if (lowerUrl.includes('gmeet') || lowerUrl.includes('meet.google')) {
      detectedPlatform = 'gmeet';
    } else if (lowerUrl.includes('teams')) {
      detectedPlatform = 'teams';
    }

    // Configure platform select + auto-fill meeting id
    if (_platformSelect) {
      if (detectedPlatform) {
        _platformSelect.value = detectedPlatform;
        console.info(`[MirAI] Plateforme détectée automatiquement : ${detectedPlatform}`);

        // Try to extract meeting id from URL
        if (_manualLoginEl) {
          let meetingId = '';
          try {
            const urlObj = new URL(t.url);
            const host = urlObj.hostname.toLowerCase();

            // Specific: webconf.numerique or visio.numerique -> first path segment
            if (host.includes('webconf.numerique') || host.includes('visio.numerique')) {
              const parts = (urlObj.pathname || '/').split('/').filter(Boolean);
              if (parts.length > 0) meetingId = (parts[0] || '').split(/[?#]/)[0];
            }
          } catch (e) {
            console.warn("[MirAI] URL invalide lors de l'extraction Webconf:", e);
          }

          if (!meetingId) {
            const patterns = [
              /\/meet\/([\w-]+)/i,                    // Google Meet
              /\/([A-Za-z0-9]{9,})@webex\.com/i,     // Webex
              /\/webinar\/(\d+)/i,                   // Webinaire
              /\/webinaire-etat\/(\d+)/i,            // Webinaire de l'État
              /\/(\d{9,})/i,                         // Generic numeric id
              /meeting\/([\w-]+)/i,                  // Teams / Webconf / Comu
              /\/r\/([\w-]+)/i                       // Short link
            ];

            for (const regex of patterns) {
              const match = lowerUrl.match(regex);
              if (match && match[1]) {
                meetingId = match[1];
                break;
              }
            }
          }

          if (meetingId) {
            _manualLoginEl.value = meetingId;
            _manualLoginEl.style.backgroundColor = '#e6f7ff';
            _manualLoginEl.style.fontStyle = 'italic';
            _manualLoginEl.title = 'Identifiant de visio détecté automatiquement';
            console.info(`[MirAI] Identifiant de visio détecté : ${meetingId}`);
          } else {
            _manualLoginEl.style.backgroundColor = '';
            _manualLoginEl.style.fontStyle = 'normal';
            _manualLoginEl.title = '';
          }
        }

        // Lock select when auto-detected
        _platformSelect.disabled = true;
        _platformSelect.style.backgroundColor = '#d3d3d3';
        _platformSelect.style.fontStyle = 'italic';
        _platformSelect.title = 'Plateforme détectée automatiquement';

        // Password field display rules
        if (_manualPasswordEl) {
          if (['webconf', 'webinaire', 'gmeet'].includes(detectedPlatform)) {
            _manualPasswordEl.type = 'password';
            _manualPasswordEl.disabled = true;
            _manualPasswordEl.placeholder = 'Mot de passe non requis';
            _manualPasswordEl.style.backgroundColor = '#c7c7c7ff';
            _manualPasswordEl.style.fontStyle = 'italic';
            _manualPasswordEl.style.color = '#555';
          } else {
            _manualPasswordEl.type = 'password';
            _manualPasswordEl.disabled = false;
            _manualPasswordEl.placeholder = 'Mot de passe';
            _manualPasswordEl.style.backgroundColor = '';
            _manualPasswordEl.style.fontStyle = 'normal';
            _manualPasswordEl.style.color = '';
          }
        }
      } else {
        // Re-enable when no platform detected
        _platformSelect.disabled = false;
        _platformSelect.style.backgroundColor = '';
        _platformSelect.style.fontStyle = 'normal';
        _platformSelect.title = '';
      }
    } else {
      console.warn('[MirAI] #platform-select introuvable lors de updateCurrentUrl()');
    }

    // REC button state based on URL (only if not recording)
    if (_recBtn) {
      _recBtn.disabled = !isAllowed;
      _recBtn.title = isAllowed
        ? "Demarrer l'enregistrement pour cette visio."
        : 'Enregistrement automatique indisponible pour cet onglet.';
      _recBtn.style.opacity = isAllowed ? '1' : '0.5';
      _recBtn.style.backgroundColor = isAllowed ? '#00bfff' : '';
    } else {
      console.warn('[MirAI] Bouton REC (#rec-btn) introuvable lors de updateCurrentUrl()');
    }

    // Bookmark indicator
    const data = await CompatAPI.storageGet({ bookmarks: [] });
    const isBm = (data.bookmarks || []).includes(t.url);
    if (_favBtn) {
      _favBtn.textContent = isBm ? '★' : '☆';
      _favBtn.title = isBm ? 'Retirer le bookmark' : 'Ajouter aux bookmarks';
    }

  } catch (e) {
    const el = document.getElementById('current-url');
    if (el) el.textContent = 'Erreur: ' + e.message;
  }
}
function formatTime(ms){ const s=Math.floor(ms/1000); return `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`; }

function startTimer(resumeFromTs = null) {
  // Avoid multiple intervals when reopening the popup
  if (timerInterval !== null) return;

  if (typeof resumeFromTs === 'number' && resumeFromTs > 0) {
    startTs = resumeFromTs;
  } else if (startTs === null || startTs <= 0) {
    startTs = Date.now();
  }

  timerInterval = setInterval(() => {
    timerEl.textContent = formatTime(Date.now() - startTs);
  }, 250);
}

function stopTimer() {
  if (timerInterval !== null) {
    clearInterval(timerInterval);
  }
  timerInterval = null;
  startTs = null;
  timerEl.textContent = '00:00';
}

function isTimerRunning() {
  return timerInterval !== null;
}

async function startRecording() {
  try {
    // Authentification PKCE + enrollment DM
    const token = await window.MiraiAuth.ensureAuthenticated();
    if (!token) {
      alert('Votre session MirAI a expiré.\nVeuillez vous reconnecter.');
      return;
    }

    // Vérifie le token auprès de Keycloak
    const tokenValid = await window.MiraiAuth.verifyToken(token);
    if (!tokenValid) {
      console.warn('[MirAI] Token invalide, relance du login...');
      const newToken = await window.MiraiAuth.login({ force: true });
      if (!newToken) {
        alert('Votre session MirAI a expiré ou est invalide.\nVeuillez vous reconnecter.');
        return;
      }
    }
    // Vérification de la session SSO avant de démarrer
    if (!credsValid) {
      const confirmLogin = confirm("Connexion SSO requise.\nSouhaitez-vous vous connecter maintenant ?");
      if (confirmLogin) {
        const loginToken = await window.MiraiAuth.login();
        if (loginToken) {
          credsValid = true;
          const footerMsg = document.getElementById('footer-message');
          if (footerMsg) footerMsg.textContent = 'Session SSO active.';
        } else {
          return;
        }
      } else {
        return;
      }
    }

    // Vérifie si l'URL de l'onglet courant correspond à une plateforme autorisée
    const lowerUrl = activeTabUrl.toLowerCase();
    const isAllowed = allowedKeywords.some(k => lowerUrl.includes(k));
    if (!isAllowed) {
      alert("L'enregistrement automatique n'est pas disponible pour cet onglet.\nVeuillez préciser manuellement les informations d'enregistrement.");
    }

    // 🔹 Récupération des informations manuelles saisies si enregistrement non automatique
    const selectedPlatform = platformSelect?.value || '';
    const enteredLogin = manualLogin?.value?.trim() || '';
    const enteredPassword = manualPassword?.value?.trim() || '';

    // 🔹 Vérifie si le mot de passe est requis pour la plateforme sélectionnée
    const requiresPassword = !['webconf', 'visio', 'webinaire', 'gmeet'].includes(selectedPlatform);
    if (requiresPassword && !enteredPassword) {
      alert(`Veuillez spécifier un mot de passe pour la plateforme ${selectedPlatform.toUpperCase()} avant de démarrer l'enregistrement.`);
      manualPassword.focus();
      return;
    }

    if (!isAllowed) {
      alert("L'enregistrement automatique n'est pas disponible pour cet onglet.\nVeuillez préciser manuellement les informations d'enregistrement.");
    }

    // UUID utilisateur (extrait par auth.js lors du login)
    if (!miraiUserUUID && window.miraiUserUUID) {
      miraiUserUUID = window.miraiUserUUID;
    }

    // 🔹 Démarre réellement l'enregistrement via l'API
    if (typeof startMiraiRecording === 'function') {
      try {
        showLoader(true);
        statusLine.textContent = "Demarrage de l'enregistrement...";

        currentMiraiRecord = await startMiraiRecording({
          url: activeTabUrl,
          platform: selectedPlatform,
          login: enteredLogin,
          password: enteredPassword,
          userUUID: miraiUserUUID
        });

        if (currentMiraiRecord && currentMiraiRecord.id) {
          console.info('[MirAI] Enregistrement démarré avec succès :', currentMiraiRecord);

          // 🔹 Met à jour l'affichage uniquement si le démarrage a réussi
          recBtn.classList.add('recording');
          recBtn.style.backgroundColor = 'red';
          statusLine.textContent = 'Enregistrement en cours...';
          recBtn.setAttribute('aria-pressed', 'true');
          isRecording = true;
          startTimer();
          currentRecordingEl.textContent = `🎥 Enregistrement (démarrage sous 30 s max) : ${activeTabUrl}`;
          currentRecordingEl.style.color = '#d32f2f';



        } else {
          console.warn("[MirAI] L'API n'a pas confirme le demarrage.");
          alert("Le demarrage de l'enregistrement a echoue.\nVerifiez votre connexion ou vos droits d'acces.");
          showLoader(false);
          return;
        }
      } catch (err) {
        console.error('[MirAI] Erreur retour startMiraiRecording :', err);
        alert("Impossible de demarrer l'enregistrement (erreur technique).");
        showLoader(false);
        return;
      }
    }

    const record = {
      url: activeTabUrl,
      platform: currentMiraiRecord?.name_platform || selectedPlatform,
      login: enteredLogin,
      password: enteredPassword,
      userUUID: miraiUserUUID,
      startDate: currentMiraiRecord?.start_date,
      meeting_id: currentMiraiRecord?.id || null,
      status: currentMiraiRecord?.status || 'NONE',
      ts: new Date().toISOString(),
      durationMs: 0
    };
    const data = await CompatAPI.storageGet({ recordings: [] });
    const recs = data.recordings || [];
    recs.unshift(record);
    await CompatAPI.storageSet({ recordings: recs });
    await loadHistory();

    showLoader(false);
  } catch (e) {
    console.error('[MirAI] Erreur startRecording:', e);
    statusLine.textContent = 'Erreur au démarrage.';
    showLoader(false);
  }
}

async function stopRecording() {
  try {
    const confirmStop = confirm("Arreter l'enregistrement ?");
    if (!confirmStop) return;

    // 🔹 État visuel
    recBtn.classList.remove('recording');
    recBtn.style.backgroundColor = '';
    // 🔹 Rétablit l'état du bouton REC selon l'URL active
    const lowerUrl = activeTabUrl.toLowerCase();
    const isAllowed = allowedKeywords.some(k => lowerUrl.includes(k));
    recBtn.disabled = !isAllowed;
    recBtn.title = isAllowed
      ? "Demarrer l'enregistrement pour cette visio."
      : 'Enregistrement automatique indisponible pour cet onglet.';
    recBtn.style.opacity = isAllowed ? '1' : '0.5';
    recBtn.style.backgroundColor = isAllowed ? '#00bfff' : ''; // Bleu ciel si autorisé
    recBtn.setAttribute('aria-pressed', 'false');
    isRecording = false;
    statusLine.textContent = 'Enregistrement arrêté.';

    // 🔹 Calcul de la durée réelle
    const durationMs = Date.now() - startTs;
    stopTimer();
    showLoader(true);

    // 🔹 Mise à jour de la durée dans l'historique
    const data = await CompatAPI.storageGet({ recordings: [] });
    const recs = data.recordings || [];

    if (recs.length > 0) {
      // Recherche par URL (sinon prend la plus récente)
      const idx = recs.findIndex(r => r.url === activeTabUrl);
      const targetIndex = idx !== -1 ? idx : 0;
      recs[targetIndex].durationMs = durationMs;
      recs[targetIndex].status = 'CAPTURE_DONE';
      await CompatAPI.storageSet({ recordings: recs });
    }

    // 🔹 Rafraîchissement de la liste d'historique
    await loadHistory();

    // 🔹 Nettoyage visuel
    document.querySelectorAll('.rec-blink').forEach(el => el.classList.remove('rec-blink'));
    document.querySelectorAll('.rec-active').forEach(el => el.classList.remove('rec-active'));
    currentRecordingEl.textContent = '';

    // 🔹 Appel de la fonction d'arrêt métier si dispo
    if (typeof stopMiraiRecording === 'function') {
      try {
        const data = await CompatAPI.storageGet({ recordings: [] });
        const recs = data.recordings || [];

        // 🔹 On privilégie toujours l'historique le plus récent comme source de vérité
        const latestRecord = recs.length > 0 ? recs[0] : null;

        if (latestRecord) {
          console.info("[MirAI] Utilisation de l'historique le plus récent pour stopMiraiRecording:", latestRecord);
          await stopMiraiRecording(latestRecord);
        } else if (currentMiraiRecord) {
          console.warn('[MirAI] Historique vide, fallback sur currentMiraiRecord:', currentMiraiRecord);
          await stopMiraiRecording(currentMiraiRecord);
        } else {
          console.warn('[MirAI] Aucun record disponible, appel de secours avec URL seule.');
          await stopMiraiRecording({ url: activeTabUrl });
        }
      } catch (err) {
        console.error('[MirAI] Erreur stopMiraiRecording:', err);
      }
    }

    showLoader(false);
  } catch (e) {
    console.error('[MirAI] Erreur stopRecording:', e);
    statusLine.textContent = "Erreur a l'arret.";
    showLoader(false);
  }
}

recBtn.addEventListener('click', async () => {
  if (isRecording) {
    await stopRecording();
  } else {
    await startRecording();
  }
});



favBtn.addEventListener('click', async ()=>{
  const data = await CompatAPI.storageGet({ bookmarks: [] }); const list = data.bookmarks || []; const idx = list.indexOf(activeTabUrl);
  if(idx===-1){ list.unshift(activeTabUrl); await CompatAPI.storageSet({ bookmarks: list }); favBtn.textContent='★'; favBtn.title='Retirer le bookmark'; }
  else { list.splice(idx,1); await CompatAPI.storageSet({ bookmarks: list }); favBtn.textContent='☆'; favBtn.title='Ajouter aux bookmarks'; }
  loadHistory();
});
// relogin handler is set in footer init below

async function loadHistory() {
  const data = await CompatAPI.storageGet({ recordings: [] });
  const recs = data.recordings || [];
  historyList.innerHTML = '';

  const style = document.createElement('style');
  style.textContent = `
    @keyframes pulseRec {
      0% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(1.05); }
      100% { opacity: 1; transform: scale(1); }
    }
    .rec-blink { animation: pulseRec 6s infinite; }
    .rec-active { border: 2px solid #0078d4; background-color: #e3f2ff; }
  `;
  document.head.appendChild(style);

  for (const r of recs) {
    const li = document.createElement('li');
    li.dataset.url = r.url;
    li.style.transition = 'all 0.3s ease';
    li.style.padding = '4px 0 4px 4px';
    li.style.marginBottom = '6px';
    li.style.borderRadius = '6px';

    const left = document.createElement('div');
    left.innerHTML = `
      <div style="font-size:12px;">${r.url}</div>
      <div class="meta" style="font-size:10px;color:#666;">
        ${new Date(r.ts).toLocaleString()} • ${(r.durationMs && r.durationMs > 0) ? Math.round(r.durationMs / 1000) + 's' : 'en cours'}
      </div>`;

    const right = document.createElement('div');
    right.style.display = 'flex';
    right.style.alignItems = 'center';
    right.style.gap = '8px';

    // Afficher les actions uniquement si aucun enregistrement en cours
    if (!isRecording) {
      const link = document.createElement('div');
      link.textContent = 'Ouvrir';
      link.style.cursor = 'pointer';
      link.style.textDecoration = 'underline';
      link.style.color = '#0072cf';
      link.style.fontSize = '11px';
      link.addEventListener('click', async () => {
        await CompatAPI.createTab({ url: r.url });
      });

      const recIcon = document.createElement('div');
      recIcon.textContent = 'Rec';
      recIcon.style.cursor = 'pointer';
      recIcon.style.color = 'red';
      recIcon.style.fontSize = '11px';
      recIcon.style.textDecoration = 'underline';
      recIcon.title = 'Lancer un enregistrement en direct pour cette visio';
      recIcon.addEventListener('click', async () => {
        const confirmRec = confirm(`Lancer l'enregistrement en direct pour:\n${r.url} ?`);
        if (confirmRec) {
          activeTabUrl = r.url;
          recIcon.classList.add('rec-blink');
          li.classList.add('rec-active');
          await startRecording();
        }
      });

      right.appendChild(link);
      right.appendChild(recIcon);

      // 🔹 Bouton "CR" pour ouvrir la page du compte-rendu associé
      if (r.meeting_id) {
        const crBtn = document.createElement('div');
        crBtn.textContent = 'CR';
        crBtn.style.cursor = 'pointer';
        crBtn.style.backgroundColor = '#0078d4';
        crBtn.style.color = 'white';
        crBtn.style.padding = '1px 5px';
        crBtn.style.borderRadius = '4px';
        crBtn.style.fontSize = '10px';
        crBtn.title = 'Ouvrir le compte-rendu de cette réunion';

        crBtn.addEventListener('click', async () => {
          const _crBase = window.DMBootstrap?.getConfig()?.compteRenduUrl || 'https://compte-rendu.mirai.interieur.gouv.fr/';
          const meetingUrl = `${_crBase.replace(/\/$/, '')}/meetings/${r.meeting_id}`;
          console.info(`[MirAI] Ouverture du compte-rendu : ${meetingUrl}`);
          await CompatAPI.createTab({ url: meetingUrl });
        });

        right.appendChild(crBtn);
      }
    }

    li.appendChild(left);
    li.appendChild(right);
    historyList.appendChild(li);
  }

  if (recs.length === 0) {
    const li = document.createElement('li');
    li.textContent = 'Aucun enregistrement récent.';
    li.style.color = '#888';
    li.style.fontStyle = 'italic';
    li.style.fontSize = '11px';
    historyList.appendChild(li);
  }
}

async function loadTabs() {
  try {
    const tabs = await CompatAPI.queryTabs({});
    tabsList.innerHTML = '';

    const matchingTabs = tabs.filter(t => {
      const url = t.url ? t.url.toLowerCase() : '';
      // Exclude SSO/auth pages and extension pages
      if (url.includes('/realms/') || url.includes('chromiumapp.org') || url.includes('chrome-extension://')) return false;
      return allowedKeywords.some(k => url.includes(k));
    });

    // Get recordings to check which tabs are recording
    const recData = await CompatAPI.storageGet({ recordings: [] });
    const activeRecs = (recData.recordings || []).filter(r => r.status === 'CAPTURE_IN_PROGRESS' || r.status === 'CAPTURE_PENDING');

    if (matchingTabs.length === 0 && activeRecs.length === 0) {
      const li = document.createElement('li');
      li.textContent = 'Aucune visio detectee dans les onglets ouverts.';
      li.style.color = '#888';
      li.style.fontStyle = 'italic';
      tabsList.appendChild(li);
      return;
    }

    // Track which active recs have a matching open tab
    const matchedRecUrls = new Set();

    for (const t of matchingTabs) {
      const li = document.createElement('li');
      const tabUrl = (t.url || '').replace(/https?:\/\//, '').split('?')[0];

      const matchingRec = activeRecs.find(r => {
        // Match by login/meeting ID in tab URL
        if (r.login && tabUrl.includes(r.login)) return true;
        // Match by URL overlap
        if (r.url && tabUrl.includes(r.url.replace(/https?:\/\//, '').split('?')[0])) return true;
        return false;
      });

      if (matchingRec) {
        matchedRecUrls.add(matchingRec.url);
        li.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e53935;margin-right:5px;animation:pulse-dot 1.5s infinite;vertical-align:middle;"></span><span>' + (t.title || t.url) + '</span>';
      } else {
        li.innerHTML = '<span style="color:#0072cf;margin-right:4px;">&#8599;</span><span>' + (t.title || t.url) + '</span>';
      }

      li.title = t.url;
      li.style.cursor = 'pointer';
      li.style.padding = '4px 0';

      li.addEventListener('click', async () => {
        try {
          await CompatAPI.updateTab(t.id, { active: true });
          await BROWSER.windows.update(t.windowId, { focused: true });
          window.close();
        } catch (e) {
          console.error("[MirAI] Impossible d'activer l'onglet :", e);
        }
      });

      li.addEventListener('mouseover', () => { li.style.backgroundColor = '#f6f6f6'; });
      li.addEventListener('mouseout', () => { li.style.backgroundColor = ''; });

      tabsList.appendChild(li);
    }

    // Show active recordings whose tab is no longer open
    for (const rec of activeRecs) {
      if (rec.url && !matchedRecUrls.has(rec.url)) {
        const li = document.createElement('li');
        const platform = (rec.platform || '').charAt(0).toUpperCase() + (rec.platform || '').slice(1);
        const label = platform + (rec.login ? ' #' + rec.login : '');
        li.innerHTML = '<span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:#e53935;margin-right:5px;animation:pulse-dot 1.5s infinite;vertical-align:middle;"></span><span style="color:#e53935;">' + label + ' (onglet ferme)</span>';
        li.title = rec.url;
        li.style.cursor = 'pointer';
        li.style.padding = '4px 0';

        li.addEventListener('click', () => {
          CompatAPI.createTab({ url: rec.url });
          window.close();
        });

        li.addEventListener('mouseover', () => { li.style.backgroundColor = '#fff0f0'; });
        li.addEventListener('mouseout', () => { li.style.backgroundColor = ''; });

        tabsList.appendChild(li);
      }
    }

  } catch (e) {
    console.error('[MirAI] Erreur chargement onglets :', e);
  }
}
refreshTabsBtn.addEventListener('click', loadTabs);
if (BROWSER?.tabs?.onCreated && BROWSER?.tabs?.onRemoved) {
  BROWSER.tabs.onCreated.addListener(() => loadTabs());
  BROWSER.tabs.onRemoved.addListener(() => loadTabs());
} else {
  console.warn('[MirAI Compat] Événements tabs.onCreated / onRemoved non supportés dans ce contexte.');
}
// Modifié pour afficher le statut selon l'URL de l'onglet actif si identifiants présents
(async ()=>{
  await updateCurrentUrl();
  await loadTabs();
  await loadHistory();
  const pref = await CompatAPI.storageGet({ encryptedCreds: null });
  if (pref.encryptedCreds) {
    const tabs = await CompatAPI.queryTabs({ active: true, currentWindow: true });
    const t = tabs[0];
    const lowerUrl = t?.url?.toLowerCase() || '';
    const isAllowed = allowedKeywords.some(k => lowerUrl.includes(k));
    if (isAllowed) {
      statusLine.textContent = "L'enregistrement se lancera automatiquement avec les informations ci-dessous.";
    } else {
      statusLine.textContent = 'Enregistrement automatique indisponible pour cet onglet. Veuillez spécifier les informations de connexion à la visio.';
    }
  }
})();

// Footer dynamique — check SSO token (PKCE)
(async () => {
  try {
    const footerMsg = document.getElementById('footer-message');

    function showConnected(token) {
      const payload = window.MiraiAuth._decodeJWT(token);
      const email = payload?.email || payload?.preferred_username || '';
      footerMsg.innerHTML = '<span style="color:#2ea043;font-size:9px;margin-right:3px;">&#9679;</span>' + (email || 'Connecte');
      footerMsg.style.color = '#666';
      footerMsg.style.cursor = 'default';
      footerMsg.style.textDecoration = 'none';
    }

    function showDisconnected() {
      footerMsg.innerHTML = '<span style="color:#999;font-size:9px;margin-right:3px;">&#9679;</span>Se connecter';
      footerMsg.style.cursor = 'pointer';
      footerMsg.style.color = '#0072cf';
      footerMsg.style.textDecoration = 'underline';
    }

    // Check token + refresh if needed, then update UI
    async function refreshFooterState() {
      const token = await window.MiraiAuth.getValidToken();
      if (token) {
        credsValid = true;
        showConnected(token);
      } else {
        credsValid = false;
        showDisconnected();
      }
    }

    await refreshFooterState();

    // Re-check every 60s while popup is open
    setInterval(refreshFooterState, 60000);

    // Click to login if disconnected
    footerMsg.addEventListener('click', async () => {
      if (credsValid) return;
      footerMsg.innerHTML = '<span style="color:#d29922;font-size:9px;margin-right:3px;">&#9679;</span>Connexion...';
      footerMsg.style.cursor = 'default';
      footerMsg.style.textDecoration = 'none';
      footerMsg.style.color = '#666';
      const loginToken = await window.MiraiAuth.login();
      if (loginToken) {
        credsValid = true;
        showConnected(loginToken);
      } else {
        showDisconnected();
      }
    });

    const showOverlayBtn = document.getElementById('show-overlay-btn');
    if (showOverlayBtn) {
      showOverlayBtn.addEventListener('click', async () => {
        const tabs = await CompatAPI.queryTabs({ active: true, currentWindow: true });
        if (tabs[0]?.id) {
          const B = (typeof browser !== 'undefined') ? browser : chrome;
          try {
            B.tabs.sendMessage(tabs[0].id, { type: 'overlay:show' }, (resp) => {
              if (!resp) {
                showOverlayBtn.textContent = 'Pas de visio';
                setTimeout(() => { showOverlayBtn.textContent = 'Overlay'; }, 2000);
              }
            });
          } catch (e) {
            showOverlayBtn.textContent = 'Pas de visio';
            setTimeout(() => { showOverlayBtn.textContent = 'Overlay'; }, 2000);
          }
        }
      });
    }

    const reloginBtn = document.getElementById('relogin-btn');
    if (reloginBtn) {
      reloginBtn.addEventListener('click', async () => {
        reloginBtn.textContent = '...';
        reloginBtn.style.color = '#999';
        const loginToken = await window.MiraiAuth.login({ force: true });
        if (loginToken) {
          credsValid = true;
          showConnected(loginToken);
          reloginBtn.textContent = 'Reconnecter';
          reloginBtn.style.color = '#0072cf';
        } else {
          showDisconnected();
          reloginBtn.textContent = 'Reconnecter';
          reloginBtn.style.color = '#0072cf';
        }
      });
    }
  } catch (e) {
    console.error('[MirAI] Erreur footer :', e);
  }
})();

const clearBtn = document.getElementById('clear-history');

if (clearBtn) {
  clearBtn.addEventListener('click', async () => {
    const confirmClear = confirm("Voulez-vous vraiment effacer tout l'historique des enregistrements ?");
    if (confirmClear) {
      await CompatAPI.storageSet({ recordings: [] });
      if (typeof loadHistory === 'function') await loadHistory();
    }
  });
}

// ======================================================================
// Auth — delegates to shared MiraiAuth module (src/auth.js)
// ======================================================================
async function checkKeycloakSession(force = false) {
  // Retrieve login hint from encrypted creds for pre-filling
  let loginHint = '';
  try {
    const { encryptedCreds } = await CompatAPI.storageGet({ encryptedCreds: null });
    if (encryptedCreds) {
      const creds = await CRYPTO.decrypt(encryptedCreds, 'mirai-local-secret');
      loginHint = creds.login?.trim() || '';
    }
  } catch (e) { /* ignore */ }

  const token = await window.MiraiAuth.login({ force, loginHint });
  if (token && window.miraiUserUUID) {
    miraiUserUUID = window.miraiUserUUID;
  }
  return token;
}



// ======================================================================
// 🚀 Lancement des raccourcis MirAI avec SSO automatique
// ======================================================================
async function openMiraiShortcut(target) {
  const _sc = window.DMBootstrap?.getConfig() || {};
  const urls = {
    compterendu: _sc.compteRenduUrl || 'https://compte-rendu.mirai.interieur.gouv.fr/',
    comu: _sc.comuUrl || 'https://webconf.comu.gouv.fr/',
    visio: _sc.visioUrl || 'https://visio.numerique.gouv.fr/'
  };

  if (!urls[target]) {
    console.warn(`[MirAI] Raccourci inconnu : ${target}`);
    return;
  }

  // Ensure SSO session exists (login if needed — via normal tab so cookie is shared)
  const token = await window.MiraiAuth.ensureAuthenticated();
  if (!token) {
    alert("Connexion SSO requise pour acceder a ce service.");
    return;
  }

  if (window.DMTelemetry) window.DMTelemetry.sendSpan('shortcut.click', { target: target });
  // Open directly — the Keycloak SSO cookie (from tab-based login) handles auth
  CompatAPI.createTab({ url: urls[target] });
}

// ======================================================================
// 🧭 Attachement des raccourcis dans le popup
// ======================================================================
document.addEventListener('DOMContentLoaded', () => {
  const report = document.getElementById('shortcut-report');
  const comu = document.getElementById('shortcut-comu');
  const visio = document.getElementById('shortcut-visio');

  if (report) report.addEventListener('click', () => openMiraiShortcut('compterendu'));
  if (comu) comu.addEventListener('click', () => openMiraiShortcut('comu'));
  if (visio) visio.addEventListener('click', () => openMiraiShortcut('visio'));
});

// 🔹 Mise à jour automatique de la détection de plateforme à l'ouverture du popup
document.addEventListener('DOMContentLoaded', async () => {
  try {
    await updateCurrentUrl();
  } catch (e) {
    console.error('[MirAI] Erreur lors de la mise à jour automatique de la plateforme :', e);
  }
  // 🔹 Rafraîchit les paramètres quand l'utilisateur change la plateforme manuellement
  const platformSelectEl = document.getElementById('platform-select');
  if (platformSelectEl) {
    platformSelectEl.addEventListener('change', async () => {
      try {
        const selected = platformSelectEl.value;
        console.info('[MirAI] Plateforme modifiée manuellement :', selected);

        // Masquage/affichage du champ mot de passe selon la sélection manuelle
        const manualPassword = document.getElementById('manual-password');
        if (manualPassword) {
          if (['webconf', 'webinaire', 'gmeet'].includes(selected)) {
            manualPassword.type = 'password';
            manualPassword.disabled = true;
            manualPassword.placeholder = 'Mot de passe non requis';
            manualPassword.style.backgroundColor = '#c7c7c7ff';
            manualPassword.style.fontStyle = 'italic';
            manualPassword.style.color = '#555';
          } else {
            manualPassword.type = 'password';
            manualPassword.disabled = false;
            manualPassword.placeholder = 'Mot de passe';
            manualPassword.style.backgroundColor = '';
            manualPassword.style.fontStyle = 'normal';
            manualPassword.style.color = '';
          }
        }

        await updateCurrentUrl();
      } catch (e) {
        console.error('[MirAI] Erreur lors du rafraîchissement après changement de plateforme :', e);
      }
    });
  }

  // 🔹 Persistance automatique des identifiants selon la plateforme
  const manualLoginEl = document.getElementById('manual-login');
  const manualPasswordEl = document.getElementById('manual-password');
  const platformSelectElPersist = document.getElementById('platform-select');

  async function saveVisioCredentials() {
    if (!platformSelectElPersist) return;
    const platformKey = platformSelectElPersist.value || 'default';
    const loginValue = manualLoginEl?.value?.trim() || '';
    const passwordValue = manualPasswordEl?.value?.trim() || '';

    const creds = (await CompatAPI.storageGet({ visioCredentials: {} })).visioCredentials;
    creds[platformKey] = { login: loginValue, password: passwordValue, ts: new Date().toISOString() };
    await CompatAPI.storageSet({ visioCredentials: creds });
    console.info(`[MirAI] Identifiants sauvegardés pour ${platformKey}`);
  }

  // Sauvegarde automatique et réactive (avec délai court pour éviter trop d'écritures)
  let saveTimeout = null;
  function delayedSave() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(saveVisioCredentials, 400);
  }

  if (manualLoginEl) {
    manualLoginEl.addEventListener('input', delayedSave);
    manualLoginEl.addEventListener('change', saveVisioCredentials);
  }
  if (manualPasswordEl) {
    manualPasswordEl.addEventListener('input', delayedSave);
    manualPasswordEl.addEventListener('change', saveVisioCredentials);
  }

  // 🔹 Sauvegarde et perte de focus lors de la touche "Entrée"
  if (manualLoginEl) {
    manualLoginEl.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        await saveVisioCredentials();
        manualLoginEl.blur(); // Sort du focus
        console.info('[MirAI] Identifiant sauvegardé via touche Entrée');
      }
    });
  }

  if (manualPasswordEl) {
    manualPasswordEl.addEventListener('keydown', async (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        await saveVisioCredentials();
        manualPasswordEl.blur(); // Sort du focus
        console.info('[MirAI] Mot de passe sauvegardé via touche Entrée');
      }
    });
  }

  // Restaure automatiquement les identifiants selon la plateforme sélectionnée
  if (platformSelectElPersist) {
    platformSelectElPersist.addEventListener('change', async () => {
      const creds = (await CompatAPI.storageGet({ visioCredentials: {} })).visioCredentials;
      const selectedPlatform = platformSelectElPersist.value;
      if (creds[selectedPlatform]) {
        if (manualLoginEl) manualLoginEl.value = creds[selectedPlatform].login || '';
        if (manualPasswordEl) manualPasswordEl.value = creds[selectedPlatform].password || '';
        console.info(`[MirAI] Identifiants restaurés pour ${selectedPlatform}`);
      } else {
        if (manualLoginEl) manualLoginEl.value = '';
        if (manualPasswordEl) manualPasswordEl.value = '';
      }
    });
  }

  // 🔹 Relecture automatique du mot de passe et login au chargement du popup
  try {
    const creds = (await CompatAPI.storageGet({ visioCredentials: {} })).visioCredentials;
    const currentPlatform = platformSelectElPersist?.value || '';
    if (creds[currentPlatform]) {
      if (manualLoginEl) manualLoginEl.value = creds[currentPlatform].login || '';
      if (manualPasswordEl) manualPasswordEl.value = creds[currentPlatform].password || '';
      console.info(`[MirAI] Identifiants relus au chargement pour ${currentPlatform}`);
    }
  } catch (e) {
    console.warn('[MirAI] Impossible de relire les identifiants au démarrage :', e);
  }
});

// ======================================================================
// DM Bootstrap + Telemetry init + Update banner
// ======================================================================
(async function dmInit() {
  try {
    // Init DM config (from cache/fallback — background.js handles periodic refresh)
    if (window.DMBootstrap) {
      await window.DMBootstrap.init();
      console.info('[MirAI DM] Config loaded:', window.DMBootstrap.getConfig());
    }

    // Init telemetry
    if (window.DMTelemetry && window.DMBootstrap) {
      window.DMTelemetry.init(window.DMBootstrap.getConfig());
    }

    // Sync local recordings with API (detect stale CAPTURE_IN_PROGRESS)
    if (typeof syncRecordingsWithAPI === 'function') {
      syncRecordingsWithAPI().catch(e => console.warn('[MirAI] Sync recordings failed:', e.message));
    }

    // Show update banner if available
    if (window.DMBootstrap) {
      const update = await window.DMBootstrap.getUpdate();
      if (update && update.target_version) {
        const banner = document.getElementById('dm-update-banner');
        const versionEl = document.getElementById('dm-update-version');
        const linkEl = document.getElementById('dm-update-link');
        const dismissEl = document.getElementById('dm-update-dismiss');
        if (banner) {
          banner.style.display = 'block';
          if (versionEl) versionEl.textContent = `v${update.target_version}`;
          if (linkEl && update.artifact_url) {
            linkEl.href = update.artifact_url;
          } else if (linkEl) {
            linkEl.style.display = 'none';
          }
          if (dismissEl) {
            dismissEl.addEventListener('click', () => { banner.style.display = 'none'; });
          }
        }
      }
    }
  } catch (e) {
    console.warn('[MirAI DM] Init error (non-blocking):', e);
  }
})();