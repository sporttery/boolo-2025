const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');
const MatchLister = require('./match_list');

class RecentMatches {
  constructor(opts = {}){
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.userAgents = opts.userAgents || [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
    ];
  }

  pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
  async delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async fetchWithRetry(url, referer){
    for (let i=0;i<this.retries;i++){
      try{
        const headers = { 'User-Agent': this.pick(this.userAgents), Accept: '*/*' };
        if (referer) headers.Referer = referer;
        const controller = new AbortController();
        const timer = setTimeout(()=>controller.abort(), this.timeoutMs + i*1000);
        const res = await fetch(url, { signal: controller.signal, headers, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP '+res.status);
        const txt = await res.text();
        await this.delay(200 + Math.floor(Math.random()*300));
        return txt;
      }catch(e){
        await this.delay(200*(i+1));
      }
    }
    return null;
  }

  parsePanluHtml(html){
    // extract <script> blocks and execute them in a sandbox where `a` is pre-created
    try{
      const scripts = [];
      const re = /<script[^>]*>([\s\S]*?)<\/script>/gi;
      let m;
      while((m = re.exec(html))){
        scripts.push(m[1]);
      }
      // if no script tags, try to use whole text
      const code = scripts.length ? scripts.join('\n') : html;
      const sandbox = { a: [] };
      const ctx = vm.createContext(sandbox);
      // run only assignment lines to reduce risk: keep lines that start with a[ or var a
      const lines = code.split(/\r?\n/).filter(l=>/^(?:\s*(?:a\[|var\s+a\b|a\s*=))/i.test(l) || /a\[\d+\]/.test(l));
      const toRun = lines.join('\n') + '\n; (function(){ try{ return typeof a!=="undefined"?a:null }catch(e){return null;} })();';
      const script = new vm.Script(toRun);
      const res = script.runInContext(ctx, { timeout: 2000 });
      return res || null;
    }catch(e){
      return null;
    }
  }

  async getRecentByMatchId(matchId){
    if (!matchId) return null;
    const url = `https://bf.titan007.com/panlu/${matchId}cn.htm`;
    const html = await this.fetchWithRetry(url).catch(()=>null);
    if (!html) return null;
    const arr = this.parsePanluHtml(html);
    if (!Array.isArray(arr)) return null;
    // map to objects with some common fields
    const mapped = arr.map(item=>{
      if (!Array.isArray(item)) return null;
      return {
        id: item[0] ?? null,
        league: item[1] ?? null,
        color: item[2] ?? null,
        date: item[3] ?? null,
        home: item[4] ?? null,
        guest: item[5] ?? null,
        homeId: item[6] ?? null,
        guestId: item[7] ?? null,
        raw: item
      };
    }).filter(Boolean);
    return mapped.slice(0, 30);
  }

  async collectMatchIdsFromRaw(){
    // scan data/raw/*_match.js and extract match ids from jh[...] arrays
    const RAW = path.resolve(__dirname, '../data/raw');
    const ids = new Set();
    let files = [];
    try{ files = await fs.readdir(RAW); }catch(e){ return Array.from(ids); }
    for (const f of files){
      if (!/_match\.js$/.test(f)) continue;
      try{
        const txt = await fs.readFile(path.join(RAW, f), 'utf8');
        // reuse a small vm approach: pre-create jh and run assignment lines
        const sandbox = { jh: {} };
        const ctx = vm.createContext(sandbox);
        const script = new vm.Script(txt + '\n; (function(){ return typeof jh!=="undefined"?jh:null })();');
        const parsed = script.runInContext(ctx, { timeout: 2000 });
        if (parsed && typeof parsed === 'object'){
          for (const k of Object.keys(parsed)){
            const arr = parsed[k];
            if (!Array.isArray(arr)) continue;
            for (const item of arr){
              if (Array.isArray(item) && typeof item[0] === 'number') ids.add(String(item[0]));
            }
          }
        }
      }catch(e){ /* ignore */ }
    }
    return Array.from(ids);
  }

  async getAllRecentAndSave(opts = {}){
    const outDir = path.resolve(__dirname, '../data/recent');
    await fs.mkdir(outDir, { recursive: true });
    const ids = await this.collectMatchIdsFromRaw();
    for (const id of ids){
      try{
        const recent = await this.getRecentByMatchId(id);
        if (!recent) continue;
        const outPath = path.join(outDir, `${id}.json`);
        await fs.writeFile(outPath, JSON.stringify({ matchId: id, fetchedAt: new Date().toISOString(), recent }, null, 2), 'utf8');
        console.log('saved', outPath, 'count=' + recent.length);
      }catch(e){ console.error('err', id, e.message); }
    }
    return true;
  }

  async collectMatchIdsFromLeague(leagueId, season, maxMatches = 50){
    // use MatchLister to get matches (prefers local raw files)
    const l = new MatchLister();
    const res = await l.getMatches(String(leagueId), String(season), { type: 'League' });
    const ids = [];
    if (res && Array.isArray(res.matches)){
      for (const m of res.matches){
        if (m && m.matchId) ids.push(String(m.matchId));
        if (ids.length >= maxMatches) break;
      }
    }
    return ids;
  }

  async collectMatchIdsFromIndex(maxPerLeague = 10){
    // read data/index.json and call MatchLister for each entry
    const INDEX = path.resolve(__dirname, '../data/index.json');
    let idx = [];
    try{ const txt = await fs.readFile(INDEX, 'utf8'); idx = JSON.parse(txt); }catch(e){ return []; }
    const ids = new Set();
    for (const entry of idx){
      try{
        const leagueId = entry.id;
        const season = entry.season;
        const list = await this.collectMatchIdsFromLeague(leagueId, season, maxPerLeague);
        for (const id of list) ids.add(id);
      }catch(e){ /* ignore per-entry errors */ }
    }
    return Array.from(ids);
  }
}

module.exports = RecentMatches;

if (require.main === module){
  (async ()=>{
    const args = process.argv.slice(2);
    const r = new RecentMatches();
    if (args.length >= 2 && /^\d+$/.test(args[0])){
      // treat as leagueId season [max]
      const leagueId = args[0];
      const season = args[1];
      const max = args[2] ? Number(args[2]) : 10;
      console.log('Collecting matches for', leagueId, season, 'max=', max);
      const ids = await r.collectMatchIdsFromLeague(leagueId, season, max);
      console.log('match ids found:', ids.length);
      for (const id of ids){
        const recent = await r.getRecentByMatchId(id);
        const outDir = path.resolve(__dirname, '../data/recent');
        await fs.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `${id}.json`);
        await fs.writeFile(outPath, JSON.stringify({ matchId: id, fetchedAt: new Date().toISOString(), recent }, null, 2), 'utf8');
        console.log('saved', outPath, 'count=' + (recent?recent.length:0));
      }
      return;
    }

    if (args.length >= 1 && args[0] === 'all'){
      const maxPerLeague = args[1] ? Number(args[1]) : 5;
      console.log('Scanning index.json and collecting up to', maxPerLeague, 'matches per league entry');
      const ids = await r.collectMatchIdsFromIndex(maxPerLeague);
      console.log('total unique match ids:', ids.length);
      for (const id of ids){
        const recent = await r.getRecentByMatchId(id);
        const outDir = path.resolve(__dirname, '../data/recent');
        await fs.mkdir(outDir, { recursive: true });
        const outPath = path.join(outDir, `${id}.json`);
        await fs.writeFile(outPath, JSON.stringify({ matchId: id, fetchedAt: new Date().toISOString(), recent }, null, 2), 'utf8');
        console.log('saved', outPath, 'count=' + (recent?recent.length:0));
      }
      return;
    }

    if (args.length === 1){
      const matchId = args[0];
      const res = await r.getRecentByMatchId(matchId);
      if (!res) { console.error('no data for', matchId); process.exit(1); }
      console.log(JSON.stringify({ matchId, count: res.length }, null, 2));
      console.log(res.slice(0,30));
      // save to data/recent
      const outDir = path.resolve(__dirname, '../data/recent');
      await fs.mkdir(outDir, { recursive: true });
      const outPath = path.join(outDir, `${matchId}.json`);
      await fs.writeFile(outPath, JSON.stringify({ matchId, fetchedAt: new Date().toISOString(), recent: res }, null, 2), 'utf8');
      console.log('saved', outPath);
      return;
    }

    console.log('No args: defaulting to scanning local match files (existing behavior)');
    await r.getAllRecentAndSave();
  })();
}
