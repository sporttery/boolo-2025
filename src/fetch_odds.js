const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');

const DATA_DIR = path.resolve(__dirname, '../data');
const INDEX_FILE = path.join(DATA_DIR, 'index.json');
const ODDS_DIR = path.join(DATA_DIR, 'odds');
const ODDS_RAW = path.join(ODDS_DIR, 'raw');
const ODDS_JSON = path.join(ODDS_DIR, 'json');

async function ensure(dir) {
  try { await fs.mkdir(dir, { recursive: true }); } catch (e) {}
}

function pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
];

async function delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

async function fetchWithRetry(url, opts = {}){
  const max = opts.retries ?? 3; const timeoutMs = opts.timeoutMs ?? 8000;
  for (let i=0;i<max;i++){
    try{
      const headers = Object.assign({ 'User-Agent': pick(USER_AGENTS), 'Accept':'*/*', 'Referer': opts.referer || 'https://zq.titan007.com' }, opts.headers||{});
      const controller = new AbortController();
      const timer = setTimeout(()=>controller.abort(), timeoutMs + i*1000);
      const res = await fetch(url, { signal: controller.signal, headers, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP '+res.status);
      const txt = await res.text();
      await delay(200 + Math.floor(Math.random()*400));
      return txt;
    }catch(e){
      await delay(200*(i+1));
    }
  }
  return null;
}

function extractOdds(jsText){
  try{
    const sandbox = {};
    const ctx = vm.createContext(sandbox);
    // wrap so oddsData variable can be returned if present
    const wrapped = jsText + '\n; (function(){ try{ return typeof oddsData !== "undefined" ? oddsData : null; }catch(e){return null;} })();';
    const script = new vm.Script(wrapped);
    const result = script.runInContext(ctx, { timeout: 2000 });
    return result || null;
  }catch(e){ return null; }
}

async function collectMatchesFromParsed(parsed) {
  // parsed may contain jh or jh-like keys. We look for keys that contain 'R_' or arrays with match lists.
  const matches = [];
  if (!parsed) return matches;
  // look for jh
  if (parsed.jh && typeof parsed.jh === 'object'){
    for (const k of Object.keys(parsed.jh)){
      const arr = parsed.jh[k];
      if (Array.isArray(arr)){
        for (const item of arr){
          if (Array.isArray(item) && item.length>0){
            const matchId = item[0];
            const round = item[8] ?? item[2] ?? -1;
            matches.push({ matchId, round });
          }
        }
      }
    }
  }
  // fallback: look for jh-like variables at top level
  for (const k of Object.keys(parsed)){
    if (k.startsWith('jh') && Array.isArray(parsed[k])){
      for (const item of parsed[k]){
        if (Array.isArray(item) && item.length>0){
          const matchId = item[0];
          const round = item[8] ?? item[2] ?? -1;
          matches.push({ matchId, round });
        }
      }
    }
  }
  return matches;
}

async function main(){
  await ensure(ODDS_RAW); await ensure(ODDS_JSON);
  const idx = JSON.parse(await fs.readFile(INDEX_FILE, 'utf8'));

  for (const entry of idx){
    if (!entry.matchJson && !entry.matchFile) continue;
    const sclassId = entry.id;
    const sub = entry.subSclassId || 0;
    const season = entry.season;
    const type = entry.type;
    var rounds = [];
    if (type == 'CupMatch') rounds = [1];else {
      for(var i=1;i<=50;i++) rounds.push(i);
    }
    for (const round of rounds){  
      const flesh = Math.random();
      const url = `https://zq.titan007.com/League/LeagueOddsAjax?sclassId=${sclassId}&subSclassId=${sub}&matchSeason=${season}&round=${round}&flesh=${flesh}`;

      const rawName = `${sclassId}_${sub}_${season}_${round}_odds.js`;
      const jsonName = `${sclassId}_${sub}_${season}_${round}_odds.json`;
      const rawPath = path.join(ODDS_RAW, rawName);
      const jsonPath = path.join(ODDS_JSON, jsonName);

      // skip if already have json
      try{ await fs.access(jsonPath); console.log('已存在 odds JSON，跳过', jsonName); continue;}catch(e){}

      console.log('获取赔率：', url);
      const js = await fetchWithRetry(url, { referer: entry.matchUrl || undefined });
      if (!js ){ console.warn('赔率请求失败', url); continue; }
      if(js.indexOf("oddsData") ==-1 && js.indexOf(";")!=-1){
         console.warn('赔率请求失败', url , js); break;
      }
      await fs.writeFile(rawPath, js, 'utf8');
      const odds = extractOdds(js);
      if (odds){
        await fs.writeFile(jsonPath, JSON.stringify(odds, null, 2), 'utf8');
        console.log('保存 odds JSON:', jsonName);
      } else {
        console.warn('未能解析 oddsData for', rawName);
      }
      // small delay
      await delay(200 + Math.floor(Math.random()*500));
    }
  }
}

if (require.main === module) main().catch(e=>{ console.error(e); process.exit(1); });
