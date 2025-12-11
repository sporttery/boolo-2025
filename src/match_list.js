const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');

class MatchLister {
  constructor(opts = {}) {
    this.retries = opts.retries ?? 3;
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.userAgents = opts.userAgents || [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
    ];
  }

  pick(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

  async delay(ms){ return new Promise(r=>setTimeout(r, ms)); }

  async fetchWithRetry(url, referer) {
    for (let attempt = 0; attempt < this.retries; attempt++) {
      try {
        const headers = { 'User-Agent': this.pick(this.userAgents), 'Accept': '*/*' };
        if (referer) headers.Referer = referer;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs + attempt * 1000);
        const res = await fetch(url, { signal: controller.signal, headers, cache: 'no-store' });
        clearTimeout(timer);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const txt = await res.text();
        await this.delay(200 + Math.floor(Math.random()*300));
        return txt;
      } catch (e) {
        await this.delay(200 * (attempt + 1));
      }
    }
    return null;
  }

  async getSubSclassId(season, leagueId, referer) {
    // try to fetch SubLeague page to extract SubSclassID
    try {
      const url = `https://zq.titan007.com/cn/SubLeague/${season}/${leagueId}.html`;
      const html = await this.fetchWithRetry(url, referer);
      if (!html) return null;
      const m = html.match(/var\s+SubSclassID\s*=\s*([0-9]+)\s*;/i);
      if (m) return Number(m[1]);
    } catch (e) {
      // ignore
    }
    return null;
  }

  extractVars(jsText) {
    try {
      // prepare a sandbox with common globals to avoid ReferenceError
      // some remote JS assigns to `jh[...]` without declaring `jh` first
      // so pre-create `jh` as an object so assignments succeed in the VM
      const sandbox = { arrLeague: null, jh: {}, totalScore: null };
      const ctx = vm.createContext(sandbox);
      const wrapped = jsText + '\n; (function(){ try{ return { arrLeague: typeof arrLeague!=="undefined"?arrLeague:null, jh: typeof jh!=="undefined"?jh:null, totalScore: typeof totalScore!=="undefined"?totalScore:null }; }catch(e){return null;} })();';
      const script = new vm.Script(wrapped);
      const res = script.runInContext(ctx, { timeout: 2000 });
      return res || { arrLeague: null, jh: null, totalScore: null };
    } catch (e) {
      return { arrLeague: null, jh: null, totalScore: null };
    }
  }

  normalizeMatchArray(item) {
    // common mapping based on examples in README
    const matchId = item[0];
    const date = item[3] || null;
    const homeId = item[4] || null;
    const guestId = item[5] || null;
    const score = item[6] || null;
    const halfScore = item[7] || null;
    let round = null;
    if (typeof item[8] === 'number' || (!isNaN(Number(item[8])) && item[8] !== '')) round = Number(item[8]);
    return { matchId, date, homeId, guestId, score, halfScore, round, raw: item };
  }

  async fetchMatchScript(season, leagueId, type = 'League', trySub = true, referer) {
    const prefix = type === 'CupMatch' ? 'c' : 's';
    // try local file first: data/raw/{leagueId}_{season}_{prefix}{leagueId}[_sub]_match.js
    const RAW_DIR = require('path').resolve(__dirname, '../data/raw');
    try {
      const files = await fs.readdir(RAW_DIR);
      // escape season for regex
      const escSeason = String(season).replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
      const re = new RegExp('^' + leagueId + '_' + escSeason + '_' + prefix + leagueId + '(?:_(\\d+))?_match\\.js$');
      let chosen = null;
      let chosenSub = null;
      for (const f of files) {
        const m = re.exec(f);
        if (m) {
          const subId = m[1] || null;
          // prefer file that contains a sub id if multiple exist
          if (!chosen || (chosenSub === null && subId !== null)) {
            chosen = f;
            chosenSub = subId;
          }
        }
      }
      if (chosen) {
        const filePath = require('path').join(RAW_DIR, chosen);
        const txt = await fs.readFile(filePath, 'utf8');
        return { text: txt, url: `file://${filePath}`, sub: chosenSub ? Number(chosenSub) : null };
      }
    } catch (e) {
      // ignore local read errors and fall back to network
    }

    // local not found -> fetch from network (and attempt to use subSclassId)
    let sub = null;
    if (trySub && prefix === 's') {
      sub = await this.getSubSclassId(season, leagueId, referer).catch(()=>null);
    }
    const url = sub ? `https://zq.titan007.com/jsData/matchResult/${season}/s${leagueId}_${sub}.js` : `https://zq.titan007.com/jsData/matchResult/${season}/${prefix}${leagueId}.js`;
    const text = await this.fetchWithRetry(url, referer);
    return { text, url, sub };
  }

