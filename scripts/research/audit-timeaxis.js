const fs=require('fs'),path=require('path');const {createClient}=require('@supabase/supabase-js');
const {M15,PAIRS,syncAsOf,loadAllPairsFromDb}=require('../../research/m15/loader');
function env(){const t=fs.readFileSync(path.join(__dirname,'..','..','.env'),'utf8');const e={};for(const l of t.split(/\r?\n/)){const m=l.match(/^([A-Z_]+)\s*=\s*(.*)$/);if(m)e[m[1]]=m[2].replace(/^["']|["']$/g,'').trim();}return e;}
(async()=>{const e=env();const sb=createClient(e.SUPABASE_URL,e.SUPABASE_SERVICE_KEY);
 const from='2026-08-25',to='2026-09-25';const fromMs=Date.parse(from+'T00:00:00Z'),toMs=Date.parse(to+'T21:00:00Z');
 const hist=await loadAllPairsFromDb(sb,{fromIso:new Date(fromMs-300*M15).toISOString(),toIso:new Date(toMs+6*M15).toISOString()});
 const firstClose=Math.ceil(fromMs/M15)*M15,lastClose=Math.floor(toMs/M15)*M15;
 let evaluated=0,alignedTrue=0;const frames=new Set();let weekendAligned=0;const perFrameCount={};
 for(let T=firstClose;T<=lastClose;T+=M15){const v=syncAsOf(hist,T);if(v.frameOpenMs==null||!v.aligned)continue;if(PAIRS.some(p=>v.bySync[p].length<60))continue;
   evaluated++;alignedTrue++;frames.add(v.frameOpenMs);perFrameCount[v.frameOpenMs]=(perFrameCount[v.frameOpenMs]||0)+1;
   const dow=new Date(v.frameOpenMs).getUTCDay();if(dow===0||dow===6)weekendAligned++;
 }
 // distinct frames whose actual candle exists at that exact frame time (real, not repeated stale)
 const repeated=Object.values(perFrameCount).filter(c=>c>1).length;
 const maxRepeat=Math.max(...Object.values(perFrameCount));
 // how many evaluated closes had T !== frameOpen+M15 (i.e., stale/gap: frame older than the close being evaluated)
 let staleEvals=0;for(let T=firstClose;T<=lastClose;T+=M15){const v=syncAsOf(hist,T);if(v.frameOpenMs==null||!v.aligned)continue;if(PAIRS.some(p=>v.bySync[p].length<60))continue;if(v.frameOpenMs+M15!==T)staleEvals++;}
 console.log(JSON.stringify({evaluatedClosesReported:evaluated,distinctFrames:frames.size,framesEvaluatedMoreThanOnce:repeated,maxTimesOneFrameEvaluated:maxRepeat,weekendFrameEvals:weekendAligned,evalsWhereFrameOlderThanClose_stale:staleEvals},null,2));
})().catch(e=>{console.error('ERR',e.message);process.exit(1);});
