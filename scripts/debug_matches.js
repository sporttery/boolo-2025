const fs = require('fs').promises;
const path = require('path');
const vm = require('vm');
(async ()=>{
  const RAW = path.resolve(__dirname, '../data/raw');
  const files = await fs.readdir(RAW).catch(()=>[]);
  let cnt=0;
  for (const f of files){
    if (!/_match\.js$/.test(f)) continue;
    try{
      const txt = await fs.readFile(path.join(RAW,f),'utf8');
      const sandbox = { arrLeague:null, arrTeam:null, jh:{}, arrCupKind:null, arrCup:null };
      const ctx = vm.createContext(sandbox);
      try{
        new vm.Script(txt).runInContext(ctx, { timeout: 2000 });
      }catch(e){
        // continue even if running file throws
      }
      const parsed = { arrLeague: typeof ctx.arrLeague!=='undefined'?ctx.arrLeague:null, arrCup: typeof ctx.arrCup!=='undefined'?ctx.arrCup:null, arrCupKind: typeof ctx.arrCupKind!=='undefined'?ctx.arrCupKind:null, arrTeam: typeof ctx.arrTeam!=='undefined'?ctx.arrTeam:null, jh: typeof ctx.jh!=='undefined'?ctx.jh:null };
      if (parsed && parsed.arrLeague){
        cnt++; console.log(f, 'OK', parsed.arrLeague && parsed.arrLeague[1]?String(parsed.arrLeague[1]):'');
      } else {
        console.log(f, 'NO_LEAGUE');
      }
    }catch(e){
      console.log('ERR', f, e && e.message ? e.message : e);
    }
  }
  console.log('total ok', cnt);
})();
