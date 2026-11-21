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
  function qp(k){return (location.search.match(new RegExp('[?&]'+k+'=([^&]+)'))||[])[1];}
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

  var LETTERS='ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  function renderSingle(){
    var d=S.data, meta=d.meta;
    var flow=computeFlow(d.flow, meta); S.computed=flow;
    if(!flow||!flow.ok){ host.innerHTML='<div class="banner warn">'+esc((d.reason||flow&&flow.reason||'No data for this configuration')+'')+'</div>'; return; }
    var L=layout(flow);
    var showSeg = L.spans.length<=14;                 // A/B/C labels + counts when few blocks
    var mobile=window.innerWidth<=620;
    var ML=60,MR=20,MT=28,MB=showSeg?60:42;
    // fill the viewport height like a trading chart (clamped), measured once per render
    var H=mobile?Math.max(320,Math.min(460,Math.round(window.innerHeight*0.52)))
                :Math.max(420,Math.min(760,Math.round(window.innerHeight*0.60)));
    var scroll=document.createElement('div'); scroll.className='chartscroll';
    var cw=(host.clientWidth||900)-2;   // -2 for the .chartwrap 1px border each side
    // fit the ENTIRE chart into the available width at zoom 1 (no horizontal scrollbar);
    // zoom>1 widens it so you can pan to inspect, like a trading chart.
    var fitPx=(cw-ML-MR)/L.totalA;
    var pxU=fitPx*S.zoom;
    var W=Math.max(cw, ML+L.totalA*pxU+MR);
    var xAt=function(a){return ML+a*pxU;};
    var yAt=function(v){return (H-MB)-(v-L.vMin)/(L.vMax-L.vMin)*(H-MB-MT);};
    var prec=meta.precision!=null?meta.precision:(meta.kind==='index'?3:5);
    var fmt=function(v){return meta.kind==='index'?(v>=0?'+':'')+v.toFixed(3):v.toFixed(prec);};
    var unitShort = meta.kind==='index'?'snaps':(S.mode==='sim'?'quotes':'closes');

    var svg=el('svg',{class:'flow',width:W,height:H,viewBox:'0 0 '+W+' '+H});

    // y gridlines/labels at step units within domain
    var u0=Math.ceil((L.vMin-flow.anchor)/flow.step), u1=Math.floor((L.vMax-flow.anchor)/flow.step);
    var uStep=Math.max(1,Math.ceil((u1-u0)/10));
    for(var u=u0;u<=u1;u+=uStep){var val=flow.anchor+u*flow.step; var y=yAt(val);
      svg.appendChild(el('line',{x1:ML,y1:y,x2:W-MR,y2:y,stroke:'var(--flow-grid)','stroke-width':1}));
      var tl=el('text',{x:ML-8,y:y+3.5,'text-anchor':'end','font-size':10.5,fill:'var(--flow-axis)'});tl.textContent=fmt(val);svg.appendChild(tl);
    }
    if(meta.kind==='index'){var yb=yAt(flow.anchor);svg.appendChild(el('line',{x1:ML,y1:yb,x2:W-MR,y2:yb,stroke:'var(--flow-axis)','stroke-width':1.2,'stroke-dasharray':'2 3'}));}

    // bodies + traces + segment separators/labels
    var revMarks=[], peak={v:-Infinity,x:0,y:0}, trough={v:Infinity,x:0,y:0};
    function notePt(v,x,y){ if(v>peak.v){peak={v:v,x:x,y:y};} if(v<trough.v){trough={v:v,x:x,y:y};} }
    L.spans.forEach(function(sp,si){
      var isEv=sp.type==='event', x0=xAt(sp.a0), x1=xAt(sp.a1), w=Math.max(0.5,x1-x0);
      // dotted segment separator at the right edge of each span (except the last)
      if(showSeg && si<L.spans.length-1) svg.appendChild(el('line',{x1:x1,y1:MT,x2:x1,y2:H-MB,stroke:'var(--flow-axis)','stroke-width':1,'stroke-dasharray':'1 4','stroke-opacity':.55}));
      if(isEv){
        var ev=sp.ev;
        ev.levels.forEach(function(l){
          var yo=yAt(l.open), yc=yAt(l.close), up=l.dir==='up';
          svg.appendChild(el('rect',{x:x0,y:Math.min(yo,yc),width:w,height:Math.max(1.5,Math.abs(yo-yc)),fill:up?'var(--flow-up)':'var(--flow-dn)','fill-opacity':0.85,stroke:up?'var(--flow-up-bd)':'var(--flow-dn-bd)','stroke-opacity':0.8,'stroke-width':1}));
          if(l.kind==='reversal')revMarks.push({x:x1,y:yc,dir:l.dir,close:l.close,ms:ev.ms});
        });
        var pts=[[x0,yAt(ev.startValue)]]; notePt(ev.startValue,x0,yAt(ev.startValue));
        for(var i=0;i<ev.trace.length;i++){var xx=xAt(sp.a0+1+i),yy=yAt(ev.trace[i].value);pts.push([xx,yy]);notePt(ev.trace[i].value,xx,yy);}
        svg.appendChild(el('polyline',{points:pts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' '),fill:'none',stroke:'var(--flow-trace)','stroke-width':2.1,'stroke-linejoin':'round','stroke-linecap':'round'}));
        var hit=el('rect',{x:x0-Math.max(0,(14-w)/2),y:MT,width:Math.max(w,14),height:H-MB-MT,fill:'transparent'});
        hit.addEventListener('mousemove',function(e){showTip(e,ev,'event',meta);});
        hit.addEventListener('mouseleave',hideTip); hit.addEventListener('click',function(e){showTip(e,ev,'event',meta);});
        svg.appendChild(hit);
      } else {
        var f=sp.f, yhi=yAt(f.obsHigh), ylo=yAt(f.obsLow);
        svg.appendChild(el('rect',{x:x0,y:Math.min(yhi,ylo),width:w,height:Math.max(1.5,Math.abs(yhi-ylo)),fill:'var(--flow-axis)','fill-opacity':0.12,stroke:'var(--flow-axis)','stroke-opacity':0.8,'stroke-width':1,'stroke-dasharray':'4 3'}));
        var fpts=[[x0,yAt(f.startValue)]]; notePt(f.startValue,x0,yAt(f.startValue));
        for(var j=0;j<f.trace.length;j++){var fx=xAt(sp.a0+1+j),fy=yAt(f.trace[j].value);fpts.push([fx,fy]);notePt(f.trace[j].value,fx,fy);}
        svg.appendChild(el('polyline',{points:fpts.map(function(p){return p[0].toFixed(1)+','+p[1].toFixed(1);}).join(' '),fill:'none',stroke:'var(--flow-trace)','stroke-width':2.1,'stroke-opacity':.8,'stroke-dasharray':'4 3','stroke-linejoin':'round'}));
        svg.appendChild(el('circle',{cx:xAt(sp.a1),cy:yAt(f.latest.value),r:5,fill:'var(--flow-bg)',stroke:'var(--flow-trace)','stroke-width':2}));
        var fhit=el('rect',{x:x0,y:MT,width:Math.max(w,14),height:H-MB-MT,fill:'transparent'});
        fhit.addEventListener('mousemove',function(e){showTip(e,f,'forming',meta);});
        fhit.addEventListener('mouseleave',hideTip); fhit.addEventListener('click',function(e){showTip(e,f,'forming',meta);});
        svg.appendChild(fhit);
      }
      // segment label (letter + activity count) under the block
      if(showSeg){
        var cx=(x0+x1)/2, act=isEv?sp.ev.activity:sp.f.activity;
        var lt=el('text',{x:cx,y:H-MB+20,'text-anchor':'middle','font-size':12,'font-weight':800,fill:'var(--text)'});lt.textContent=LETTERS[si]||(si+1);svg.appendChild(lt);
        var ct=el('text',{x:cx,y:H-MB+35,'text-anchor':'middle','font-size':10.5,fill:'var(--flow-axis)'});ct.textContent=act+' '+unitShort;svg.appendChild(ct);
      }
    });

    // peak annotation (highest observed point), editorial leader + label
    if(isFinite(peak.v) && (L.vMax-L.vMin)>0){
      var plx=peak.x, ply=peak.y, right=plx<W-120, lx=right?plx+8:plx-8, tx2=right?plx+34:plx-34;
      svg.appendChild(el('line',{x1:plx,y1:ply,x2:tx2,y2:ply-14,stroke:'var(--flow-peak)','stroke-width':1}));
      var pt=el('text',{x:right?tx2+2:tx2-2,y:ply-16,'text-anchor':right?'start':'end','font-size':11,'font-weight':700,fill:'var(--flow-peak)'});pt.textContent='Peak '+fmt(peak.v);svg.appendChild(pt);
      svg.appendChild(el('circle',{cx:plx,cy:ply,r:2.6,fill:'var(--flow-trace)'}));
    }

    // reversal markers — editorial ring + label chip
    if(S.showReversals){
      revMarks.forEach(function(m){
        var up=m.dir==='up', col=up?'var(--flow-up-bd)':'var(--flow-signal)';
        svg.appendChild(el('circle',{cx:m.x,cy:m.y,r:6,fill:'none',stroke:col,'stroke-width':2.4}));
        svg.appendChild(el('circle',{cx:m.x,cy:m.y,r:2,fill:col}));
        var label=(up?'Upward':'Downward')+' reversal confirmed · '+fmt(m.close);
        var wlab=label.length*5.9+12, below=m.y<H/2;
        var bx=Math.min(Math.max(ML, m.x- wlab/2), W-MR-wlab), by=below?m.y+12:m.y-30;
        svg.appendChild(el('rect',{x:bx,y:by,width:wlab,height:20,rx:5,fill:col}));
        var t=el('text',{x:bx+wlab/2,y:by+13.5,'text-anchor':'middle','font-size':10.5,'font-weight':700,fill:'#fff'});t.textContent=label;svg.appendChild(t);
      });
    }

    // x axis
    if(!showSeg){
      var aTick=Math.max(1,Math.round(L.totalA/8));
      for(var a=0;a<=L.totalA;a+=aTick){svg.appendChild(el('line',{x1:xAt(a),y1:H-MB,x2:xAt(a),y2:H-MB+4,stroke:'var(--flow-axis)'}));var xt=el('text',{x:xAt(a),y:H-MB+16,'text-anchor':'middle','font-size':10,fill:'var(--flow-axis)'});xt.textContent=a;svg.appendChild(xt);}
    }
    var axl=el('text',{x:ML+(W-ML-MR)/2,y:H-7,'text-anchor':'middle','font-size':10.5,'font-style':'italic',fill:'var(--flow-axis)'});axl.textContent='cumulative '+meta.unit+' →';svg.appendChild(axl);

    scroll.appendChild(svg);
    host.innerHTML=''; var wrap=document.createElement('div');wrap.className='chartwrap';wrap.appendChild(scroll);
    var tip=document.createElement('div');tip.className='flowtip';tip.id='flowtip';wrap.appendChild(tip);
    host.appendChild(wrap);
    // caption
    var cap=document.createElement('div');cap.className='flowcap';
    cap.textContent = S.mode==='sim' ? 'Horizontal distance counts quote updates. The dark line joins successive observed midprices.'
      : (meta.kind==='index' ? 'Horizontal distance counts constituent basket snapshots. The dark line joins successive index values.'
      : 'Horizontal distance counts received '+meta.resolution+' closes. The dark line joins successive observed closes.');
    host.appendChild(cap);
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
    else if(S.view==='compare'){ title='8-Index Comparison'; sub=d.meta?('step <b>'+d.meta.step+'pp</b> · '+d.meta.resolution+' basket snapshots · ranked by index value'):''; }
    else if(d&&d.meta){ var m=d.meta; title=(m.label||S.instrument)+' · Inverted Flow';
      if(m.kind==='pair')sub='step <b>'+m.step+'</b> ('+m.stepPips+' pip) · <b>'+m.resolution+' closes</b> · width = received closes';
      else sub='step <b>'+m.step+'pp</b> · <b>M15 basket snapshots</b> since 00:00 EAT · width = basket snapshots';
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
    leg.innerHTML='<span class="k"><span class="sw up"></span> confirmed up body</span>'
      +'<span class="k"><span class="sw dn"></span> confirmed down body</span>'
      +'<span class="k"><span class="sw form"></span> forming (unconfirmed)</span>'
      +'<span class="k"><span class="sw line"></span> observed '+(S.view==='sim'?'midpoint path':(d&&d.meta&&d.meta.kind==='index'?'index path':'close path'))+'</span>'
      +'<span class="k">Height = price movement · Width = '+wUnit+'</span>';
    // footer
    document.getElementById('foot').innerHTML='The <b>Inverted Flow Chart</b> draws a fixed-height block per confirmed '+((d&&d.meta&&d.meta.step)||'')+' step; the block\'s <b>width</b> is the number of eligible observations it took (feed activity), and the thin line is the <b>observed path</b> inside it. NervaFX stores completed midpoint candles only, so pairs/indices run in <b>close-only mode</b> (width = received closes / basket snapshots — NOT ticks, traded volume, or quote count) and no intrabar path is claimed. Use <b>● Live</b> for the latest completed candle or the date picker to replay past data. Research / relative-movement only — <b>no orders, no signal, no profitability claim</b>. Times in EAT (UTC+3).';
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
    if(S.view==='compare'){ renderCompare(); document.getElementById('replaybar').style.display='none'; }
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
  document.getElementById('zoomIn').onclick=function(){ S.zoom=Math.min(40,S.zoom*1.6); if(S.view!=='compare')renderSingle(); };
  document.getElementById('zoomOut').onclick=function(){ S.zoom=Math.max(0.2,S.zoom/1.6); if(S.view!=='compare')renderSingle(); };
  document.getElementById('zoomReset').onclick=function(){ S.zoom=1; if(S.view!=='compare')renderSingle(); };
  document.getElementById('histGo').onclick=function(){ var ms=msFromEat(histDt.value); if(isNaN(ms)||ms>=Date.now()){histDt.focus();return;} S.asOf=ms; nav({asOf:ms}); };
  document.getElementById('histLive').onclick=function(){ S.asOf=null; nav({asOf:null}); };
  // replay
  document.getElementById('rpPlay').onclick=function(){ if(S.play){stopPlay();}else{ var total=S.data.flow.observations.length-1; if(S.cursor==null)S.cursor=Math.min(2,total); S.play=setInterval(function(){ var t=S.data.flow.observations.length-1; var nx=(S.cursor==null?t:S.cursor)+1; if(nx>=t){setCursor(t);stopPlay();} else setCursor(nx); }, Math.max(30,400/S.speed)); } renderReplay(); };
  document.getElementById('rpStepObs').onclick=function(){ stopPlay(); var t=S.data.flow.observations.length-1; setCursor((S.cursor==null?t:S.cursor)+1); };
  document.getElementById('rpStepEvt').onclick=function(){ stopPlay(); var idx=eventConfirmIndices(S.data.flow); var cur=S.cursor==null?(S.data.flow.observations.length-1):S.cursor; var nx=idx.find(function(x){return x>cur;}); setCursor(nx==null?(S.data.flow.observations.length-1):nx); };
  document.getElementById('rpLive').onclick=function(){ stopPlay(); S.cursor=null; renderSingle(); renderReplay(); };
  document.getElementById('rpSpeed').onchange=function(){ S.speed=parseFloat(this.value)||4; if(S.play){stopPlay();document.getElementById('rpPlay').click();} };
  window.addEventListener('resize',function(){ if(S.view==='compare')renderCompare(); else if(S.data)renderSingle(); });

  buildInstruments();
  load();
})();
