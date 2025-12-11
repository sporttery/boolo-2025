const fs = require('fs').promises;
const path = require('path');

const CONFIG_PATH = path.resolve(__dirname, '../config/league.json');
const DATA_DIR = path.resolve(__dirname, '../data');
const RAW_DIR = path.join(DATA_DIR, 'raw');

async function ensureDir(dir) {
  try {
    await fs.mkdir(dir, { recursive: true });
  } catch (e) {
    // ignore
  }
}

async function fileExists(p) {
  try {
    await fs.stat(p);
    return true;
  } catch (e) {
    return false;
  }
}

function stripCodeFences(text) {
  return text.replace(/^```[\s\S]*?\n|\n```$/g, '').trim();
}

function tryFixCommonErrors(text) {
  // Fix a few common issues seen in the repo config: stray code fences, malformed ID like "ID":36"
  let t = text.replace(/\r\n/g, '\n');
  t = t.replace(/`{3}json\n|`{3}$/g, '');
  t = t.replace(/"ID":\s*([0-9]+)"/g, '"ID": "$1"');
  // fix occasional hostname typo
  t = t.replace(/https?:\/\/(?:www\.)?zqitan007\.com/g, 'https://zq.titan007.com');
  return t;
}

async function readConfig() {
  const raw = await fs.readFile(CONFIG_PATH, 'utf8');
  let text = stripCodeFences(raw);
  text = tryFixCommonErrors(text);
  try {
    const cfg = JSON.parse(text);
    return cfg;
  } catch (e) {
    // Save raw for inspection
    await ensureDir(DATA_DIR);
    await fs.writeFile(path.join(DATA_DIR, 'league.json.raw.txt'), raw, 'utf8');
    throw new Error('无法解析 config/league.json（已将原始内容保存为 data/league.json.raw.txt）\n' + e.message);
  }
}

const { randomInt } = require('crypto');
const vm = require('vm');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 13_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1'
];
const ACCEPT_LANGS = ['zh-CN,zh;q=0.9', 'en-US,en;q=0.9', 'zh-CN,zh;q=0.8,en;q=0.6'];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

async function delay(min = 300, max = 1200) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchWithRetry(url, opts = {}) {
  const maxAttempts = opts.retries ?? 3;
  const timeoutMs = opts.timeoutMs ?? 8000;
  let attempt = 0;
  let lastErr = null;

  while (attempt < maxAttempts) {
    attempt += 1;
    const ua = pick(USER_AGENTS);
    const lang = pick(ACCEPT_LANGS);
    const headers = Object.assign(
      {
        'User-Agent': ua,
        'Accept-Language': lang,
        'Referer': opts.referer || 'https://zq.titan007.com',
        'Accept': '*/*',
      },
      opts.headers || {}
    );

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs + attempt * 1000);

    try {
      const res = await fetch(url, { signal: controller.signal, headers, cache: 'no-store' });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const text = await res.text();
      // polite random delay after a successful request
      await delay(300, 1200);
      return text;
    } catch (e) {
      lastErr = e;
      // exponential backoff with jitter
      const backoff = Math.pow(2, attempt) * 200 + Math.floor(Math.random() * 300);
      await delay(backoff, backoff + 300);
    }
  }
  console.warn(`请求失败: ${url} (${maxAttempts} attempts)`);
  return null;
}

function extractVariablesFromJS(jsText) {
  try {
    // find var <name> = occurrences
    const names = new Set();
    const varRe = /var\s+([A-Za-z0-9_]+)\s*=/g;
    let m;
    while ((m = varRe.exec(jsText)) !== null) {
      names.add(m[1]);
    }
    if (names.size === 0) return null;

    const sandbox = {};
    const context = vm.createContext(sandbox);

    // execute the script in a sandbox with a timeout
    const wrapped = jsText + '\n; (function(){ try{ return {' + Array.from(names).map(n => `${n}:${n}`).join(',') + '}; }catch(e){ return null;} })()';
    const script = new vm.Script(wrapped);
    const result = script.runInContext(context, { timeout: 2000 });
    return result || null;
  } catch (e) {
    return null;
  }
}

async function getSubSclassInfo(seasonStr, leagueId, referer) {
  // Fetch the SubLeague HTML page for the specific season and leagueId to extract SubSclassID and selectRound
  try {
    const url = `https://zq.titan007.com/cn/SubLeague/${seasonStr}/${leagueId}.html`;
    const html = await fetchWithRetry(url, { referer });
    if (!html) return null;
    // look for patterns like: var SubSclassID = 0; var selectRound = -1;
    const subMatch = html.match(/var\s+SubSclassID\s*=\s*([0-9]+)\s*;/i);
    const roundMatch = html.match(/var\s+selectRound\s*=\s*([0-9-]+)\s*;/i);
    const sub = subMatch ? Number(subMatch[1]) : null;
    const round = roundMatch ? Number(roundMatch[1]) : null;
    return { subSclassId: sub, round };
  } catch (e) {
    return null;
  }
}

