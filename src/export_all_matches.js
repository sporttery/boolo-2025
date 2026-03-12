const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');

function safeDate(d){ const t = d ? new Date(String(d)) : null; return (t && !isNaN(t)) ? t : null; }
function ptsFromScore(homeS, awayS){ const a = parseInt(homeS,10); const b = parseInt(awayS,10); if (isNaN(a) || isNaN(b)) return [null,null]; if (a>b) return [3,0]; if (a===b) return [1,1]; return [0,3]; }

async function loadTeams(){
  const p = path.resolve(__dirname, '../data/teams.json');
  try{ const txt = await fs.readFile(p,'utf8'); const j = JSON.parse(txt); const map = new Map(); if (Array.isArray(j.teams)) for (const t of j.teams) map.set(String(t.id), t); return map; }catch(e){ return new Map(); }
}

async function loadOddsIndex(){
  const idx = new Map();
  // scan both data/raw and data/odds/raw for odds files
  const candidates = [];
//   const d1 = path.resolve(__dirname, '../data/raw');
  const d = path.resolve(__dirname, '../data/odds/raw');
    try{
        const fslist = await fs.readdir(d).catch(()=>[]);
        for (const f of fslist) if (/_odds\.js$/.test(f)) candidates.push(path.join(d,f));
    }catch(e){ console.error(e); return null }
  

  for (const filepath of candidates){
    try{
      const txt = await fs.readFile(filepath,'utf8');
      const sandbox = { oddsData: null };
      const ctx = vm.createContext(sandbox);
      try{ new vm.Script("var oddsData={};"+txt).runInContext(ctx, { timeout: 2000 }); }catch(e){ /* run best-effort */ }
      const oddsData = ctx.oddsData || (typeof ctx.oddsData === 'undefined' ? null : ctx.oddsData);
      if (!oddsData || typeof oddsData !== 'object') continue;
      for (const [k,v] of Object.entries(oddsData)){
        if (!k || k.length<3) continue;
        // key like 'O_2325222' or 'L_2325222' or 'T_2325222'
        const m = k.match(/^([OTL])_(.+)$/);
        if (!m) continue;
        const prefix = m[1];
        const matchId = String(m[2]);
        if (!idx.has(matchId)) idx.set(matchId, {});
        const obj = idx.get(matchId);
        if (prefix === 'O') obj.bet_1x2_init = v;
        if (prefix === 'T') obj.bet_ou_init = v;
        if (prefix === 'L') obj.bet_asian_init = v;
      }
    }catch(e){ /* ignore malformed odds file */ }
  }
  return idx;
}

async function collectAllMatches(){
  const RAW = path.resolve(__dirname, '../data/raw');
  const files = await fs.readdir(RAW).catch(()=>[]);
  const matches = [];
  for (const f of files){
    if (!/_match\.js$/.test(f)) continue;
    try{
      const txt = await fs.readFile(path.join(RAW,f),'utf8');
        const sandbox = { arrLeague: null, arrTeam: null, jh: {}, arrCupKind: null, arrCup: null };
        const ctx = vm.createContext(sandbox);
        try{
          new vm.Script(txt).runInContext(ctx, { timeout: 2000 });
        }catch(e){ /* ignore runtime errors */ }
        const parsed = {
          arrLeague: typeof ctx.arrLeague !== 'undefined' ? ctx.arrLeague : null,
          arrCup: typeof ctx.arrCup !== 'undefined' ? ctx.arrCup : null,
          arrCupKind: typeof ctx.arrCupKind !== 'undefined' ? ctx.arrCupKind : null,
          arrTeam: typeof ctx.arrTeam !== 'undefined' ? ctx.arrTeam : null,
          jh: typeof ctx.jh !== 'undefined' ? ctx.jh : null
        };
        const league = parsed.arrLeague || null;
      if(!league) continue;
      const cup = parsed.arrCup || null;
      if(cup) continue; // skip cup matches for now
      const leagueName = league && league[1] ? String(league[1]) : cup && cup[4] ? String(cup[4]) : '';
      const leagueColor = league && league[5] ? String(league[5]) :  cup && cup[9] ? String(cup[9]) : '';
      const season = league && league[4] ? String(league[4]) :  cup && cup[7] ? String(cup[7]) : '';
      const arrCupKind = parsed.arrCupKind || null;
      if (parsed.jh && typeof parsed.jh === 'object'){
        for (const key of Object.keys(parsed.jh)){
          const arr = parsed.jh[key];
          if (!Array.isArray(arr)) continue;
          for (const item of arr){
            if (!Array.isArray(item)) continue;
            // jh format per README:
            // [matchId, leagueId, status, playtime, homeId, awayId, fullscore, halfscore, round, ...]
            const matchId = item[0] ?? null;
            const leagueId = item[1] ?? null;
            const status = item[2] ?? null;
            const playtime = item[3] ?? '';
            const homeId = item[4] ?? '';
            const awayId = item[5] ?? '';
            const fullscore = item[6] ?? '';
            const halfscore = item[7] ?? '';
            const homeName = item[8] ?? '';
            const awayName = item[9] ?? '';
            if(isNaN(matchId)||isNaN(homeId) || isNaN(awayId) || isNaN(leagueId)) continue; // skip invalid IDs

            const round = key;
            const match = {
              matchId: matchId != null ? String(matchId) : '',
              leagueId: leagueId != null ? String(leagueId) : '',
              status,
              leagueName, season, round, playtime, homeId: String(homeId),
               awayId: String(awayId), 
               fullscore: String(fullscore), 
               halfscore: String(halfscore),
              homeName,awayName,leagueColor,
              raw: item
            };
            matches.push(match);
          }
        }
      }
    }catch(e){ /* ignore file parse errors */ }
  }
  return matches;
}

