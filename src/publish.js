// Pubblica su Facebook e Instagram i post del piano arrivati alla loro ora.
// Avviato da GitHub Actions ogni 15 minuti. Nessuna dipendenza esterna (Node 20+).
import fs from 'node:fs/promises';
import path from 'node:path';

const TOKEN = process.env.META_TOKEN;
const DRY_RUN = process.env.DRY_RUN === 'true';
const ONLY_ID = (process.env.ONLY_ID || '').trim();

const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
const pages = JSON.parse(await fs.readFile('pages.json', 'utf8'));
const STATE_FILE = 'state/published.json';
const state = JSON.parse(await fs.readFile(STATE_FILE, 'utf8').catch(() => '{}'));
const G = `https://graph.facebook.com/${cfg.graphVersion}`;
const MAX_LATE_MS = (cfg.maxLateMinutes ?? 360) * 60_000;
const MAX_ATTEMPTS = cfg.maxAttempts ?? 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), ...a);

if (!TOKEN && !DRY_RUN) {
  console.error('Manca il secret META_TOKEN. Vedi la guida, passo "Secret".');
  process.exit(1);
}

async function api(p, params = {}, method = 'POST') {
  const url = new URL(p.startsWith('http') ? p : G + p);
  let res;
  if (method === 'GET') {
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    res = await fetch(url);
  } else {
    res = await fetch(url, { method, body: new URLSearchParams(params) });
  }
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.error) throw new Error(`${p} -> ${JSON.stringify(j.error || j)}`);
  return j;
}

// ---- dati delle Pagine (token di Pagina + account Instagram collegato) ----
const pageCache = {};
async function pageInfo(key) {
  if (pageCache[key]) return pageCache[key];
  const cfgPage = pages[key];
  if (!cfgPage) throw new Error(`Pagina "${key}" non presente in pages.json`);
  const j = await api(`/${cfgPage.pageId}`, { fields: 'access_token,instagram_business_account', access_token: TOKEN }, 'GET');
  pageCache[key] = { pageId: cfgPage.pageId, token: j.access_token, igId: j.instagram_business_account?.id || null };
  return pageCache[key];
}

function mediaUrl(file) {
  return `${cfg.mediaBaseUrl.replace(/\/$/, '')}/${file.replace(/^\//, '')}`;
}

async function checkMedia(url) {
  const r = await fetch(url, { method: 'HEAD' });
  if (!r.ok) throw new Error(`File non raggiungibile (${r.status}): ${url}. GitHub Pages è attivo e il file è caricato?`);
}

// ---- Facebook ----
async function publishFacebook(post, pg) {
  const t = pg.token;
  if (post.tipo === 'testo') {
    const r = await api(`/${pg.pageId}/feed`, { message: post.testo, access_token: t });
    return r.id;
  }
  const url = mediaUrl(post.file);
  await checkMedia(url);
  if (post.tipo === 'immagine') {
    const r = await api(`/${pg.pageId}/photos`, { url, caption: post.testo, access_token: t });
    return r.post_id || r.id;
  }
  if (post.tipo === 'reel') {
    const start = await api(`/${pg.pageId}/video_reels`, { upload_phase: 'start', access_token: t });
    const up = await fetch(start.upload_url, { method: 'POST', headers: { Authorization: `OAuth ${t}`, file_url: url } });
    const upj = await up.json().catch(() => ({}));
    if (!up.ok || upj.success === false) throw new Error(`Upload reel fallito: ${JSON.stringify(upj)}`);
    await api(`/${pg.pageId}/video_reels`, {
      upload_phase: 'finish', video_id: start.video_id, video_state: 'PUBLISHED', description: post.testo, access_token: t,
    });
    return start.video_id;
  }
  throw new Error(`Tipo non valido: ${post.tipo}`);
}

// ---- Instagram ----
async function waitContainer(id, t, maxSec = 300) {
  for (let s = 0; s < maxSec; s += 10) {
    const j = await api(`/${id}`, { fields: 'status_code', access_token: t }, 'GET');
    if (j.status_code === 'FINISHED') return;
    if (j.status_code === 'ERROR' || j.status_code === 'EXPIRED') throw new Error(`Container Instagram ${j.status_code}`);
    await sleep(10_000);
  }
  throw new Error('Instagram: elaborazione troppo lunga, riprovo al prossimo giro');
}

async function publishInstagram(post, pg) {
  if (!pg.igId) throw new Error('Nessun account Instagram collegato a questa Pagina');
  if (post.tipo === 'testo') throw new Error('Instagram non accetta post di solo testo');
  const t = pg.token;
  const url = mediaUrl(post.file);
  await checkMedia(url);
  const params = post.tipo === 'reel'
    ? { media_type: 'REELS', video_url: url, caption: post.testo, share_to_feed: 'true', access_token: t }
    : { image_url: url, caption: post.testo, access_token: t };
  const c = await api(`/${pg.igId}/media`, params);
  await waitContainer(c.id, t);
  const r = await api(`/${pg.igId}/media_publish`, { creation_id: c.id, access_token: t });
  return r.id;
}

// ---- piano ----
async function loadPlan() {
  const files = (await fs.readdir('piano')).filter((f) => f.endsWith('.json'));
  const all = [];
  for (const f of files) {
    const arr = JSON.parse(await fs.readFile(path.join('piano', f), 'utf8'));
    for (const p of arr) all.push({ ...p, _file: f });
  }
  return all;
}

const now = Date.now();
const plan = await loadPlan();
let changed = false, done = 0, failed = 0;

for (const post of plan) {
  const when = Date.parse(post.quando);
  if (Number.isNaN(when)) { log(`[${post.id}] data non valida: ${post.quando}`); continue; }
  const forced = ONLY_ID && post.id === ONLY_ID;
  if (ONLY_ID && !forced) continue;
  if (!forced && (now < when || now - when > MAX_LATE_MS)) continue;

  for (const platform of post.piattaforme || ['facebook']) {
    const st = (state[post.id] ||= {});
    const s = (st[platform] ||= {});
    if (s.ok || (s.tentativi || 0) >= MAX_ATTEMPTS) continue;
    log(`[${post.id}] ${platform} ${post.tipo} -> ${post.pagina}${DRY_RUN ? ' (PROVA, non pubblico)' : ''}`);
    if (DRY_RUN) { if (post.file) { try { await checkMedia(mediaUrl(post.file)); log('   file OK'); } catch (e) { log('   ' + e.message); } } continue; }
    try {
      const pg = await pageInfo(post.pagina);
      const id = platform === 'instagram' ? await publishInstagram(post, pg) : await publishFacebook(post, pg);
      Object.assign(s, { ok: true, id, pubblicato: new Date().toISOString(), errore: undefined });
      log(`   pubblicato, id ${id}`);
      done++;
    } catch (e) {
      s.tentativi = (s.tentativi || 0) + 1;
      s.errore = e.message.slice(0, 500);
      log(`   ERRORE (tentativo ${s.tentativi}/${MAX_ATTEMPTS}): ${s.errore}`);
      failed++;
    }
    changed = true;
  }
}

if (changed && !DRY_RUN) await fs.writeFile(STATE_FILE, JSON.stringify(state, null, 2) + '\n');
log(`Fine: ${done} pubblicati, ${failed} errori.`);
if (failed && !done) process.exitCode = 1;
