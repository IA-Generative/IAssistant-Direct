// Works in both window (popup) and self (service worker)
const _global = typeof window !== 'undefined' ? window : self;
const API_BASE = _global.DMBootstrap?.getConfig()?.apiBase || 'https://compte-rendu.mirai.interieur.gouv.fr/api';

async function startMiraiRecording(sessionData) {
  console.log('[MirAI] Démarrage enregistrement avec données :', sessionData);

  const { url, platform, login, password } = sessionData;


  // 🔹 Récupère le token MirAI depuis le stockage local
  let token = await getLocalToken();

  try {
    // 1️⃣ Vérifier si une réunion est déjà en cours
    const activeMeeting = await findActiveMeeting(sessionData, token);

    if (activeMeeting) {
      console.info('[MirAI] Enregistrement deja en cours :', activeMeeting.id, activeMeeting.status);
      activeMeeting.url = url;
      return { ...activeMeeting, status: 'CAPTURE_IN_PROGRESS' };
    }

    // 2️⃣ Créer une nouvelle réunion
    const newMeeting = await createMeeting(sessionData, token)
    
    // 3️⃣ Lancer la capture pour cette réunion
    await startCreatedMeeting(newMeeting, token)
    
    newMeeting.url = url ; // on ajoute l'url après. ( pour comu cela plante si on le passe.)

    // 4️⃣ Met à jour le statut local
    if (_global.DMTelemetry) _global.DMTelemetry.sendSpan('recording.start', { meeting_id: newMeeting.id, platform: platform });
    return { ...newMeeting, status: 'CAPTURE_IN_PROGRESS' };

  } catch (e) {
    console.error('[MirAI] Erreur dans startMiraiRecording :', e);
    if (_global.DMTelemetry) _global.DMTelemetry.sendSpan('recording.error', { error: e.message, platform: platform });
    return null;
  }
}

async function getLocalToken() {
  let token = null;
  try {
    // Token chiffré au repos → passe par TokenStore (crypto.js).
    const miraiToken = await TokenStore.getToken();
    if (miraiToken && miraiToken.access_token) {
      token = miraiToken.access_token;
    }
  } catch (err) {
    console.warn('[MirAI] Impossible de récupérer le token local :', err);
  }

  // 🔹 Vérifie si un token est disponible
  if (!token) {
    console.error('[MirAI] Aucun token d’accès MirAI trouvé : authentification requise.');
    throw new Error('Authentification MirAI requise.');
  }

  console.log('[MirAI] Token récupéré :', token);
  return token
}

async function findActiveMeeting(sessionData, token) {

  const { url, platform, login, password } = sessionData;

    const meetingsResp = await fetch(`${API_BASE}/meetings?per_page=100`, {
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!meetingsResp.ok) throw new Error('Erreur lors de la récupération des réunions');
    const meetingsData = await meetingsResp.json();
    // API may return an array or an object with a results/meetings/items key
    const existingMeetings = Array.isArray(meetingsData)
      ? meetingsData
      : (meetingsData.data || meetingsData.results || meetingsData.meetings || meetingsData.items || []);

    const isComu = (platform || '').toUpperCase() === "COMU";

    const activeMeeting = existingMeetings.find(m => {
      if (!['CAPTURE_PENDING', 'CAPTURE_IN_PROGRESS'].includes(m.status)) {
        return false;
      }

      // Pour COMU, on se base sur le login (meeting_platform_id)
      if (isComu) {
        return m.meeting_platform_id === login;
      }

      // Sinon, on se base sur l'URL
      return m.url === url;
    });

    return activeMeeting
}

async function createMeeting(sessionData, token) {
    const payload = buildCreateMeetingPayload(sessionData)
    const createResp = await fetch(`${API_BASE}/meetings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        //'x-user-keycloak-uuid': userUUID,
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    });

    if (!createResp.ok) {
      throw new Error('Échec de la création de la réunion', await createResp.json());
    }
    const newMeeting = await createResp.json();

    console.info('[MirAI] Réunion créée :', newMeeting);
    if (_global.DMTelemetry) _global.DMTelemetry.sendSpan('meeting.create', { meeting_id: newMeeting.id });

    return newMeeting
}


// Retourne un object si recording en cours ou null si absence.

async function getOngoingRecordings(token) {





  return null

}


async function startCreatedMeeting(newMeeting, token) {
    const captureResp = await fetch(`${API_BASE}/meetings/${newMeeting.id}/capture/init`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`
      }
    });

    if (!captureResp.ok) {
      throw new Error('Échec du démarrage de la capture', await captureResp.json());
    }
    console.info(`[MirAI] Capture démarrée pour la réunion ${newMeeting.id}`);

}

function buildCreateMeetingPayload(sessionData) {
  const { url, platform, login, password } = sessionData;
  console.log("[MirAI] platform reçu :", platform);

    // 🔒 Calcul sécurisé du nom de la réunion
    const safePlatform = (platform || "Inconnue")
      .toString()
      .trim()
      .replace(/[^\wÀ-ÖØ-öø-ÿ\s-]/g, '')
      .replace(/\s+/g, ' ');

    const formattedDate = new Date().toLocaleString('fr-FR', {
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit"
    });

    const meetingName = `Réunion ${safePlatform} - ${formattedDate}`;

    // VISIO and WEBCONF require url; COMU uses meeting_platform_id + password
    const platformUpper = safePlatform.toUpperCase();
    const needsUrl = ['VISIO', 'WEBCONF', 'WEBINAIRE'].includes(platformUpper);

    return {
        name: meetingName,
        url: needsUrl ? (url || null) : null,
        name_platform: platformUpper,
        creation_date: new Date().toISOString(),
        meeting_password: password || null,
        meeting_platform_id: login || null,
        status: 'NONE'
      }
}

