// chrome.mjs — pilote Chrome de la recette de la bulle (CDP par pipe).
// Chrome ≥ 137 ignore --load-extension : l'extension est chargée par Extensions.loadUnpacked.
// Usage : node chrome.mjs <dossier de l'extension préparée> <dossier des captures>
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { jouer } from './scenarios.mjs';

const [, , ext, sortie] = process.argv;
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profil = fs.mkdtempSync(sortie + '/profil-chrome-');
const nav = spawn(CHROME, ['--headless=new', '--remote-debugging-pipe', '--enable-unsafe-extension-debugging',
  '--no-first-run', '--no-default-browser-check', `--user-data-dir=${profil}`, '--window-size=1280,900', 'about:blank'],
{ stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });

let id = 0, tampon = '';
const attente = new Map();
nav.stdio[4].on('data', (d) => {
  tampon += d.toString();
  for (let i; (i = tampon.indexOf('\0')) >= 0;) {
    const m = JSON.parse(tampon.slice(0, i));
    tampon = tampon.slice(i + 1);
    if (m.id && attente.has(m.id)) { attente.get(m.id)(m); attente.delete(m.id); }
  }
});
const cdp = (method, params = {}, sessionId) => new Promise((res) => {
  const i = ++id; attente.set(i, res);
  nav.stdio[3].write(JSON.stringify({ id: i, method, params, sessionId }) + '\0');
});
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function onglet() {
  const { result: { targetId } } = await cdp('Target.createTarget', { url: 'about:blank' });
  const { result: { sessionId } } = await cdp('Target.attachToTarget', { targetId, flatten: true });
  await cdp('Page.enable', {}, sessionId);
  return sessionId;
}
const evaluer = async (s, expression) => {
  const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, s);
  return r.result?.result?.value;
};
const souris = (s, type, x, y, extra = {}) => cdp('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra }, s);
const touche = async (s, key, code, keyCode, text) => {
  await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key, code, windowsVirtualKeyCode: keyCode, text }, s);
  await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode: keyCode }, s);
};

let echecs = 1;
try {
  await pause(1500);
  const extId = (await cdp('Extensions.loadUnpacked', { path: ext })).result?.id;
  if (!extId) throw new Error('extension non chargée');
  await pause(2000);
  const opt = await onglet();
  const page = await onglet();
  echecs = await jouer({
    pause,
    options: async (x) => {
      await cdp('Page.navigate', { url: `chrome-extension://${extId}/src/options.html` }, opt);
      await pause(1500);
      return evaluer(opt, x);
    },
    aller: async (u) => { await cdp('Page.navigate', { url: u }, page); await pause(3000); },
    page: (x) => evaluer(page, x),
    taille: async () => evaluer(page, '[innerWidth, innerHeight]'),
    clic: async (x, y) => { await souris(page, 'mousePressed', x, y, { clickCount: 1 }); await souris(page, 'mouseReleased', x, y, { clickCount: 1 }); },
    glisser: async (x0, y0, x1, y1) => {
      await souris(page, 'mousePressed', x0, y0, { clickCount: 1 });
      for (let k = 1; k <= 10; k++) await souris(page, 'mouseMoved', x0 + (x1 - x0) * k / 10, y0 + (y1 - y0) * k / 10, { buttons: 1 });
      await souris(page, 'mouseReleased', x1, y1, { clickCount: 1 });
    },
    taper: (texte) => cdp('Input.insertText', { text: texte }, page),
    entree: () => touche(page, 'Enter', 'Enter', 13, '\r'),
    echap: () => touche(page, 'Escape', 'Escape', 27),
    capture: async (nom) => {
      const img = await cdp('Page.captureScreenshot', {}, page);
      fs.writeFileSync(`${sortie}/chrome-${nom}`, Buffer.from(img.result.data, 'base64'));
    }
  }, 'chrome');
} catch (e) {
  console.log('ÉCHEC', e.message);
} finally {
  nav.kill();
  await new Promise((r) => { nav.once('exit', r); setTimeout(r, 3000); });
  try { fs.rmSync(profil, { recursive: true, force: true }); } catch (e) { /* profil encore verrouillé : laissé dans le dossier temporaire */ }
  process.exit(echecs ? 1 : 0);
}
