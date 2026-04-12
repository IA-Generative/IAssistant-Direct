const SECRET_KEY = 'mirai-local-secret'; // clé statique locale pour chiffrement

const saveLoginInput = document.getElementById('saveLogin');
const savePasswordInput = document.getElementById('savePassword');
const showPassBtn = document.getElementById('show-pass');
const saveBtn = document.getElementById('save');

// Créer le bouton "Effacer" à gauche du bouton "Enregistrer"
const clearBtn = document.createElement('button');
clearBtn.id = 'clear';
clearBtn.textContent = 'Effacer';
clearBtn.type = 'button';
clearBtn.style.marginRight = '8px';
saveBtn.insertAdjacentElement('beforebegin', clearBtn);

// Gestion du clic sur le bouton Effacer
clearBtn.addEventListener('click', async () => {
  try {
    // Effacer du stockage
    await CompatAPI.storageRemove(['encryptedCreds']);
    // Effacer les champs visibles
    if (saveLoginInput) saveLoginInput.value = '';
    if (savePasswordInput) savePasswordInput.value = '';
    validateFields();

    // Masquer temporairement les boutons
    saveBtn.style.display = 'none';
    clearBtn.style.display = 'none';

    // Message de confirmation
    let statusMsg = document.getElementById('save-status');
    if (!statusMsg) {
      statusMsg = document.createElement('div');
      statusMsg.id = 'save-status';
      statusMsg.style.fontSize = '12px';
      statusMsg.style.color = '#666';
      statusMsg.style.marginTop = '6px';
      statusMsg.style.textAlign = 'left';
      saveBtn.parentNode.appendChild(statusMsg);
    }
    statusMsg.textContent = 'Identifiants effacés.';

    // Réafficher les boutons après 3 secondes
    setTimeout(() => {
      statusMsg.textContent = '';
      saveBtn.style.display = 'inline-block';
      clearBtn.style.display = 'inline-block';
    }, 3000);

    console.info('[MirAI] Identifiants effacés du stockage et de l’affichage.');
  } catch (err) {
    console.error('[MirAI] Erreur lors de la suppression des identifiants :', err);
    alert('Erreur lors de l’effacement des identifiants.');
  }
});

// Fonction de validation dynamique
function validateFields() {
  const login = saveLoginInput?.value.trim() || '';
  const password = savePasswordInput?.value.trim() || '';
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const isValid = emailRegex.test(login) && password.length >= 8;
  saveBtn.disabled = !isValid;
  saveBtn.style.opacity = isValid ? '1' : '0.5';
  return isValid;
}

// Attache les validateurs sur les champs
[saveLoginInput, savePasswordInput].forEach((input) => {
  if (input) input.addEventListener('input', validateFields);
});

// Vérifie au chargement
// Chargement initial (déchiffrement)
(async function () {
  try {
    const result = await CompatAPI.storageGet(['encryptedCreds']);
    const encryptedCreds = result?.encryptedCreds || null;
    if (!encryptedCreds) {
      console.warn('[MirAI] Aucun identifiant enregistré.');
      validateFields();
      return;
    }

    const creds = await decrypt(encryptedCreds, SECRET_KEY);

    // Vérifie la validité du résultat du déchiffrement
    if (!creds || typeof creds !== 'object' || !creds.login || !creds.password) {
      console.warn('[MirAI] Données de chiffrement invalides ou incomplètes.');
      await CompatAPI.storageRemove(['encryptedCreds']); // nettoyage
      validateFields();
      return;
    }

    if (saveLoginInput) saveLoginInput.value = creds.login;
    if (savePasswordInput) savePasswordInput.value = creds.password;
    validateFields();

  } catch (err) {
    console.warn('[MirAI] Erreur lors du déchiffrement ou chargement des identifiants :', err);
    validateFields();
  }
})();

// Sauvegarde identifiants chiffrés
saveBtn.addEventListener('click', async () => {
  const login = saveLoginInput?.value.trim() || '';
  const password = savePasswordInput?.value.trim() || '';

  if (!validateFields()) {
    alert('Veuillez saisir un email valide et un mot de passe d’au moins 8 caractères.');
    return;
  }

  try {
    const encryptedCreds = await encrypt({ login, password }, SECRET_KEY);
    await CompatAPI.storageSet({ encryptedCreds });

    // Masquer temporairement les boutons
    saveBtn.style.display = 'none';
    clearBtn.style.display = 'none';

    // Afficher un message de confirmation à gauche
    let statusMsg = document.getElementById('save-status');
    if (!statusMsg) {
      statusMsg = document.createElement('div');
      statusMsg.id = 'save-status';
      statusMsg.style.fontSize = '12px';
      statusMsg.style.color = '#0078d7';
      statusMsg.style.marginTop = '6px';
      statusMsg.style.textAlign = 'left';
      saveBtn.parentNode.appendChild(statusMsg);
    }
    statusMsg.textContent = 'Identifiants enregistrés avec succès.';

    // Attendre 2 secondes avant de fermer la fenêtre
    setTimeout(() => {
      window.close();
    }, 2000);

    console.info('[MirAI] Identifiants chiffrés et enregistrés.');
  } catch (err) {
    console.error('[MirAI] Erreur chiffrement identifiants :', err);
    alert('Erreur lors du chiffrement des identifiants.');
  }
});

// Affichage temporaire du mot de passe
if (showPassBtn && savePasswordInput) {
  showPassBtn.addEventListener('click', () => {
    if (savePasswordInput.type === 'password') {
      savePasswordInput.type = 'text';
      showPassBtn.textContent = 'Cacher';
      setTimeout(() => {
        savePasswordInput.type = 'password';
        showPassBtn.textContent = 'Afficher';
      }, 5000);
    } else {
      savePasswordInput.type = 'password';
      showPassBtn.textContent = 'Afficher';
    }
  });
}

// ======================================================================
// Auth — delegates to shared MiraiAuth module (src/auth.js)
// ======================================================================
async function checkKeycloakSession() {
  const token = await window.MiraiAuth.getValidToken();
  return !!token;
}

// ======================================================================
// 🚀 Fonctions de lancement des raccourcis MirAI
// ======================================================================
async function openMiraiShortcut(target) {
  const _sc = window.DMBootstrap?.getConfig() || {};
  const urls = {
    compterendu: _sc.compteRenduUrl || 'https://compte-rendu.mirai.interieur.gouv.fr/',
    comu: _sc.comuUrl || 'https://webconf.comu.gouv.fr/',
    visio: _sc.visioUrl || 'https://visio.numerique.gouv.fr/',
  };

  if (!urls[target]) {
    console.warn(`[MirAI] Raccourci inconnu : ${target}`);
    return;
  }

  const loggedIn = await checkKeycloakSession();
  if (!loggedIn) {
    alert('Vous devez être connecté à MirAI (SSO) pour accéder à ce raccourci.');
    return;
  }

  await CompatAPI.createTab({ url: urls[target] });
}

// ======================================================================
// 🧭 Attachement des raccourcis (si présents dans la page options.html)
// ======================================================================
document.addEventListener('DOMContentLoaded', () => {
  const report = document.getElementById('shortcut-report');
  const comu = document.getElementById('shortcut-comu');
  const visio = document.getElementById('shortcut-visio');

  if (report) report.addEventListener('click', () => openMiraiShortcut('compterendu'));
  if (comu) comu.addEventListener('click', () => openMiraiShortcut('comu'));
  if (visio) visio.addEventListener('click', () => openMiraiShortcut('visio'));
});