async function stopMiraiRecording(currentMiraiRecord) {
  console.log('[MirAI] Arrêt enregistrement pour objet :', currentMiraiRecord);

  let token = await getLocalToken();

  const headers = {
    'Accept': 'application/json, text/plain, */*',
    'Authorization': `Bearer ${token}`
  };


  try {
    const meetingId = currentMiraiRecord.meeting_id;
      
    // on regarde l'état du meeting
    const urlget = `${API_BASE}/meetings/${meetingId}`;
    const meetingsResp = await fetch(urlget, { method: 'GET', headers });
    const existingMeetings = await meetingsResp.json()

    if (existingMeetings.status == "CAPTURE_IN_PROGRESS" ){
      
      const urls = `${API_BASE}/meetings/${meetingId}/capture/stop`;
      const response = await fetch(urls, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } });

      if (response.status !== 204) throw new Error('Échec de l’arrêt de la capture');
      console.info('[MirAI] Capture arrêtée avec succès (meeting :', meetingId, ') : ', response);
      if (_global.DMTelemetry) _global.DMTelemetry.sendSpan('recording.stop', { meeting_id: meetingId });
      return true;

    }

    console.info('[MirAI] Capture inchangée pour meeting :', meetingId);
    return false;

  } catch (e) {
    console.error('[MirAI] Erreur lors de l’arrêt de la capture :', e);
    return null;
  }
}

/**
 * Sync local recordings with the API.
 * Checks each CAPTURE_IN_PROGRESS recording against the server
 * and updates the local status if it has changed.
 */
async function syncRecordingsWithAPI() {
  const B = typeof browser !== 'undefined' ? browser : chrome;
  try {
    const token = await getLocalToken();
    let { recordings = [] } = await B.storage.local.get({ recordings: [] });
    let changed = false;

    // 1. Check local CAPTURE_IN_PROGRESS against server
    const localOngoing = recordings.filter(r => (r.status === 'CAPTURE_IN_PROGRESS' || r.status === 'CAPTURE_PENDING') && r.id);
    for (const rec of localOngoing) {
      try {
        const resp = await fetch(`${API_BASE}/meetings/${rec.id}`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        if (resp.ok) {
          const meeting = await resp.json();
          if (meeting.status && meeting.status !== 'CAPTURE_IN_PROGRESS' && meeting.status !== 'CAPTURE_PENDING') {
            console.info(`[MirAI] Recording ${rec.id} synced: ${rec.status} -> ${meeting.status}`);
            rec.status = meeting.status;
            changed = true;
          }
        } else if (resp.status === 404) {
          rec.status = 'STOPPED';
          changed = true;
        }
      } catch (e) {
        console.warn(`[MirAI] Could not sync recording ${rec.id}:`, e.message);
      }
    }

    // 2. Check server for active meetings not in local storage
    try {
      const resp = await fetch(`${API_BASE}/meetings?per_page=100`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        const serverMeetings = Array.isArray(data) ? data : (data.data || data.results || []);
        const serverActive = serverMeetings.filter(m =>
          m.status === 'CAPTURE_IN_PROGRESS' || m.status === 'CAPTURE_PENDING'
        );
        for (const sm of serverActive) {
          const localRec = recordings.find(r => r.id === sm.id || r.meeting_id === sm.id);
          if (localRec) {
            // Update local status to match server (e.g. STOPPED -> CAPTURE_IN_PROGRESS)
            if (localRec.status !== sm.status) {
              console.info(`[MirAI] Recording ${sm.id} status updated: ${localRec.status} -> ${sm.status}`);
              localRec.status = sm.status;
              changed = true;
            }
          } else {
            console.info(`[MirAI] Server active meeting ${sm.id} added to local storage`);
            recordings.unshift({
              id: sm.id,
              meeting_id: sm.id,
              ts: sm.creation_date || new Date().toISOString(),
              url: sm.url || '',
              platform: (sm.name_platform || '').toLowerCase(),
              login: sm.meeting_platform_id || '',
              status: sm.status
            });
            changed = true;
          }
        }
      }
    } catch (e) {
      console.warn('[MirAI] Could not fetch server meetings:', e.message);
    }

    if (changed) {
      await B.storage.local.set({ recordings: recordings.slice(0, 20) });
      console.info('[MirAI] Recordings synced with API');
    }
    return recordings;
  } catch (e) {
    console.warn('[MirAI] syncRecordingsWithAPI failed:', e.message);
    return [];
  }
}

// Exports for popup.js (window) and background.js (self/service worker)
if (typeof window !== 'undefined') {
    window.startMiraiRecording = startMiraiRecording;
    window.stopMiraiRecording = stopMiraiRecording;
    window.syncRecordingsWithAPI = syncRecordingsWithAPI;
} else if (typeof self !== 'undefined') {
    self.startMiraiRecording = startMiraiRecording;
    self.stopMiraiRecording = stopMiraiRecording;
    self.syncRecordingsWithAPI = syncRecordingsWithAPI;
}
