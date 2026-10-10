// FIPSA · Panel de imágenes — API serverless (Vercel)
// Requiere variables de entorno: ADMIN_PASSWORD, GITHUB_TOKEN
const crypto = require('crypto');

const REPO = 'edgar-a11y/fipsaplegadizos-web';
const GH = 'https://api.github.com';

// ---------- utilidades ----------
function dayStr(offset = 0) {
  const d = new Date(Date.now() - offset * 86400000);
  return d.toISOString().slice(0, 10);
}
function makeToken(day) {
  return crypto.createHmac('sha256', process.env.ADMIN_PASSWORD || '')
    .update('fipsa-admin:' + day).digest('hex');
}
function isAuthed(req) {
  const c = req.headers.cookie || '';
  const m = c.match(/fipsa_s=([a-f0-9]{64})/);
  if (!m) return false;
  return m[1] === makeToken(dayStr(0)) || m[1] === makeToken(dayStr(1));
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a)), bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}
async function gh(path, opts = {}) {
  const r = await fetch(GH + path, {
    ...opts,
    headers: {
      'Authorization': 'Bearer ' + process.env.GITHUB_TOKEN,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'fipsa-panel',
      ...(opts.headers || {}),
    },
  });
  if (!r.ok && r.status !== 404) {
    const t = await r.text();
    throw new Error('GitHub ' + r.status + ': ' + t.slice(0, 200));
  }
  return r;
}
async function getFile(path) {
  const r = await gh(`/repos/${REPO}/contents/${path}?ref=main&t=${Date.now()}`);
  if (r.status === 404) return null;
  const j = await r.json();
  return { sha: j.sha, buf: Buffer.from(j.content, 'base64') };
}
async function putFile(path, buf, message, sha) {
  const body = { message, content: buf.toString('base64'), branch: 'main' };
  if (sha) body.sha = sha;
  const r = await gh(`/repos/${REPO}/contents/${path}`, {
    method: 'PUT', body: JSON.stringify(body),
  });
  return r.json();
}

// ---------- acciones ----------
async function doReplace(body) {
  const sharp = require('sharp');
  const man = JSON.parse((await getFile('img/manifest.json')).buf.toString('utf-8'));
  const slot = man.slots.find(s => s.id === body.slot);
  if (!slot) throw new Error('Slot desconocido: ' + body.slot);

  const input = Buffer.from(body.data, 'base64');
  let img = sharp(input, { failOn: 'none' }).rotate(); // respeta orientación EXIF
  let out, note;
  if (slot.kind === 'png') {
    out = await img.resize(slot.w * 2, slot.h * 2, { fit: 'inside', withoutEnlargement: true })
      .png({ compressionLevel: 9 }).toBuffer();
    note = 'PNG (logo)';
  } else if (slot.kind === 'jpeg') {
    out = await img.resize(slot.w, slot.h, { fit: 'cover', position: 'attention' })
      .jpeg({ quality: 82, progressive: true }).toBuffer();
    note = `JPG ${slot.w}×${slot.h}`;
  } else {
    out = await img.resize(slot.w, slot.h, { fit: 'cover', position: 'attention' })
      .webp({ quality: 82 }).toBuffer();
    note = `WebP ${slot.w}×${slot.h}`;
  }

  const prev = await getFile('img/' + slot.file);
  await putFile('img/' + slot.file, out,
    `Panel: actualiza imagen "${slot.label}" (${slot.id})`, prev ? prev.sha : undefined);

  // si era un hueco pendiente, ya no lo es
  if (slot.needs_photo) {
    slot.needs_photo = false;
    const manFile = await getFile('img/manifest.json');
    const fresh = JSON.parse(manFile.buf.toString('utf-8'));
    const fs = fresh.slots.find(s => s.id === slot.id);
    if (fs) fs.needs_photo = false;
    await putFile('img/manifest.json', Buffer.from(JSON.stringify(fresh, null, 1)),
      `Panel: ${slot.id} ya tiene foto real`, manFile.sha);
  }
  return { ok: true, kb_in: Math.round(input.length / 1024), kb_out: Math.round(out.length / 1024), note };
}

async function doAlt(body) {
  const manFile = await getFile('img/manifest.json');
  const man = JSON.parse(manFile.buf.toString('utf-8'));
  const slot = man.slots.find(s => s.id === body.slot);
  if (!slot || !slot.alt) throw new Error('Slot sin texto alternativo editable');

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
  const edits = [['index.html', esc(body.alt_es)], ['en/index.html', esc(body.alt_en)]];
  for (const [path, alt] of edits) {
    const f = await getFile(path);
    let html = f.buf.toString('utf-8');
    const re = new RegExp('(src="/img/' + slot.file.replace('.', '\\.') + '"[^>]*alt=")[^"]*(")');
    if (!re.test(html)) throw new Error('No encontré la imagen en ' + path);
    html = html.replace(re, '$1' + alt + '$2');
    await putFile(path, Buffer.from(html), `Panel: texto SEO de "${slot.label}" (${path})`, f.sha);
  }
  slot.alt = { es: body.alt_es, en: body.alt_en };
  await putFile('img/manifest.json', Buffer.from(JSON.stringify(man, null, 1)),
    `Panel: texto SEO de ${slot.id}`, manFile.sha);
  return { ok: true };
}

// ---------- handler ----------
module.exports = async (req, res) => {
  try {
    if (req.method !== 'POST') { res.status(405).json({ error: 'POST únicamente' }); return; }
    const body = req.body || {};
    const action = body.action;

    if (action === 'login') {
      if (!process.env.ADMIN_PASSWORD) { res.status(500).json({ error: 'Falta configurar ADMIN_PASSWORD en Vercel' }); return; }
      if (!safeEq(body.password || '', process.env.ADMIN_PASSWORD)) {
        res.status(401).json({ error: 'Contraseña incorrecta' }); return;
      }
      res.setHeader('Set-Cookie',
        `fipsa_s=${makeToken(dayStr(0))}; Path=/; Max-Age=43200; HttpOnly; Secure; SameSite=Strict`);
      res.json({ ok: true }); return;
    }

    if (!isAuthed(req)) { res.status(401).json({ error: 'Sesión expirada. Vuelve a entrar.' }); return; }

    if (action === 'state') {
      if (!process.env.GITHUB_TOKEN) { res.status(500).json({ error: 'Falta configurar GITHUB_TOKEN en Vercel' }); return; }
      const man = JSON.parse((await getFile('img/manifest.json')).buf.toString('utf-8'));
      res.json({ ok: true, manifest: man }); return;
    }
    if (action === 'replace') { res.json(await doReplace(body)); return; }
    if (action === 'alt') { res.json(await doAlt(body)); return; }
    res.status(400).json({ error: 'Acción desconocida' });
  } catch (e) {
    res.status(500).json({ error: String(e.message || e).slice(0, 300) });
  }
};

module.exports.config = { api: { bodyParser: { sizeLimit: '4mb' } } };
