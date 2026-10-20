// firefox.mjs — pilote Firefox de la recette de la bulle (WebDriver BiDi).
// Firefox est lancé par `web-ext run … --args=--remote-debugging-port=<port>` (voir recette.sh).
// Usage : node firefox.mjs <port> <dossier des captures>
import fs from 'node:fs';
import { jouer } from './scenarios.mjs';

const [, , port, sortie] = process.argv;
const ws = new WebSocket(`ws://127.0.0.1:${port}/session`);
let id = 0;
const attente = new Map();
const bidi = (method, params = {}) => new Promise((res) => {
  const i = ++id; attente.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && attente.has(m.id)) { attente.get(m.id)(m); attente.delete(m.id); } };
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

// Valeur BiDi sérialisée → valeur JS (types utilisés par les scénarios).
const deserialiser = (v) => {
  if (!v) return undefined;
  if (v.type === 'array') return v.value.map(deserialiser);
  if (v.type === 'object') return Object.fromEntries(v.value.map(([k, x]) => [k, deserialiser(x)]));
  if (v.type === 'null' || v.type === 'undefined') return v.type === 'null' ? null : undefined;
  return v.value;
};

ws.onopen = async () => {
  let echecs = 1;
  try {
    await bidi('session.new', { capabilities: {} });
    await pause(1500);
    const arbre = await bidi('browsingContext.getTree', {});
    const ext = arbre.result.contexts.map((c) => c.url).find((u) => u.startsWith('moz-extension://'));
    if (!ext) throw new Error('page de l\'extension introuvable (l\'arrière-plan a-t-il démarré ?)');
    const uuid = ext.split('/')[2];
    const opt = (await bidi('browsingContext.create', { type: 'tab' })).result.context;
    const page = (await bidi('browsingContext.create', { type: 'tab' })).result.context;
    const evaluer = async (ctx, expression) => deserialiser((await bidi('script.evaluate', { target: { context: ctx }, expression, awaitPromise: true })).result?.result);
    const pointeur = (actions) => bidi('input.performActions', { context: page, actions: [{ type: 'pointer', id: 'souris', parameters: { pointerType: 'mouse' }, actions }] });
    const touches = (valeurs) => bidi('input.performActions', { context: page, actions: [{ type: 'key', id: 'clavier', actions: valeurs.flatMap((c) => [{ type: 'keyDown', value: c }, { type: 'keyUp', value: c }]) }] });

    echecs = await jouer({
      pause,
      options: async (x) => {
        await bidi('browsingContext.navigate', { context: opt, url: `moz-extension://${uuid}/src/options.html`, wait: 'complete' });
        return evaluer(opt, x);
      },
      aller: async (u) => { await bidi('browsingContext.navigate', { context: page, url: u, wait: 'complete' }); await pause(2000); },
      page: (x) => evaluer(page, x),
      taille: () => evaluer(page, '[innerWidth, innerHeight]'),
      clic: (x, y) => pointeur([{ type: 'pointerMove', x, y }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }]),
      glisser: (x0, y0, x1, y1) => pointeur([{ type: 'pointerMove', x: x0, y: y0 }, { type: 'pointerDown', button: 0 },
        { type: 'pointerMove', x: x1, y: y1, duration: 300 }, { type: 'pointerUp', button: 0 }]),
      taper: (texte) => touches([...texte]),
      entree: () => touches(['']),
      echap: () => touches(['']),
      capture: async (nom) => {
        const img = await bidi('browsingContext.captureScreenshot', { context: page });
        fs.writeFileSync(`${sortie}/firefox-${nom}`, Buffer.from(img.result.data, 'base64'));
      }
    }, 'browser');
  } catch (e) {
    console.log('ÉCHEC', e.message);
  }
  process.exit(echecs ? 1 : 0);
};
ws.onerror = () => { console.log('ÉCHEC connexion BiDi'); process.exit(1); };