  async getMatches(leagueId, season, opts = {}) {
    const type = opts.type || 'League';
    const referer = opts.referer;
    const { text, url, sub } = await this.fetchMatchScript(season, leagueId, type, true, referer);
    if (!text) return { matches: [], url, sub };
    const parsed = this.extractVars(text);
    const matches = [];

    // jh is often an object with keys like "R_1" -> arrays of matches
    if (parsed.jh && typeof parsed.jh === 'object') {
      for (const key of Object.keys(parsed.jh)) {
        const arr = parsed.jh[key];
        if (Array.isArray(arr)) {
          for (const item of arr) {
            if (Array.isArray(item)) {
              matches.push(this.normalizeMatchArray(item));
            }
          }
        }
      }
    }

    // fallback: some files expose jh as jh['R_1'] in very nested ways; try to detect arrays in top-level
    if (matches.length === 0) {
      for (const k of Object.keys(parsed)) {
        if (Array.isArray(parsed[k])) {
          for (const item of parsed[k]) {
            if (Array.isArray(item) && item.length > 0 && typeof item[0] === 'number') {
              matches.push(this.normalizeMatchArray(item));
            }
          }
        }
      }
    }

    return { matches, url, sub, rawText: text, parsed };
  }
}

module.exports = MatchLister;

if (require.main === module) {
  // CLI: node src/match_list.js <leagueId> <season> [type]
  (async ()=>{
    var args = process.argv.slice(2);
    const l = new MatchLister();
    // No args: iterate config/league.json and process all leagues+seasons
    if (args.length < 2) {
      const cfgPath = path.resolve(__dirname, '../config/league.json');
      let cfgText = null;
      try {
        cfgText = await fs.readFile(cfgPath, 'utf8');
      } catch (e) {
        console.error('无法读取 config/league.json:', e.message);
        console.log('Usage: node src/match_list.js <leagueId> <season> [type]');
        return;
      }
      // try to parse; if malformed, attempt a small fixup for ID numeric quotes
      let cfg = null;
      try {
        cfg = JSON.parse(cfgText);
      } catch (e) {
        // common malformed case: "ID":36"  -> make it a string
        const fixed = cfgText.replace(/"ID"\s*:\s*([0-9]+)"/g, '"ID":"$1"');
        try { cfg = JSON.parse(fixed); } catch (e2) { }
        if (!cfg) {
          // fallback: try extract first JSON array substring
          const m = cfgText.match(/\[([\s\S]*)\]/);
          if (m) {
            try { cfg = JSON.parse('[' + m[1] + ']'); } catch (e3) { cfg = null; }
          }
        }
      }
      if (!Array.isArray(cfg)) {
        console.error('config/league.json 解析失败，无法遍历。');
        return;
      }

      for (const entry of cfg) {
        const leagueId = String(entry.ID || entry.Id || entry.id || entry['SclassID'] || entry['ID'] || '').trim();
        const type = entry['赛事类型'] || entry['type'] || 'League';
        const seasons = entry['赛季列表'] || entry['seasons'] || [];
        if (!leagueId) continue;
        for (const season of seasons) {
          try {
            const res = await l.getMatches(leagueId, season, { type });
            console.log(JSON.stringify({ leagueId, season, type, url: res.url, sub: res.sub, count: res.matches.length }));
          } catch (e) {
            console.error('Error processing', leagueId, season, e.message);
          }
        }
      }
      return;
    }

    const [leagueId, season, type] = args;
    const res = await l.getMatches(leagueId, season, { type: type || 'League' });
    console.log(JSON.stringify({ url: res.url, sub: res.sub, count: res.matches.length }, null, 2));
    // print first 10 matches
    console.log(res.matches.slice(0,10));
  })();
}
