const fs = require('fs').promises;
const path = require('path');

const RAW = path.resolve(__dirname, '../data/raw');
const INDEX = path.resolve(__dirname, '../data/index.json');

function parseName(name) {
  // matches e.g. 9_2025-2026_s9_132_match.js or 9_2025-2026_s9_match.js
  const m = name.match(/^(\d+)_(.+?)_s(\d+)(?:_(\d+))?_(match|season)(?:\.js|\.json)$/);
  if (!m) return null;
  return {
    id: m[1],
    season: m[2],
    sId: m[3],
    sub: m[4] || null,
    kind: m[5],
  };
}

async function main() {
  const files = await fs.readdir(RAW);
  const grouped = new Map();

  for (const f of files) {
    const p = parseName(f);
    if (!p) continue;
    const key = `${p.id}__${p.season}__s${p.sId}`;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push({ name: f, info: p });
  }

  const toDelete = [];
  for (const [key, list] of grouped.entries()) {
    const hasSub = list.some((x) => x.info.sub !== null);
    if (hasSub) {
      // delete entries with sub === null (these are fallback incorrect files)
      for (const item of list) {
        if (item.info.sub === null) {
          toDelete.push(item.name);
        }
      }
    }
  }

  if (toDelete.length === 0) {
    console.log('没有发现匹配的错误文件要删除。');
    return;
  }

  console.log('将删除以下错误文件（并关联的 season/json）：');
  toDelete.forEach((n) => console.log(' -', n));

  // perform deletions (also remove sibling files like _season.js/_match.json)
  for (const name of toDelete) {
    const base = name.replace(/_(match|season)\.(js|json)$/, '');
    // possible siblings
    const patterns = [`${base}_match.js`, `${base}_season.js`, `${base}_match.json`, `${base}_season.json`];
    for (const p of patterns) {
      const fp = path.join(RAW, p);
      try {
        await fs.unlink(fp);
        console.log('删除', p);
      } catch (e) {
        // ignore missing
      }
    }
  }

  // update index.json: replace any matchFile/seasonFile/matchJson/seasonJson pointing to deleted files
  try {
    const idx = JSON.parse(await fs.readFile(INDEX, 'utf8'));
    let changed = false;
    for (const entry of idx) {
      for (const field of ['matchFile', 'seasonFile', 'matchJson', 'seasonJson']) {
        if (!entry[field]) continue;
        const fn = entry[field].replace(/^raw\//, '');
        if (toDelete.includes(fn)) {
          // try to find replacement: entry.subSclassId may point to a sub variant
          if (entry.subSclassId) {
            const newBase = fn.replace(/_s(\d+)_match\.js$|_s(\d+)_season\.js$|_s(\d+)_match\.json$|_s(\d+)_season\.json$/, `_s$1_${entry.subSclassId}_match.js`);
            // fallback: scan RAW for any file starting with id_season_s{id}_{sub}
            const filesNow = await fs.readdir(RAW);
            const candidate = filesNow.find((f) => f.startsWith(fn.replace(/_(match|season)\.(js|json)$/, '')) && f.includes(`_${entry.subSclassId}_`));
            if (candidate) {
              entry[field] = `raw/${candidate}`;
              changed = true;
              continue;
            }
          }
          // otherwise null it
          entry[field] = null;
          changed = true;
        }
      }
    }
    if (changed) {
      await fs.writeFile(INDEX, JSON.stringify(idx, null, 2), 'utf8');
      console.log('已更新 data/index.json');
    } else {
      console.log('index.json 未检测到需要更新的引用。');
    }
  } catch (e) {
    console.warn('无法更新 index.json:', e.message);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