async function computeAndWrite(){
  const teamsMap = await loadTeams();
  let matches = await collectAllMatches();
  // dedupe by matchId (prefer first seen) and normalize dates and sort ascending
  const seen = new Map();
  const deduped = [];
  for (const m of matches){
    const id = m.matchId || (m.raw && m.raw[0] ? String(m.raw[0]) : null);
    if (id){ if (seen.has(id)) continue; seen.set(id, true); deduped.push(m); } else { deduped.push(m); }
  }
  matches = deduped;
  for (const m of matches){ m._date = safeDate(m.playtime); }
  matches.sort((a,b)=>{ const da=a._date?+a._date:0; const db=b._date?+b._date:0; return da - db; });

  // load odds index and attach to matches by matchId when available
  const oddsIndex = await loadOddsIndex().catch(()=>new Map());
  for (const m of matches){
    const id = m.matchId || (m.raw && m.raw[0] ? String(m.raw[0]) : null);
    if (id && oddsIndex.has(String(id))){
      const o = oddsIndex.get(String(id)) || {};
      m.bet_asian_init = o.bet_asian_init || '';
      m.bet_ou_init = o.bet_ou_init || '';
      m.bet_1x2_init = o.bet_1x2_init || '';
    } else {
      m.bet_asian_init = '';
      m.bet_ou_init = '';
      m.bet_1x2_init = '';
    }
  }

  // build per-team history list (only matches with fullscore)
  const history = new Map();
  for (const m of matches){
    const fscr = String(m.fullscore||'').trim();
    if (!fscr || fscr.indexOf('-')<0) continue;
    const [hs,as] = fscr.split('-').map(s=>s.replace(/[^0-9]/g,''));
    const pts = ptsFromScore(hs, as);
    const recHome = { date: m._date, opponent: m.awayId, home: true, score: fscr, pts: pts[0] };
    const recAway = { date: m._date, opponent: m.homeId, home: false, score: fscr, pts: pts[1] };
    if (!history.has(String(m.homeId))) history.set(String(m.homeId), []);
    if (!history.has(String(m.awayId))) history.set(String(m.awayId), []);
    history.get(String(m.homeId)).push(recHome);
    history.get(String(m.awayId)).push(recAway);
  }

  const outCsv = [];
  const header = ['联赛','赛季','轮次','比赛时间','主队','完场比分','客队','半场比分','bet365亚盘初盘','bet365大小球初盘','bet365胜平负初盘','主队近30场比赛积分','客队近30场比赛积分','主队近3场比赛积分','客队近3场比赛积分','主客队近3场强弱'];
  outCsv.push(header.join(','));

  for (const m of matches){
    const homeName = (teamsMap.get(String(m.homeId)) || {}).name_cn || '';
    const awayName = (teamsMap.get(String(m.awayId)) || {}).name_cn || '';
    // compute recent points
    function sumRecent(teamId, n){
      const list = history.get(String(teamId)) || [];
      // only consider matches before current match date
      const prev = list.filter(x=>x.date && m._date && +x.date < +m._date).sort((a,b)=>+b.date - +a.date);
      const slice = prev.slice(0,n);
      const s = slice.reduce((acc,it)=>acc + (typeof it.pts==='number'?it.pts:0), 0);
      return s;
    }
    const home30 = sumRecent(m.homeId, 30);
    const away30 = sumRecent(m.awayId, 30);
    const home3 = sumRecent(m.homeId, 3);
    const away3 = sumRecent(m.awayId, 3);
    const strength3 = (home3 || 0) - (away3 || 0);

    const row = [
      JSON.stringify(m.leagueName || ''),
      JSON.stringify(m.season || ''),
      JSON.stringify(m.round || ''),
      JSON.stringify(m.playtime || ''),
      JSON.stringify(homeName || String(m.homeId)),
      JSON.stringify(m.fullscore || ''),
      JSON.stringify(awayName || String(m.awayId)),
      JSON.stringify(m.halfscore || ''),
      JSON.stringify(m.bet_asian_init || ''),
      JSON.stringify(m.bet_ou_init || ''),
      JSON.stringify(m.bet_1x2_init || ''),
      JSON.stringify(home30 != null ? home30 : ''),
      JSON.stringify(away30 != null ? away30 : ''),
      JSON.stringify(home3 != null ? home3 : ''),
      JSON.stringify(away3 != null ? away3 : ''),
      JSON.stringify(strength3)
    ];
    outCsv.push(row.join(','));
  }

  const outDir = path.resolve(__dirname, '../data');
  await fs.mkdir(outDir,{recursive:true});
  const csvPath = path.join(outDir, 'all_matches.csv');
  await fs.writeFile(csvPath, outCsv.join('\n'), 'utf8');
  const jsonPath = path.join(outDir, 'all_matches.json');
  await fs.writeFile(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), count: matches.length }, null, 2), 'utf8');
  console.log('wrote', csvPath, 'rows=', outCsv.length-1);
}

if (require.main === module){
  computeAndWrite().catch(e=>{ console.error(e); process.exit(1); });
}

module.exports = { collectAllMatches };
