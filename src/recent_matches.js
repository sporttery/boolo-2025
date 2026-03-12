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

  async fetchTeamPage(teamId, pageNo = 1){
    const flesh = Math.random();
    const url = `https://zq.titan007.com/cn/team/TeamScheAjax.aspx?TeamID=${teamId}&pageNo=${pageNo}&flesh=${flesh}`;
    const txt = await this.fetchWithRetry(url, `https://zq.titan007.com/cn/team/${teamId}.html`).catch(()=>null);
    if (!txt) return null;
    try{
      // extract teamPageInfo and teamPageData via vm
      const sandbox = { teamPageInfo: null, teamPageData: null };
      const ctx = vm.createContext(sandbox);
      const wrapped = txt + '\n; (function(){ try{ return { teamPageInfo: typeof teamPageInfo!=="undefined"?teamPageInfo:null, teamPageData: typeof teamPageData!=="undefined"?teamPageData:null }; }catch(e){return null;} })();';
      const script = new vm.Script(wrapped);
      const res = script.runInContext(ctx, { timeout: 2000 });
      return res;
    }catch(e){
      // fallback: try regex to extract arrays
      const infoMatch = txt.match(/var\s+teamPageInfo\s*=\s*(\[[\s\S]*?\]);/);
      const dataMatch = txt.match(/var\s+teamPageData\s*=\s*(\[[\s\S]*?\]);/);
      try{
        const teamPageInfo = infoMatch ? eval(infoMatch[1]) : null;
        const teamPageData = dataMatch ? eval(dataMatch[1]) : null;
        return { teamPageInfo, teamPageData };
      }catch(e2){ return null; }
    }
  }

  async fetchTeamMatches(teamId, maxPages = 50, stopOnResults = 30){
    const outDir = path.resolve(__dirname, '../data/team_matches/remote');
    await fs.mkdir(outDir, { recursive: true });
    let page = 1; let totalPages = Infinity; let resultsCount = 0; const allMatches = [];
    while(page <= totalPages && page <= maxPages){
      const res = await this.fetchTeamPage(teamId, page);
      if (!res) break;
      const info = res.teamPageInfo || null;
      const data = res.teamPageData || [];
      if (Array.isArray(info) && typeof info[0] === 'number') totalPages = Number(info[0]);
      const items = [];
      for (const d of data){
        // map as README
        const playtime = d[3];
        const match = {
          id: d[0], leagueId: d[1], leagueColor: d[2], playtime,
          leagueName: d[8], homeName: d[11], homeId: d[4], awayName: d[14], awayId: d[5], fullscore: d[6], halfscore: d[7], result: d[23], raw: d
        };
        items.push(match);
        if (match.fullscore && String(match.fullscore).trim() !== '') resultsCount++;
      }
      const outPath = path.join(outDir, `${teamId}_page_${page}.json`);
      await fs.writeFile(outPath, JSON.stringify({ teamId, page, totalPages: isFinite(totalPages)?totalPages:null, items }, null, 2), 'utf8');
      allMatches.push(...items);
      if (resultsCount >= stopOnResults) break;
      page++;
    }
    return { teamId, fetchedPages: page-1, totalMatches: allMatches.length, resultsCount };
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

  async collectTeamIdsFromRaw(){
    // Prefer using existing teams.json if present
    const teamsPath = path.resolve(__dirname, '../data/teams.json');
    try{
      const txt = await fs.readFile(teamsPath, 'utf8');
      const j = JSON.parse(txt);
      if (j && Array.isArray(j.teams) && j.teams.length){
        return j.teams.map(t=>String(t.id));
      }
    }catch(e){ /* not present or invalid, fallback below */ }

    // If teams.json missing, try to invoke export_teams.collectTeams()
    try{
      const exporter = require('./export_teams');
      if (exporter && typeof exporter.collectTeams === 'function'){
        const teams = await exporter.collectTeams();
        if (Array.isArray(teams) && teams.length){
          // persist teams.json for future runs
          try{
            const outDir = path.resolve(__dirname, '../data');
            await fs.mkdir(outDir, { recursive: true });
            const outPath = path.join(outDir, 'teams.json');
            await fs.writeFile(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: teams.length, teams }, null, 2), 'utf8');
          }catch(e){}
          return teams.map(t=>String(t.id));
        }
      }
    }catch(e){ /* ignore */ }

    // Fallback: scan raw files for arrTeam / jh entries
    const RAW = path.resolve(__dirname, '../data/raw');
    const ids = new Set();
    let files = [];
    try{ files = await fs.readdir(RAW); }catch(e){ return Array.from(ids); }
    for (const f of files){
      if (!/\.js$/.test(f)) continue;
      try{
        const txt = await fs.readFile(path.join(RAW, f), 'utf8');
        // try to extract arrTeam if present
        if (/var\s+arrTeam\s*=/.test(txt)){
          try{
            const sandbox = { arrTeam: null, jh: {} };
            const ctx = vm.createContext(sandbox);
            const script = new vm.Script(txt + '\n; (function(){ return typeof arrTeam!=="undefined"?arrTeam:null })();');
            const arr = script.runInContext(ctx, { timeout: 2000 });
            if (Array.isArray(arr)){
              for (const t of arr){ if (Array.isArray(t) && t[0]) ids.add(String(t[0])); }
            }
          }catch(e){}
        }
        // also scan jh arrays for team ids
        try{
          const sandbox2 = { jh: {} };
          const ctx2 = vm.createContext(sandbox2);
          const script2 = new vm.Script(txt + '\n; (function(){ return typeof jh!=="undefined"?jh:null })();');
          const parsed = script2.runInContext(ctx2, { timeout: 2000 });
          if (parsed && typeof parsed === 'object'){
            for (const k of Object.keys(parsed)){
              const arr = parsed[k];
              if (!Array.isArray(arr)) continue;
              for (const item of arr){
                if (Array.isArray(item)){
                  const h = item[4]; const g = item[5];
                  if (h) ids.add(String(h)); if (g) ids.add(String(g));
                }
              }
            }
          }
        }catch(e){}
      }catch(e){ }
    }
    return Array.from(ids);
  }

  async buildTeamMatches(teamId, pageSize = 20, stopOnResults = 30){
    const RAW = path.resolve(__dirname, '../data/raw');
    const outDir = path.resolve(__dirname, '../data/team_matches');
    await fs.mkdir(outDir, { recursive: true });
    const matches = [];
    let files = [];
    try{ files = await fs.readdir(RAW); }catch(e){ return 0; }
    for (const f of files){
      if (!/_match\.js$/.test(f)) continue;
      try{
        const txt = await fs.readFile(path.join(RAW, f), 'utf8');
        const sandbox = { jh: {} };
        const ctx = vm.createContext(sandbox);
        const script = new vm.Script(txt + '\n; (function(){ return typeof jh!=="undefined"?jh:null })();');
        const parsed = script.runInContext(ctx, { timeout: 2000 });
        if (parsed && typeof parsed === 'object'){
          for (const k of Object.keys(parsed)){
            const arr = parsed[k];
            if (!Array.isArray(arr)) continue;
            for (const item of arr){
              if (!Array.isArray(item)) continue;
              const home = item[4]; const guest = item[5];
              if (String(home) === String(teamId) || String(guest) === String(teamId)){
                // map
                matches.push({
                  matchId: item[0], date: item[3], homeId: home, guestId: guest, score: item[6], raw: item
                });
              }
            }
          }
        }
      }catch(e){ }
    }
    // sort by date desc
    matches.sort((a,b)=>{ const da = new Date(a.date||0); const db = new Date(b.date||0); return db - da; });
    // paginate and persist
    let resultsCount = 0;
    const pages = Math.ceil(matches.length / pageSize) || 0;
    for (let p=0;p<pages;p++){
      const slice = matches.slice(p*pageSize, (p+1)*pageSize);
      for (const m of slice){ if (m.score && String(m.score).trim() !== '') resultsCount++; }
      const outPath = path.join(outDir, `${teamId}_page_${p+1}.json`);
      await fs.writeFile(outPath, JSON.stringify({ teamId, page: p+1, pageSize, items: slice, resultsCount }, null, 2), 'utf8');
      if (resultsCount >= stopOnResults) break;
    }
    return { teamId, pages: Math.ceil(matches.length/pageSize), totalMatches: matches.length, resultsCount };
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
    if (args.length >= 1 && args[0] === 'teams'){
      const pageSize = args[1] ? Number(args[1]) : 20;
      const maxTeams = args[2] ? Number(args[2]) : 0; // 0 => all
      console.log('Collecting team IDs from local raw files...');
      const teamIds = await r.collectTeamIdsFromRaw();
      console.log('found team ids:', teamIds.length);
      const toProcess = maxTeams > 0 ? teamIds.slice(0, maxTeams) : teamIds;
      for (const tid of toProcess){
        try{
          const info = await r.buildTeamMatches(tid, pageSize, 30);
          console.log('team', tid, 'pages', info.pages, 'total', info.totalMatches, 'resultsCount', info.resultsCount);
        }catch(e){ console.error('team error', tid, e.message); }
      }
      return;
    }

    if (args.length >= 2 && args[0] === 'teamfetch'){
      const teamId = args[1];
      const maxPages = args[2] ? Number(args[2]) : 50;
      console.log('fetching team pages remote for', teamId, 'maxPages=', maxPages);
      const info = await r.fetchTeamMatches(teamId, maxPages, 30);
      console.log('done', info);
      return;
    }

    if (args.length >= 1 && args[0] === 'teamfetch-all'){
      const maxPages = args[1] ? Number(args[1]) : 50;
      const batchSize = args[2] ? Number(args[2]) : 5; // concurrent teams per batch
      const maxTeams = args[3] ? Number(args[3]) : 0; // 0 => all
      console.log('teamfetch-all: maxPages=', maxPages, 'batchSize=', batchSize, 'maxTeams=', maxTeams || 'ALL');
      const teamIds = await r.collectTeamIdsFromRaw();
      console.log('total team ids found:', teamIds.length);
      const toProcess = maxTeams > 0 ? teamIds.slice(0, maxTeams) : teamIds;
      const outDirRemote = path.resolve(__dirname, '../data/team_matches/remote');
      await fs.mkdir(outDirRemote, { recursive: true });
      for (let i=0;i<toProcess.length;i+=batchSize){
        const batch = toProcess.slice(i, i+batchSize);
        console.log('processing batch', Math.floor(i/batchSize)+1, 'size', batch.length);
        // process sequentially within batch to avoid too many concurrent network calls
        for (const tid of batch){
          // skip if first page already exists (assume already fetched)
          try{
            const firstPagePath = path.join(outDirRemote, `${tid}_page_1.json`);
            await fs.access(firstPagePath);
            console.log('skip', tid, '-> already has', firstPagePath);
            continue;
          }catch(e){ /* not exists, proceed */ }
          try{
            const info = await r.fetchTeamMatches(tid, maxPages, 30);
            console.log('team', tid, 'fetchedPages', info.fetchedPages, 'matches', info.totalMatches, 'results', info.resultsCount);
          }catch(e){ console.error('teamfetch error', tid, e.message); }
          // small delay between teams
          await r.delay(300 + Math.floor(Math.random()*700));
        }
        // delay between batches
        await r.delay(1500 + Math.floor(Math.random()*2000));
      }
      console.log('teamfetch-all completed');
      return;
    }

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
