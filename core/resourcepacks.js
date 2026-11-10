// Keeps the resource packs from the config downloaded and turned on.
// Packs come from Modrinth (the official source, never re-uploaded by us) and are checked against their hashes.
const fs = require('fs');
const path = require('path');
const { fetchJson, download, fileMatches } = require('./net');
const { safeFileName, assertTrustedUrl } = require('./safe');

const MODRINTH = 'https://api.modrinth.com/v2';

async function resolvePacks(slugs, mcVersion) {
  const q = `loaders=${encodeURIComponent('["minecraft"]')}&game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  return Promise.all(slugs.map(async slug => {
    const versions = await fetchJson(`${MODRINTH}/project/${slug}/version?${q}`);
    const v = versions.find(x => x.version_type === 'release') || versions[0];
    if (!v) throw new Error(`리소스팩 "${slug}"는 ${mcVersion} 버전을 아직 지원하지 않아요.`);
    const file = v.files.find(f => f.primary) || v.files[0];
    const name = safeFileName(file?.filename, '.zip');
    if (!name || !/^[0-9a-f]{40}$/i.test(file.hashes?.sha1 || '')) throw new Error(`리소스팩 "${slug}" 파일 정보가 이상해서 멈췄어요.`);
    assertTrustedUrl(file.url, ['modrinth.com']);
    return { name, url: file.url, sha1: file.hashes.sha1 };
  }));
}

/** Downloads the packs. Returns { packs, old } — old = names we installed before and no longer use. */
async function syncResourcePacks(root, mcVersion, slugs, report) {
  const dir = path.join(root, 'resourcepacks');
  const manifestPath = path.join(root, 'launcher-packs.json');
  fs.mkdirSync(dir, { recursive: true });
  const prev = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
  const prevNames = (prev?.packs || []).map(p => safeFileName(p.name, '.zip')).filter(Boolean);

  let packs;
  try {
    packs = await resolvePacks(slugs, mcVersion);
  } catch (e) {
    // No internet? Keep using what was installed last time.
    if (prev && prev.mcVersion === mcVersion && prev.packs.every(p => fs.existsSync(path.join(dir, p.name)))) {
      return { packs: prev.packs, old: [] };
    }
    throw e;
  }

  const keep = new Set(packs.map(p => p.name));
  const old = prevNames.filter(n => !keep.has(n));
  for (const n of old) fs.rmSync(path.join(dir, n), { force: true });

  const ok = await Promise.all(packs.map(p => fileMatches(path.join(dir, p.name), p.sha1, 'sha1')));
  const missing = packs.filter((_, i) => !ok[i]);
  for (let i = 0; i < missing.length; i++) {
    const p = missing[i];
    report({ step: `리소스팩 받는 중 (${i + 1}/${missing.length}) ${p.name}`, progress: i / missing.length });
    await download(p.url, path.join(dir, p.name), { hash: p.sha1, algo: 'sha1' });
  }
  fs.writeFileSync(manifestPath, JSON.stringify({ mcVersion, packs }, null, 2));
  return { packs, old };
}

/**
 * Turns our packs on in options.txt, in config order (later = higher priority), on top of the player's own packs.
 * Packs we used to install are taken out of the list.
 */
function enableResourcePacks(root, packs, old = []) {
  const file = path.join(root, 'options.txt');
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const lines = text.split(/\r?\n/);
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const ours = new Set([...packs.map(p => p.name), ...old].map(n => `file/${n}`));
  const editList = (key, add) => {
    const i = lines.findIndex(l => l.startsWith(key + ':'));
    let list = [];
    if (i >= 0) {
      try { list = JSON.parse(lines[i].slice(key.length + 1)); } catch { list = []; }
      if (!Array.isArray(list)) list = [];
    }
    list = list.filter(x => typeof x === 'string' && !ours.has(x)).concat(add);
    const line = `${key}:${JSON.stringify(list)}`;
    if (i >= 0) lines[i] = line; else lines.push(line);
  };
  editList('resourcePacks', packs.map(p => `file/${p.name}`));
  editList('incompatibleResourcePacks', []);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(file, lines.join('\n') + '\n');
}

module.exports = { syncResourcePacks, enableResourcePacks };