function sanitizeFileName(s) {
  return s.replace(/[^a-zA-Z0-9-_\.]/g, '_');
}

async function main() {
  console.log('读取配置：', CONFIG_PATH);
  const cfg = await readConfig();
  await ensureDir(RAW_DIR);

  const index = [];

  for (const league of cfg) {
    const id = String(league.ID || league.Id || league.id || '').trim();
    const type = (league['赛事类型'] || league['type'] || '').trim();
    const seasons = league['赛季列表'] || league.seasons || [];
    if (!id) {
      console.warn('跳过没有 ID 的条目：', league['赛事名称'] || league['赛事地址']);
      continue;
    }

    for (const season of seasons) {
      const seasonStr = String(season).trim();
      const prefix = type === 'CupMatch' ? 'c' : 's';
      const isSub = (String(league['赛事地址'] || '').includes('/SubLeague/') || type === 'SubLeague');
      let matchUrl = `https://zq.titan007.com/jsData/matchResult/${seasonStr}/${prefix}${id}.js`;
      const seasonUrl = `https://zq.titan007.com/jsData/LeagueSeason/sea${id}.js`;

      let subSclassId = null;
      if (isSub) {
        const info = await getSubSclassInfo(seasonStr, id, league['赛事地址'] || undefined);
        if (info && info.subSclassId != null) {
          subSclassId = info.subSclassId;
          // use the sub id variant for match result JS
          matchUrl = `https://zq.titan007.com/jsData/matchResult/${seasonStr}/s${id}_${subSclassId}.js`;
        } else {
          console.warn(`未能获取 SubSclassID for league ${id} season ${seasonStr}, 将尝试默认路径`);
        }
      }

      console.log(`抓取: ${league['赛事名称'] || id} season=${seasonStr}`);

      const matchText = await fetchWithRetry(matchUrl, { referer: league['赛事地址'] || league['赛事地址'] || undefined });
      const seasonText = await fetchWithRetry(seasonUrl, { referer: league['赛事地址'] || league['赛事地址'] || undefined });

      const baseName = `${sanitizeFileName(id)}_${sanitizeFileName(seasonStr)}_${prefix}${id}${subSclassId ? '_' + String(subSclassId) : ''}`;
      const matchFile = path.join(RAW_DIR, `${baseName}_match.js`);
      const seasonFile = path.join(RAW_DIR, `${baseName}_season.js`);
      const matchJsonFile = path.join(RAW_DIR, `${baseName}_match.json`);
      const seasonJsonFile = path.join(RAW_DIR, `${baseName}_season.json`);

      

      if (matchText !== null) {
        await fs.writeFile(matchFile, matchText, 'utf8');
        const parsed = extractVariablesFromJS(matchText);
        if (parsed) {
          await fs.writeFile(matchJsonFile, JSON.stringify(parsed, null, 2), 'utf8');
        }
      }

      if (seasonText !== null) {
        await fs.writeFile(seasonFile, seasonText, 'utf8');
        const parsedSeason = extractVariablesFromJS(seasonText);
        if (parsedSeason) {
          await fs.writeFile(seasonJsonFile, JSON.stringify(parsedSeason, null, 2), 'utf8');
        }
      }

      index.push({
        id,
        name: league['赛事名称'] || league.name || '',
        type,
        season: seasonStr,
        subSclassId,
        matchUrl,
        seasonUrl,
        matchFile: matchText ? path.relative(DATA_DIR, matchFile) : null,
        seasonFile: seasonText ? path.relative(DATA_DIR, seasonFile) : null,
        matchJson: matchText && (await fileExists(matchJsonFile)) ? path.relative(DATA_DIR, matchJsonFile) : null,
        seasonJson: seasonText && (await fileExists(seasonJsonFile)) ? path.relative(DATA_DIR, seasonJsonFile) : null,
      });
      // small polite delay between league-season iterations
      await delay(200, 800);
    }
  }

  await fs.writeFile(path.join(DATA_DIR, 'index.json'), JSON.stringify(index, null, 2), 'utf8');
  console.log('抓取完成，已保存到 data/ 目录，索引为 data/index.json');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('脚本执行出错:', err.message);
    process.exit(1);
  });
}
