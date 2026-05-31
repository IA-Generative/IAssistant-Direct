// welcome.js — page de bienvenue (premier lancement). Invite à se connecter (PKCE)
// pour activer le plug-in. Réutilise MiraiAuth (comme le popup).

(function () {
  const connectBtn = document.getElementById('connect');
  const laterBtn = document.getElementById('later');
  const statusEl = document.getElementById('status');

  function setStatus(text, cls) {
    statusEl.textContent = text || '';
    statusEl.className = 'status' + (cls ? ' ' + cls : '');
  }

  function showActivated() {
    connectBtn.textContent = 'Plug-in activé ✓';
    connectBtn.disabled = true;
    laterBtn.textContent = 'Fermer';
    setStatus('Vous êtes connecté. Rendez-vous sur une page de réunion pour utiliser le bouton REC.', 'ok');
  }

  // Si déjà connecté (token valide), refléter l'état d'emblée.
  (async () => {
    try {
      const token = await window.MiraiAuth.getValidToken();
      if (token) showActivated();
    } catch (e) { /* pas connecté : on laisse le CTA */ }
  })();

  connectBtn.addEventListener('click', async () => {
    connectBtn.disabled = true;
    setStatus('Connexion en cours… (un onglet SSO va s\'ouvrir)', 'busy');
    try {
      const token = await window.MiraiAuth.login();
      if (token) {
        showActivated();
      } else {
        connectBtn.disabled = false;
        setStatus('Connexion annulée ou échouée. Réessayez.', 'err');
      }
    } catch (e) {
      connectBtn.disabled = false;
      setStatus('Erreur de connexion : ' + (e?.message || e), 'err');
    }
  });

  laterBtn.addEventListener('click', () => {
    window.close();
  });
})();
