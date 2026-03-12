const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');

async function collectTeams() {
  const RAW = path.resolve(__dirname, '../data/raw');
  const files = await fs.readdir(RAW).catch(()=>[]);
  const teams = new Map();
  for (const f of files) {
    if (!/\.js$/.test(f)) continue;
    try {
      const txt = await fs.readFile(path.join(RAW, f), 'utf8');
      if (!/var\s+arrTeam\s*=/.test(txt)) continue;
      const sandbox = { arrTeam: null, jh: {}, totalScore: null, arrLeague: null };
      const ctx = vm.createContext(sandbox);
      const script = new vm.Script(txt + '\n; (function(){ return typeof arrTeam!=="undefined"?arrTeam:null })();');
      const arr = script.runInContext(ctx, { timeout: 2000 });
      if (!Array.isArray(arr)) continue;
      for (const t of arr) {
        if (!Array.isArray(t)) continue;
        const id = String(t[0]);
        if (!id) continue;
        if (!teams.has(id)) {
          teams.set(id, {
            id,
            name_cn: t[1] || '',
            name_cn_traditional: t[2] || '',
            name_en: t[3] || '',
            image: t[5] || '',
            extra: t.slice(6)
          });
        }
      }
    } catch (e) {
      // ignore parse errors
    }
  }
  return Array.from(teams.values());
}
if (require.main === module) {
  (async ()=>{
    const teams = await collectTeams();
    const outDir = path.resolve(__dirname, '../data');
    await fs.mkdir(outDir, { recursive: true });
    const outPath = path.join(outDir, 'teams.json');
    await fs.writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: teams.length, teams }, null, 2), 'utf8');
    console.log('saved', outPath, 'count=', teams.length);
    console.log(teams.slice(0,10));
  })();
}

module.exports = { collectTeams };
