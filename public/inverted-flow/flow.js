'use strict';
/* NervaFX Inverted Flow Chart — frontend controller, client block engine (port of
 * research/flow/blocks.js) and custom SVG renderer. x-axis = cumulative activity (eligible
 * observations), y-axis = price / index value. Research only — no orders. */
(function () {
  // ---------- instruments (mirror research/comparison/config.js) ----------
  var PAIRS = ['AUD_CAD','AUD_CHF','AUD_JPY','AUD_NZD','AUD_USD','CAD_CHF','CAD_JPY','CHF_JPY','EUR_AUD','EUR_CAD','EUR_CHF','EUR_GBP','EUR_JPY','EUR_NZD','EUR_USD','GBP_AUD','GBP_CAD','GBP_CHF','GBP_JPY','GBP_NZD','GBP_USD','NZD_CAD','NZD_CHF','NZD_JPY','NZD_USD','USD_CAD','USD_CHF','USD_JPY'];
  var CCYS = ['USD','EUR','GBP','JPY','CHF','CAD','AUD','NZD'];
  var JPY = { EUR_JPY:1,GBP_JPY:1,AUD_JPY:1,NZD_JPY:1,CAD_JPY:1,CHF_JPY:1,USD_JPY:1 };
  function pipOf(p){ return JPY[p] ? 0.01 : 0.0001; }
  function precOf(p){ return JPY[p] ? 3 : 5; }

  // ---------- client block engine (faithful port) ----------
  function unitsOf(v,a,s){ return Math.round(((v-a)/s)*1e6)/1e6; }
  function levelsFor(vu,Cu,dir){
    var bodies=[];
    for(var g=0;g<100000;g++){
      if(dir==='up'){
        if(vu>=Cu+1){bodies.push({dir:'up',kind:'continuation',openUnit:Cu,closeUnit:Cu+1});Cu+=1;continue;}
        if(vu<=Cu-2){bodies.push({dir:'down',kind:'reversal',openUnit:Cu-1,closeUnit:Cu-2});Cu-=2;dir='down';continue;}
        break;
      } else if(dir==='down'){
        if(vu<=Cu-1){bodies.push({dir:'down',kind:'continuation',openUnit:Cu,closeUnit:Cu-1});Cu-=1;continue;}
        if(vu>=Cu+2){bodies.push({dir:'up',kind:'reversal',openUnit:Cu+1,closeUnit:Cu+2});Cu+=2;dir='up';continue;}
        break;
      } else {
        if(vu>=Cu+1){bodies.push({dir:'up',kind:'opening',openUnit:Cu,closeUnit:Cu+1});Cu+=1;dir='up';continue;}
        if(vu<=Cu-1){bodies.push({dir:'down',kind:'opening',openUnit:Cu,closeUnit:Cu-1});Cu-=1;dir='down';continue;}
        break;
      }
    }
    return {bodies:bodies,Cu:Cu,dir:dir};
  }
  function runBlocks(observations,opts){
    var o=opts||{}, step=o.step, precision=o.precision==null?6:o.precision;
    var obs=(observations||[]).filter(function(p){return p&&isFinite(p.value)&&isFinite(p.ms);});
    if(!obs.length) return {ok:false,reason:'no observations'};
    var anchor=o.anchor!=null?o.anchor:obs[0].value;
    var f=Math.pow(10,precision), priceOf=function(u){return Math.round((anchor+u*step)*f)/f;};
    var Cu=0, dir=o.dir0||null, events=[], blocks=[], seq=0;
    var pending=[], startValue=anchor, startMs=obs[0].ms, prevMs=obs[0].ms;
    for(var i=1;i<obs.length;i++){
      var p=obs[i]; pending.push(p);
      var gap=(o.intervalMs&&prevMs!=null&&(p.ms-prevMs)>o.intervalMs*1.5)||false; prevMs=p.ms;
      var vu=unitsOf(p.value,anchor,step), res=levelsFor(vu,Cu,dir);
      if(res.bodies.length){
        var activity=pending.length, trace=pending.map(function(q){return {value:q.value,ms:q.ms};});
        var hi=-Infinity, lo=Infinity; pending.forEach(function(q){if(q.value>hi)hi=q.value;if(q.value<lo)lo=q.value;});
        var levels=res.bodies.map(function(b){return {dir:b.dir,kind:b.kind,openUnit:b.openUnit,closeUnit:b.closeUnit,open:priceOf(b.openUnit),close:priceOf(b.closeUnit)};});
        var ev={seq:seq++,ms:p.ms,activity:activity,startValue:startValue,startMs:startMs,trace:trace,levels:levels,observedTrigger:p.value,bid:p.bid!=null?p.bid:null,ask:p.ask!=null?p.ask:null,obsHigh:hi,obsLow:lo,flags:{multiJump:levels.length>1,gap:gap,stale:!!p.stale}};
        events.push(ev);
        for(var k=0;k<levels.length;k++) blocks.push({dir:levels[k].dir,kind:levels[k].kind,theoreticalOpen:levels[k].open,theoreticalClose:levels[k].close,activity:k===0?activity:0,groupSize:levels.length,groupIndex:k,startMs:startMs,confirmMs:p.ms,obsHigh:hi,obsLow:lo,flags:ev.flags});
        Cu=res.Cu; dir=res.dir; startValue=p.value; startMs=p.ms; pending=[];
      }
    }
    var forming=null;
    if(pending.length){
      var hi2=-Infinity, lo2=Infinity; pending.forEach(function(q){if(q.value>hi2)hi2=q.value;if(q.value<lo2)lo2=q.value;});
      var last=pending[pending.length-1];
      forming={activity:pending.length,startValue:startValue,startMs:startMs,trace:pending.map(function(q){return {value:q.value,ms:q.ms};}),obsHigh:hi2,obsLow:lo2,latest:{value:last.value,ms:last.ms,bid:last.bid!=null?last.bid:null,ask:last.ask!=null?last.ask:null},unit:Cu,dir:dir,nextUp:priceOf(dir==='down'?Cu+2:Cu+1),nextDown:priceOf(dir==='up'?Cu-2:Cu-1)};
    }
    return {ok:true,anchor:anchor,step:step,precision:precision,events:events,blocks:blocks,forming:forming,finalUnit:Cu,finalDir:dir,firstMs:obs[0].ms,lastMs:obs[obs.length-1].ms,nObs:obs.length-1};
  }

  // ---------- time (EAT = UTC+3) ----------
  var EAT=3*3600000;
  function pad(n){return (n<10?'0':'')+n;}
  function eatStamp(ms){var d=new Date(ms+EAT);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+' '+pad(d.getUTCHours())+':'+pad(d.getUTCMinutes())+' EAT';}
  function eatNaive(ms){var d=new Date(ms+EAT);return d.getUTCFullYear()+'-'+pad(d.getUTCMonth()+1)+'-'+pad(d.getUTCDate())+'T'+pad(d.getUTCHours())+':'+pad(Math.floor(d.getUTCMinutes()/15)*15);}
  function msFromEat(v){if(!v)return NaN;var t=Date.parse(v+':00Z');return isNaN(t)?NaN:t-EAT;}
  function durStr(ms){if(ms==null)return '—';var s=Math.round(ms/1000);if(s<60)return s+'s';var m=Math.round(s/60);if(m<60)return m+'m';var h=Math.floor(m/60);return h+'h '+(m%60)+'m';}

  // ---------- query / state ----------
  function qp(k){var m=location.search.match(new RegExp('[?&]'+k+'=([^&]+)'));if(!m)return undefined;try{return decodeURIComponent(m[1]);}catch(e){return m[1];}}
  var S={
    kind: qp('instrument') && qp('instrument').indexOf('IDX:')===0 ? 'index' : (qp('kind')||'pair'),
    instrument: qp('instrument') || 'EUR_USD',
    mode: 'close',
    view: qp('view')==='compare'?'compare':'single',
    resolution: qp('resolution') || 'M5',
    step: qp('step') ? parseFloat(qp('step')) : null,
    asOf: qp('asOf') ? +qp('asOf') : null,
    date: qp('date') || null,
    showReversals: false,
    zoom: 1,
    cursor: null,            // replay cursor (null = full)
    data: null, computed: null, play: null, speed: 4,
  };
  if (S.instrument.indexOf('IDX:')===0) S.kind='index';

  var host=document.getElementById('host');
  document.getElementById('ver').textContent='flow';
  var histDt=document.getElementById('histDt'); histDt.value = S.asOf?eatNaive(S.asOf):eatNaive(Date.now());

  // ---------- navigation ----------
  function nav(params){
    var p={};
    if(S.view==='compare'){p.view='compare';}
    else if(S.view==='sim'){p.view='sim';}
    else {p.instrument=S.instrument; if(S.kind==='pair')p.resolution=S.resolution;}
    if(S.step!=null)p.step=S.step;
    if(S.asOf)p.asOf=S.asOf;
    if(S.date)p.date=S.date;
    Object.keys(params||{}).forEach(function(k){ if(params[k]==null) delete p[k]; else p[k]=params[k]; });
    var qs=Object.keys(p).filter(function(k){return p[k]!=null&&p[k]!=='';}).map(function(k){return k+'='+encodeURIComponent(p[k]);}).join('&');
    location.href=location.pathname+'?'+qs;
  }

  // ---------- data load ----------
  function apiUrl(){
    if(S.view==='sim') return '/api/inverted-flow?mode=sim';
    if(S.view==='compare'){var u='/api/inverted-flow?view=compare'; if(S.step!=null)u+='&step='+S.step; if(S.asOf)u+='&asOf='+S.asOf; if(S.date)u+='&date='+encodeURIComponent(S.date); return u;}
    var u='/api/inverted-flow?instrument='+encodeURIComponent(S.instrument);
    if(S.kind==='pair')u+='&resolution='+S.resolution;
    if(S.step!=null)u+='&step='+S.step;
    if(S.asOf)u+='&asOf='+S.asOf;
    if(S.date)u+='&date='+encodeURIComponent(S.date);
    return u;
  }
  function load(){
    host.innerHTML='<div class="banner">Loading…</div>';
    fetch(apiUrl()).then(function(r){return r.json();}).then(function(j){
      S.data=j; S.cursor=null;
      if(j.version)document.getElementById('ver').textContent=j.version;
      render();
    }).catch(function(e){ host.innerHTML='<div class="banner warn">Failed to load: '+e+'</div>'; });
  }

  // ---------- compute (client engine from observations up to cursor) ----------
  function computeFlow(flow,meta){
    if(!flow||!flow.observations)return flow;
    var cur = S.cursor==null ? flow.observations.length-1 : S.cursor;
    var slice = flow.observations.slice(0, cur+1);
    var anchor = meta.kind==='index' ? 0 : flow.anchor;
    return runBlocks(slice,{anchor:anchor,step:flow.step!=null?flow.step:meta.step,precision:meta.precision!=null?meta.precision:(meta.kind==='index'?3:5),intervalMs: meta.kind==='pair'?(({M5:300000,M15:900000,H1:3600000})[meta.resolution]):null});
  }

  // ========================= SVG RENDER (single) =========================
  var NS='http://www.w3.org/2000/svg';
  function el(tag,attrs){var e=document.createElementNS(NS,tag);if(attrs)for(var k in attrs)e.setAttribute(k,attrs[k]);return e;}
  function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

  function layout(flow){
    // event x spans + value domain
    var events=flow.events||[], forming=flow.forming;
    var cum=0, spans=[]; var vMin=Infinity,vMax=-Infinity;
    function note(v){if(v<vMin)vMin=v;if(v>vMax)vMax=v;}
    events.forEach(function(ev){
      var a0=cum, a1=cum+ev.activity; cum=a1;
      ev.levels.forEach(function(l){note(l.open);note(l.close);});
      ev.trace.forEach(function(t){note(t.value);}); note(ev.startValue);
      spans.push({type:'event',ev:ev,a0:a0,a1:a1});
    });
    if(forming){var a0=cum,a1=cum+forming.activity;cum=a1;note(forming.obsHigh);note(forming.obsLow);note(forming.startValue);spans.push({type:'forming',f:forming,a0:a0,a1:a1});}
    if(vMin===Infinity){vMin=flow.anchor-1;vMax=flow.anchor+1;}
    var pad=(vMax-vMin)*0.10||flow.step||1; vMin-=pad; vMax+=pad;
    return {spans:spans,totalA:cum||1,vMin:vMin,vMax:vMax};
  }

  // ========================= lightweight-charts renderer (single) =========================
  // Each confirmed block = one Renko-style candle (body = the fixed step, wicks = observed
  // range); the lower panel is feed activity (the block's "width" in the original idea).
  // Native TradingView pan / wheel-zoom / crosshair / scroll-through-history.
  var LW=null, LWkey=null;
  function fmtVal(v,meta){var prec=meta.precision!=null?meta.precision:(meta.kind==='index'?3:5);return meta.kind==='index'?((v>=0?'+':'')+v.toFixed(3)+'pp'):v.toFixed(prec);}
  function lwEatTick(t){var d=new Date(t*1000+EAT);var h=pad(d.getUTCHours())+':'+pad(d.getUTCMinutes());return (d.getUTCHours()===0&&d.getUTCMinutes()<16)?(pad(d.getUTCDate())+'/'+pad(d.getUTCMonth()+1)):h;}
  function lwEatFull(t){return eatStamp(t*1000);}
  function destroyLW(){ if(LW){try{LW.chart.remove();}catch(e){} try{window.removeEventListener('resize',LW.resize);}catch(e){} LW=null; LWkey=null;} }
  function ensureChart(){
    var box=document.getElementById('flowchartbox');
    if(LW&&box&&box.firstChild) return false;
    destroyLW(); host.innerHTML='';
    var wrap=document.createElement('div');wrap.className='chartwrap';
    box=document.createElement('div');box.id='flowchartbox';wrap.appendChild(box);
    var leg=document.createElement('div');leg.className='lwlegend';leg.id='lwlegend';wrap.appendChild(leg);
    host.appendChild(wrap);
    var cap=document.createElement('div');cap.className='flowcap';cap.id='flowcap';host.appendChild(cap);
    var chart=LightweightCharts.createChart(box,{
      width:box.clientWidth, height:box.clientHeight||480,
      layout:{background:{color:'transparent'},textColor:'#94a3b8',fontFamily:'Inter, sans-serif'},
      grid:{vertLines:{color:'rgba(42,49,72,.45)'},horzLines:{color:'rgba(42,49,72,.45)'}},
      rightPriceScale:{borderColor:'#2a3148',scaleMargins:{top:0.05,bottom:0.16}},
      timeScale:{borderColor:'#2a3148',timeVisible:true,secondsVisible:false,tickMarkFormatter:lwEatTick,rightOffset:4,minBarSpacing:2},
      localization:{timeFormatter:lwEatFull},
      crosshair:{mode:0},
    });
    var candle=chart.addCandlestickSeries({upColor:'#16c784',downColor:'#f6465d',borderVisible:false,wickUpColor:'rgba(22,199,132,.95)',wickDownColor:'rgba(246,70,93,.95)'});
    var vol=chart.addHistogramSeries({priceFormat:{type:'volume'},priceScaleId:'vol',lastValueVisible:false});
    chart.priceScale('vol').applyOptions({scaleMargins:{top:0.88,bottom:0}});
    var resize=function(){var b=document.getElementById('flowchartbox');if(b&&LW&&LW.chart)LW.chart.applyOptions({width:b.clientWidth,height:b.clientHeight});};
    window.addEventListener('resize',resize);
    LW={chart:chart,candle:candle,vol:vol,resize:resize,byTime:{}};
    chart.subscribeCrosshairMove(function(param){ updateLegend(param); });
    return true;
  }
  function renderSingle(){
    var d=S.data, meta=d.meta;
    if(!window.LightweightCharts){ host.innerHTML='<div class="banner warn">Chart library unavailable.</div>'; return; }
    var flow=computeFlow(d.flow, meta); S.computed=flow;
    if(!flow||!flow.ok){ destroyLW(); host.innerHTML='<div class="banner warn">'+esc((d.reason||(flow&&flow.reason)||'No data for this configuration'))+'</div>'; return; }
    var prec=meta.precision!=null?meta.precision:(meta.kind==='index'?3:5);
    var built=ensureChart();
    var candles=[],vols=[],markers=[],byTime={},lastT=-Infinity;
    function pushCandle(o,c,hi,lo,ms,act,forming,ev){
      var t=Math.floor(ms/1000); if(t<=lastT)t=lastT+1; lastT=t;
      candles.push({time:t,open:o,high:Math.max(hi,o,c),low:Math.min(lo,o,c),close:c});
      vols.push({time:t,value:act,color:forming?'rgba(148,163,184,.5)':(c>=o?'rgba(22,199,132,.55)':'rgba(246,70,93,.55)')});
      byTime[t]={o:o,c:c,hi:hi,lo:lo,act:act,forming:forming,ev:ev};
    }
    (flow.events||[]).forEach(function(ev){
      var o=ev.levels[0].open, c=ev.levels[ev.levels.length-1].close, rev=null;
      ev.levels.forEach(function(l){if(l.kind==='reversal')rev=l;});
      pushCandle(o,c,ev.obsHigh,ev.obsLow,ev.ms,ev.activity,false,ev);
      if(rev&&S.showReversals){var t=candles[candles.length-1].time;markers.push({time:t,position:rev.dir==='up'?'belowBar':'aboveBar',color:rev.dir==='up'?'#16c784':'#f6465d',shape:rev.dir==='up'?'arrowUp':'arrowDown',text:(rev.dir==='up'?'Upward':'Downward')+' reversal · '+fmtVal(rev.close,meta)});}
    });
    if(flow.forming){var f=flow.forming;pushCandle(f.startValue,f.latest.value,f.obsHigh,f.obsLow,f.latest.ms,f.activity,true,null);}
    LW.byTime=byTime;
    LW.candle.applyOptions({priceFormat:{type:'price',precision:prec,minMove:Math.pow(10,-prec)}});
    LW.candle.setData(candles);
    LW.vol.setData(vols);
    LW.candle.setMarkers(markers);
    var key=S.view+'|'+S.instrument+'|'+S.resolution+'|'+S.asOf+'|'+S.step;
    if(built||key!==LWkey){ LW.chart.timeScale().fitContent(); LWkey=key; }
    var cap=document.getElementById('flowcap');
    if(cap) cap.textContent = (meta.kind==='index')
      ? ('Each brick = one '+meta.step+'pp step of the index · wicks = observed snapshot range · lower panel = basket-snapshot activity. Drag to pan · wheel to zoom.')
      : ('Each brick = one '+meta.step+' ('+meta.stepPips+'-pip) step · wicks = observed '+meta.resolution+'-close range · lower panel = feed activity. Drag to pan · wheel to zoom.');
    updateLegend(null);
  }
  function updateLegend(param){
    var leg=document.getElementById('lwlegend'); if(!leg||!LW)return;
    var meta=S.data&&S.data.meta; if(!meta)return;
    var info=null, t=param&&param.time;
    if(t!=null&&LW.byTime[t])info=LW.byTime[t];
    if(!info){var ks=Object.keys(LW.byTime);if(!ks.length){leg.innerHTML='';return;}info=LW.byTime[ks[ks.length-1]];}
    var up=info.c>=info.o;
    var dir=info.forming?'<b>forming</b>':('<b class="'+(up?'up':'dn')+'">'+(up?'up':'down')+(info.ev&&info.ev.levels.length>1?' ×'+info.ev.levels.length:'')+(info.ev&&info.ev.levels.some(function(l){return l.kind==='reversal';})?' · reversal':'')+'</b>');
    var unit=meta.kind==='index'?'snaps':(meta.resolution+' closes');
    leg.innerHTML='<b>'+esc(meta.label||S.instrument)+'</b> · '+dir
      +'<br>body '+fmtVal(info.o,meta)+' → '+fmtVal(info.c,meta)
      +'<br>range '+fmtVal(info.lo,meta)+' … '+fmtVal(info.hi,meta)+' · activity '+info.act+' '+unit;
  }

  // tooltip
  function showTip(e,obj,type,meta){
    var tip=document.getElementById('flowtip'); if(!tip)return;
    var prec=meta.precision!=null?meta.precision:(meta.kind==='index'?3:5);
    var fmt=function(v){return v==null?'—':(meta.kind==='index'?(v>=0?'+':'')+v.toFixed(3)+'pp':v.toFixed(prec));};
    var html='';
    var unit=meta.unit, resLbl=meta.resolution;
    if(type==='event'){
      var l=obj.levels[0], last=obj.levels[obj.levels.length-1];
      var statusCls=l.dir==='up'?'up':'dn';
      html+='<div><b>'+esc(meta.label||S.instrument)+'</b> <span class="muted">· '+esc(resLbl)+'</span></div>';
      html+='<div class="'+statusCls+'"><b>'+(obj.levels.length>1?'Multi-level '+ (l.kind==='reversal'?'reversal':'jump')+' ('+obj.levels.length+' levels)':(l.kind==='opening'?'Opening block':l.kind==='reversal'?(l.dir==='up'?'Upward':'Downward')+' reversal':(l.dir==='up'?'Up':'Down')+' continuation'))+'</b></div>';
      html+='<div class="muted">Body '+fmt(l.open)+' → '+fmt(last.close)+'</div>';
      html+='<div class="muted">Observed '+(meta.kind==='pair'&&S.mode!=='sim'?'close ':'')+'range '+fmt(obj.obsLow)+' … '+fmt(obj.obsHigh)+(meta.kind==='pair'&&S.mode!=='sim'?' (close extremes)':'')+'</div>';
      html+='<div class="muted">Start '+eatStamp(obj.startMs)+'</div>';
      html+='<div class="muted">Confirm '+eatStamp(obj.ms)+' · '+durStr(obj.ms-obj.startMs)+'</div>';
      html+='<div class="muted">Activity '+obj.activity+' '+unit+'</div>';
      html+='<div class="muted">Trigger '+fmt(obj.observedTrigger)+(obj.bid!=null?' · bid '+obj.bid+' / ask '+obj.ask:'')+'</div>';
      var fl=[]; if(obj.flags.multiJump)fl.push('multi-level jump'); if(obj.flags.gap)fl.push('after gap'); if(obj.flags.stale)fl.push('stale'); if(fl.length)html+='<div style="color:var(--yellow)">⚑ '+fl.join(', ')+'</div>';
    } else {
      html+='<div><b>'+esc(meta.label||S.instrument)+'</b> <span class="muted">· '+esc(resLbl)+'</span></div>';
      html+='<div class="muted"><b>Forming</b> (unconfirmed)</div>';
      html+='<div class="muted">Observed range '+fmt(obj.obsLow)+' … '+fmt(obj.obsHigh)+'</div>';
      html+='<div class="muted">Latest '+fmt(obj.latest.value)+' @ '+eatStamp(obj.latest.ms)+'</div>';
      html+='<div class="muted">Activity '+obj.activity+' '+unit+' · '+durStr(obj.latest.ms-obj.startMs)+'</div>';
      html+='<div class="muted">Needs '+fmt(obj.dir==='down'?obj.nextDown:obj.nextUp)+' to confirm '+(obj.dir==='down'?'down':'up')+(obj.dir? ' continuation':'')+'</div>';
    }
    tip.innerHTML=html; tip.style.display='block';
    var wrap=tip.parentElement, br=wrap.getBoundingClientRect();
    var x=e.clientX-br.left+12, y=e.clientY-br.top+12;
    if(x+tip.offsetWidth>br.width)x=br.width-tip.offsetWidth-6;
    if(y+tip.offsetHeight>br.height)y=e.clientY-br.top-tip.offsetHeight-10;
    tip.style.left=Math.max(4,x)+'px'; tip.style.top=Math.max(4,y)+'px';
  }
  function hideTip(){var t=document.getElementById('flowtip');if(t)t.style.display='none';}

  // ========================= SVG RENDER (compare) =========================
  function renderCompare(){
    var d=S.data;
    if(!d.ok||!d.panels){ host.innerHTML='<div class="banner warn">'+esc(d.reason||'Comparison unavailable')+'</div>'; return; }
    // common vertical scale across panels (pp)
    var vMin=Infinity,vMax=-Infinity;
    d.panels.forEach(function(p){ if(!p.flow)return; var L=layout(p.flow); if(L.vMin<vMin)vMin=L.vMin; if(L.vMax>vMax)vMax=L.vMax; });
    if(vMin===Infinity){vMin=-0.5;vMax=0.5;}
    var order={}; (d.ranking||[]).forEach(function(r){order[r.currency]=r.rank;});
    var panels=d.panels.slice().sort(function(a,b){return (order[a.currency]||99)-(order[b.currency]||99);});
    var grid=document.createElement('div');grid.className='cmpgrid';
    panels.forEach(function(p){
      var card=document.createElement('div');card.className='cmpcard';
      var pp=p.lastPp;
      var top='<div class="top"><span class="ccy">'+p.currency+'</span><span class="rk">#'+(order[p.currency]||'–')+'</span>';
      if(p.finalDir)top+='<span class="dir '+(p.finalDir==='up'?'up':'dn')+'">'+(p.finalDir==='up'?'▲ up':'▼ down')+(p.lastConfirmMs?' · '+durStr(d.asOfUtc? (Date.parse(d.asOfUtc)-p.lastConfirmMs):null):'')+'</span>';
      top+='<span class="pp '+(pp>=0?'up':'dn')+'">'+(pp==null?'—':(pp>=0?'+':'')+pp.toFixed(3)+'pp')+'</span></div>';
      card.innerHTML=top;
      if(p.flow&&p.available){ card.appendChild(miniSvg(p.flow,vMin,vMax)); }
      else { var nd=document.createElement('div');nd.className='coverage warn';nd.textContent=p.reason||'unavailable';card.appendChild(nd); }
      card.style.cursor='pointer';
      card.addEventListener('click',function(){ S.view='single'; S.kind='index'; S.instrument='IDX:'+p.currency; nav({view:null,instrument:'IDX:'+p.currency}); });
      grid.appendChild(card);
    });
    host.innerHTML=''; host.appendChild(grid);
    var pr=buildPairStrength(d.panels); if(pr) host.appendChild(pr);
  }
  // Rank the 28 pairs by the strength gap between their two currencies (from the Renko index pp):
  // each pair has one strong and one weak currency; a bigger gap = a stronger directional lean.
  function buildPairStrength(panels){
    var strength={}, n=0;
    (panels||[]).forEach(function(p){ if(p.available&&p.lastPp!=null){strength[p.currency]=p.lastPp;n++;} });
    if(n<2) return null;
    var structures=(S.data&&S.data.structures)||{};
    var rows=[];
    PAIRS.forEach(function(pair){
      var pq=pair.split('_'), b=pq[0], q=pq[1];
      if(strength[b]==null||strength[q]==null) return;
      var sb=strength[b], sq=strength[q], leanUp=sb>=sq;
      rows.push({pair:pair, strong:leanUp?b:q, weak:leanUp?q:b, spread:Math.abs(sb-sq), leanUp:leanUp, struct:structures[pair]||null});
    });
    if(!rows.length) return null;
    rows.sort(function(a,b){return b.spread-a.spread;});
    var maxSp=rows[0].spread||1;
    var nAligned=0,nStruct=0; rows.forEach(function(r){ if(r.struct){nStruct++; if((r.struct==='up')===r.leanUp)nAligned++;} });
    var wrap=document.createElement('div');wrap.className='pairrank';
    var h='<h3>Pairs ranked by currency strength</h3>'
      +'<div class="sub">From each currency’s Renko index over the loaded window: every pair pits its <b class="s" style="color:var(--up)">strong</b> currency against its <b class="w" style="color:var(--dn)">weak</b> one. <b>Spread</b> = strong − weak (pp); <b>Lean</b> = the way the gap points (strong base → pair up). <b>Candle align</b> compares the Renko lean with the pair’s own candlestick structure (EMA-fast vs EMA-slow on its M15 closes) — <b class="al ok">aligned</b> when both point the same way'+(nStruct?(' ('+nAligned+'/'+nStruct+' aligned now)'):'')+'. Relative strength, research only — no signal, no orders.</div>'
      +'<table class="ptbl"><thead><tr><th>#</th><th>Pair</th><th>Strong</th><th>Weak</th><th class="num">Spread&nbsp;(pp)</th><th>Lean</th><th>Candle&nbsp;align</th><th style="width:20%">Strength&nbsp;gap</th></tr></thead><tbody>';
    rows.forEach(function(r,i){
      var al;
      if(!r.struct){ al='<td class="al none">—</td>'; }
      else { var cu=r.struct==='up', ok=(cu===r.leanUp); al='<td class="al '+(ok?'ok':'no')+'">'+(cu?'▲':'▼')+' '+(ok?'✓ aligned':'✗ diverging')+'</td>'; }
      h+='<tr data-pair="'+r.pair+'"><td class="num">'+(i+1)+'</td>'
        +'<td class="pair">'+r.pair.replace('_','/')+'</td>'
        +'<td class="s">'+r.strong+'</td><td class="w">'+r.weak+'</td>'
        +'<td class="num">'+r.spread.toFixed(3)+'</td>'
        +'<td class="lean '+(r.leanUp?'up':'dn')+'">'+(r.leanUp?'▲ up':'▼ down')+'</td>'
        +al
        +'<td><span class="bar" style="width:'+Math.max(4,Math.round(r.spread/maxSp*100))+'%"></span></td></tr>';
    });
    h+='</tbody></table>';
    wrap.innerHTML=h;
    wrap.querySelectorAll('tr[data-pair]').forEach(function(tr){tr.addEventListener('click',function(){var p=tr.getAttribute('data-pair');S.view='single';S.kind='pair';S.instrument=p;nav({view:null,instrument:p,resolution:S.resolution});});});
    return wrap;
  }
  function miniSvg(flow,vMin,vMax){
    var L=layout(flow); var W=360,H=120,ML=4,MR=4,MT=8,MB=8;
    var pxU=(W-ML-MR)/(L.totalA||1);
    var xAt=function(a){return ML+a*pxU;}, yAt=function(v){return (H-MB)-(v-vMin)/((vMax-vMin)||1)*(H-MB-MT);};
    var svg=el('svg',{viewBox:'0 0 '+W+' '+H,preserveAspectRatio:'none'});
    svg.appendChild(el('line',{x1:ML,y1:yAt(0),x2:W-MR,y2:yAt(0),stroke:'var(--flow-axis)','stroke-dasharray':'2 3',opacity:.7}));
    L.spans.forEach(function(sp){
      if(sp.type==='event'){var x0=xAt(sp.a0),w=Math.max(0.5,xAt(sp.a1)-x0);
        sp.ev.levels.forEach(function(l){var yo=yAt(l.open),yc=yAt(l.close),up=l.dir==='up';svg.appendChild(el('rect',{x:x0,y:Math.min(yo,yc),width:w,height:Math.max(1,Math.abs(yo-yc)),fill:up?'var(--flow-up)':'var(--flow-dn)','fill-opacity':.8}));});
      } else {var fx0=xAt(sp.a0),fw=Math.max(0.5,xAt(sp.a1)-fx0),yhi=yAt(sp.f.obsHigh),ylo=yAt(sp.f.obsLow);svg.appendChild(el('rect',{x:fx0,y:Math.min(yhi,ylo),width:fw,height:Math.max(1,Math.abs(yhi-ylo)),fill:'var(--flow-axis)','fill-opacity':.14,'stroke-dasharray':'3 2',stroke:'var(--flow-axis)','stroke-opacity':.7}));}
    });
    // continuous trace
    var pts=[], cum=0;
    (flow.events||[]).forEach(function(ev){pts.push([xAt(cum),yAt(ev.startValue)]);for(var i=0;i<ev.trace.length;i++)pts.push([xAt(cum+1+i),yAt(ev.trace[i].value)]);cum+=ev.activity;});
    if(flow.forming){pts.push([xAt(cum),yAt(flow.forming.startValue)]);for(var j=0;j<flow.forming.trace.length;j++)pts.push([xAt(cum+1+j),yAt(flow.forming.trace[j].value)]);}
    if(pts.length)svg.appendChild(el('polyline',{points:pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' '),fill:'none',stroke:'var(--flow-trace)','stroke-width':1.5,'stroke-opacity':.9,vector:'non-scaling-stroke'}));
    return svg;
  }

  // ========================= header / coverage / legend =========================
  function renderHeader(){
    var d=S.data, hdr=document.getElementById('charthdr'), cov=document.getElementById('coverage');
    var title='', sub='';
    if(S.view==='sim'){ title='EUR/USD · Simulated example'; sub='<b>5-pip</b> step · 10-pip reversal · width = <b>received quote updates</b>'; }
    else if(S.view==='compare'){ title='Currency Strength · 8 Indices'; sub=d.meta?('step <b>'+d.meta.step+'pp</b> · '+d.meta.resolution+' basket snapshots · 8 currencies ranked, then every pair ranked by its strength gap'):''; }
    else if(d&&d.meta){ var m=d.meta; title=(m.label||S.instrument)+' · Inverted Flow';
      if(m.kind==='pair')sub='step <b>'+m.step+'</b> ('+m.stepPips+' pip) · <b>'+m.resolution+' closes</b> · width = received closes';
      else sub='step <b>'+m.step+'pp</b> · <b>M15 basket snapshots</b>'+(d.daily?' · single day':' · multi-day window')+' · width = basket snapshots';
    }
    hdr.innerHTML='<div class="chrow"><span class="chTitle">'+esc(title)+'</span></div><div class="chSub">'+sub+'</div>';
    // coverage
    var c='';
    if(S.view==='sim'){ c='Simulated illustrative quote sequence — NOT broker history.'; }
    else if(d&&d.coverage){
      if(S.view==='compare'){ var cc=d.coverage; c='Index M15 · '+(cc.nObs||0)+' snapshots · '+(cc.gaps&&cc.gaps.length?cc.gaps.length+' gap(s)':'no gaps')+' · baseline '+(d.baselineUtc?eatStamp(Date.parse(d.baselineUtc)):'—'); }
      else if(d.meta&&d.meta.kind==='pair'){ var w=d.coverage.window,ir=d.coverage.instrument;
        c='Window '+(w&&w.ok?(w.nObs+' '+w.resolution+' closes · '+eatStamp(w.firstMs)+' → '+eatStamp(w.lastMs)):'—')+' · stored '+ir.resolution+' '+(ir.earliestMs?eatStamp(ir.earliestMs).slice(0,10):'?')+' → '+(ir.latestMs?eatStamp(ir.latestMs).slice(0,10):'?')+(w&&w.gaps&&w.gaps.length?' · <span class="warn">'+w.gaps.length+' gap(s)</span>':'');
      } else { c='Index M15 · baseline '+(d.baselineUtc?eatStamp(Date.parse(d.baselineUtc)):'—')+' · through '+(d.asOfUtc?eatStamp(Date.parse(d.asOfUtc)):'—'); }
    }
    cov.innerHTML=c;
    // legend
    var leg=document.getElementById('legend');
    var wUnit = S.view==='sim'?'received quote updates':(d&&d.meta&&d.meta.kind==='index'?'constituent basket snapshots':'received '+((d&&d.meta&&d.meta.resolution)||'')+' closes');
    leg.innerHTML='<span class="k"><span class="sw up"></span> up brick</span>'
      +'<span class="k"><span class="sw dn"></span> down brick</span>'
      +'<span class="k"><span class="sw form"></span> forming (unconfirmed)</span>'
      +'<span class="k">wicks = observed range</span>'
      +'<span class="k">lower panel = activity ('+wUnit+')</span>'
      +'<span class="k">each brick = one '+((d&&d.meta&&d.meta.step)||'')+(d&&d.meta&&d.meta.kind==='index'?'pp':'')+' step</span>';
    // footer
    document.getElementById('foot').innerHTML='The <b>Inverted Flow Chart</b> plots one <b>brick</b> per confirmed '+((d&&d.meta&&d.meta.step)||'')+' step (body = the step, wicks = the observed range); the <b>lower panel</b> is feed activity — the number of eligible observations each brick took. <b>Scroll/drag to pan, wheel to zoom</b>, like any trading chart. NervaFX stores completed midpoint candles only, so pairs/indices run in <b>close-only mode</b> (activity = received closes / basket snapshots — NOT ticks, traded volume, or quote count) and no intrabar path is claimed. Use <b>● Live</b> for the latest completed candle or the date picker to replay past data. Research / relative-movement only — <b>no orders, no signal, no profitability claim</b>. Times in EAT (UTC+3).';
  }

  // ========================= replay =========================
  function eventConfirmIndices(flow){ var idx=[],cum=0; (flow.events||[]).forEach(function(ev){cum+=ev.activity;idx.push(cum);}); return idx; }
  function renderReplay(){
    var bar=document.getElementById('replaybar');
    if(S.view==='compare'||!S.data||!S.data.flow||!S.data.flow.observations){bar.style.display='none';return;}
    bar.style.display='flex';
    var total=S.data.flow.observations.length-1; var cur=S.cursor==null?total:S.cursor;
    document.getElementById('rpPos').textContent='observation '+cur+' / '+total+(S.cursor==null?(S.asOf?' (as-of)':' (live)'):'');
    document.getElementById('rpPlay').textContent=S.play?'❚❚ Pause':'▶ Play';
  }
  function stopPlay(){ if(S.play){clearInterval(S.play);S.play=null;} }
  function setCursor(c){ var total=S.data.flow.observations.length-1; S.cursor=Math.max(0,Math.min(total,c)); if(S.cursor>=total)S.cursor=null; renderSingle(); renderReplay(); }

  // ========================= main render =========================
  function render(){
    renderHeader();
    // controls visibility
    document.getElementById('resCtl').style.display = (S.view==='single'&&S.kind==='pair')?'inline-flex':'none';
    document.getElementById('stepIn').parentElement.style.display = (S.view==='sim')?'none':'inline-flex';
    if(S.view==='compare'){ destroyLW(); renderCompare(); document.getElementById('replaybar').style.display='none'; }
    else { renderSingle(); renderReplay(); }
    syncControls();
  }

  // ========================= controls =========================
  function buildInstruments(){
    var sel=document.getElementById('instSel'); sel.innerHTML='';
    var list = S.kind==='index' ? CCYS.map(function(c){return {v:'IDX:'+c,t:c+' index'};}) : PAIRS.map(function(p){return {v:p,t:p.replace('_','/')};});
    var filt=(document.getElementById('instSearch').value||'').toUpperCase();
    list.forEach(function(o){ if(filt&&o.t.toUpperCase().indexOf(filt)<0&&o.v.toUpperCase().indexOf(filt)<0)return; var op=document.createElement('option');op.value=o.v;op.textContent=o.t;if(o.v===S.instrument)op.selected=true;sel.appendChild(op); });
  }
  function syncControls(){
    document.querySelectorAll('#kindSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-kind')===S.kind);});
    document.querySelectorAll('#viewSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-view')===S.view);});
    document.querySelectorAll('#resSeg button').forEach(function(b){b.classList.toggle('on',b.getAttribute('data-res')===S.resolution);});
    document.getElementById('revChk').checked=S.showReversals;
    // step field + unit
    var m=S.data&&S.data.meta;
    var stepIn=document.getElementById('stepIn'), unit=document.getElementById('stepUnit'), lbl=document.getElementById('stepLbl');
    if(m){ stepIn.value=m.step; if(m.kind==='index'){unit.textContent='pp';lbl.textContent='Step';stepIn.step='0.01';}else{unit.textContent='('+m.stepPips+' pip)';lbl.textContent='Step';stepIn.step=String(m.pip);} }
    document.getElementById('instSel').parentElement.style.display = (S.view==='sim'||S.view==='compare')?'none':'inline-flex';
  }

  // wire events
  document.querySelectorAll('#kindSeg button').forEach(function(b){b.onclick=function(){ S.kind=b.getAttribute('data-kind'); S.instrument = S.kind==='index'?'IDX:EUR':'EUR_USD'; S.step=null; S.view='single'; nav({view:null,instrument:S.instrument, resolution:S.kind==='pair'?S.resolution:null}); };});
  document.querySelectorAll('#viewSeg button').forEach(function(b){b.onclick=function(){ var v=b.getAttribute('data-view'); if(v==='compare')nav({view:'compare',instrument:null,resolution:null}); else if(v==='sim')nav({view:'sim',instrument:null,resolution:null,step:null}); else nav({view:null,instrument:S.instrument}); };});
  document.querySelectorAll('#resSeg button').forEach(function(b){b.onclick=function(){ S.resolution=b.getAttribute('data-res'); S.step=null; nav({resolution:S.resolution,step:null}); };});
  document.getElementById('instSel').onchange=function(){ S.instrument=this.value; S.kind=this.value.indexOf('IDX:')===0?'index':'pair'; nav({instrument:S.instrument}); };
  document.getElementById('instSearch').oninput=function(){ buildInstruments(); };
  document.getElementById('stepIn').onchange=function(){ var v=parseFloat(this.value); if(isFinite(v)&&v>0){S.step=v;nav({step:v});} };
  document.getElementById('revChk').onchange=function(){ S.showReversals=this.checked; if(S.view==='single'||S.view==='sim')renderSingle(); };
  function lwZoom(f){ if(!LW)return; var ts=LW.chart.timeScale(); var bs=(ts.options().barSpacing||6)*f; ts.applyOptions({barSpacing:Math.max(1,Math.min(80,bs))}); }
  document.getElementById('zoomIn').onclick=function(){ lwZoom(1.4); };
  document.getElementById('zoomOut').onclick=function(){ lwZoom(1/1.4); };
  document.getElementById('zoomReset').onclick=function(){ if(LW)LW.chart.timeScale().fitContent(); };
  document.getElementById('histGo').onclick=function(){ var ms=msFromEat(histDt.value); if(isNaN(ms)||ms>=Date.now()){histDt.focus();return;} S.asOf=ms; nav({asOf:ms}); };
  document.getElementById('histLive').onclick=function(){ S.asOf=null; nav({asOf:null}); };
  // replay
  document.getElementById('rpPlay').onclick=function(){ if(S.play){stopPlay();}else{ var total=S.data.flow.observations.length-1; if(S.cursor==null)S.cursor=Math.min(2,total); S.play=setInterval(function(){ var t=S.data.flow.observations.length-1; var nx=(S.cursor==null?t:S.cursor)+1; if(nx>=t){setCursor(t);stopPlay();} else setCursor(nx); }, Math.max(30,400/S.speed)); } renderReplay(); };
  document.getElementById('rpStepObs').onclick=function(){ stopPlay(); var t=S.data.flow.observations.length-1; setCursor((S.cursor==null?t:S.cursor)+1); };
  document.getElementById('rpStepEvt').onclick=function(){ stopPlay(); var idx=eventConfirmIndices(S.data.flow); var cur=S.cursor==null?(S.data.flow.observations.length-1):S.cursor; var nx=idx.find(function(x){return x>cur;}); setCursor(nx==null?(S.data.flow.observations.length-1):nx); };
  document.getElementById('rpLive').onclick=function(){ stopPlay(); S.cursor=null; renderSingle(); renderReplay(); };
  document.getElementById('rpSpeed').onchange=function(){ S.speed=parseFloat(this.value)||4; if(S.play){stopPlay();document.getElementById('rpPlay').click();} };
  window.addEventListener('resize',function(){ if(S.view==='compare')renderCompare(); /* single: lightweight-charts handles its own resize */ });

  buildInstruments();
  load();
})();
