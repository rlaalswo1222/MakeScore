(function(){
'use strict';
const $ = s => document.querySelector(s);
const VF = window.Vex && window.Vex.Flow;
const clamp = (v,a,b) => Math.min(b, Math.max(a, v));
const params = new URLSearchParams(location.search);
if (params.has('demo')){
  const report = msg => { const d=document.createElement('pre'); d.className='dev-err'; d.textContent=msg; document.body.prepend(d); };
  window.addEventListener('error', e => report(`${e.message} @${e.lineno}:${e.colno}`));
  window.addEventListener('unhandledrejection', e => report('promise: '+(e.reason && (e.reason.stack || e.reason))));
}

/* ---------- 파이썬 연결 (개발용 미리보기에서는 가짜 API) ---------- */
let API = null;
function devApi(){
  return {
    recent: async () => [], choose_file: async () => null, transcribe: async () => false,
    open: async () => ({path:'demo', name:params.get('name')||'demo.wav', media:params.get('media')||'', isVideo:false,
      result: await (await fetch(params.get('demo'))).json(), edits:null}),
    save_edits: async () => true, forget_edits: async () => true, make_proxy: async () => ({error:'dev'}),
    save_musicxml: async x => { window.__xml = x; return null; }, save_pdf: async p => { window.__pdf = p; return null; }, reveal: async () => {},
    yt_info: async () => ({id:'jNQXAC9IVRw', title:'Me at the zoo', duration:19, uploader:'jawed', url:'https://www.youtube.com/watch?v=jNQXAC9IVRw'}),
    yt_download: async () => false, yt_cancel: async () => true, get_pref: async () => null, set_pref: async () => true,
  };
}

/* ---------- 상태 ---------- */
const SETTINGS = ['bpm','autoBpm','offset','follow','ts','key','grid','triplet','noteLen','fill','graces','voices','handMode','minVel','minConf','split','zoom'];
const DEFAULTS = {key:'auto', ts:'4/4', grid:3, triplet:true, noteLen:'key', fill:6, graces:true, voices:true, handMode:'auto', minVel:12, minConf:0.6, split:60, follow:true};
const S = {path:null, name:'', isVideo:true, duration:0, notes:[], pedals:[], result:null,
  bpm:100, autoBpm:100, offset:0, zoom:72, ...DEFAULTS,
  sel:null, source:'raw'};
let nid = 1;

/* ---------- 음 이름, 조 ---------- */
const SH=['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'], FL=['C','D♭','D','E♭','E','F','G♭','G','A♭','A','B♭','B'];
const VSH=['c','c#','d','d#','e','f','f#','g','g#','a','a#','b'], VFL=['c','db','d','eb','e','f','gb','g','ab','a','bb','b'];
const KEYS=[['C',0,0],['G',7,0],['D',2,0],['A',9,0],['E',4,0],['B',11,0],['F#',6,0],['F',5,1],['Bb',10,1],['Eb',3,1],['Ab',8,1],['Db',1,1]]
  .map(([id,pc,f]) => ({id,pc,flats:!!f}));
const FIFTHS={C:0,G:1,D:2,A:3,E:4,B:5,'F#':6,F:-1,Bb:-2,Eb:-3,Ab:-4,Db:-5};
const keyLabel = k => { const N=k.flats?FL:SH; return `${N[k.pc]}장조 / ${N[(k.pc+9)%12]}단조`; };
const majorName = k => (k.flats?FL:SH)[k.pc]+'장조';
const pitchName = (p,flats) => (flats?FL:SH)[p%12] + (Math.floor(p/12)-1);
const vfKey = (p,flats) => (flats?VFL:VSH)[p%12] + '/' + (Math.floor(p/12)-1);
const MAJ=[6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88], MIN=[6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17];
function corr(a,b){ const ma=a.reduce((s,x)=>s+x,0)/12, mb=b.reduce((s,x)=>s+x,0)/12; let n=0,da=0,db=0;
  for(let i=0;i<12;i++){ n+=(a[i]-ma)*(b[i]-mb); da+=(a[i]-ma)**2; db+=(b[i]-mb)**2; } return n/(Math.sqrt(da*db)||1); }
function detectKey(){
  const h = new Array(12).fill(0); S.notes.filter(visible).forEach(n => h[n.p%12] += n.d);
  let best = {r:-2, pc:0, minor:false};
  for (let pc=0; pc<12; pc++){
    const hv = Array.from({length:12}, (_,i) => h[(i+pc)%12]);
    const rM=corr(hv,MAJ), rm=corr(hv,MIN);
    if (rM>best.r) best={r:rM,pc,minor:false};
    if (rm>best.r) best={r:rm,pc,minor:true};
  }
  const key = KEYS.find(k => k.pc === (best.minor ? (best.pc+3)%12 : best.pc));
  return {key, name:(key.flats?FL:SH)[best.pc] + (best.minor?'단조':'장조')};
}

const visible = n => n.v >= S.minVel;
let AUTOHAND = new Map();                          // 자동 양손 판정 결과 (음 id → 'L'|'R')
const autoHand = n => (S.handMode==='auto' && AUTOHAND.get(n.id)) || (n.p >= S.split ? 'R' : 'L');
const handOf = n => n.hand || autoHand(n);
let GRACE = {main:new Map(), ids:new Set()};       // 꾸밈음: 주음 id → [꾸밈음들], 꾸밈음 id 모음
const needsReview = n => n.c < S.minConf && !n.ok;
const byId = id => S.notes.find(n => n.id === id);

/* ---------- 박 찾기: 템포 추정 + 박 추적(동적계획법) ---------- */
const EFS = 100;               // 박 추적용 시간 해상도 (초당 100칸)
const TIGHT = 100;             // 템포가 갑자기 바뀌는 것을 얼마나 막을지
let ENV = new Float32Array(1), BEATS = [0, 0.6], DEV_BEATS = null;
function onsetEnvelope(){
  const N = Math.ceil((Math.max(S.duration, lastNoteEnd()) + 3) * EFS);
  const raw = new Float32Array(N);
  for (const n of S.notes){ if (!visible(n)) continue; const i = Math.round(n.t*EFS); if (i>=0 && i<N) raw[i] += 0.3 + n.v/127; }
  const k=[0.06,0.24,0.4,0.24,0.06], out=new Float32Array(N);
  for (let i=0;i<N;i++){ let s=0; for (let j=-2;j<=2;j++){ const x=i+j; if (x>=0 && x<N) s+=raw[x]*k[j+2]; } out[i]=s; }
  return out;
}
function estimateTempo(env){
  const sc=[]; let bestLag=60, best=-1;
  for (let lag=25; lag<=150; lag++){
    let s=0; for (let i=0;i+lag<env.length;i++) s+=env[i]*env[i+lag];
    const bpm=6000/lag, w=Math.exp(-0.5*Math.pow(Math.log2(bpm/110)/0.9,2));
    sc[lag]=s*w; if (sc[lag]>best){ best=sc[lag]; bestLag=lag; }
  }
  if (best <= 0) return 100;                       // 음이 없으면 템포를 알 수 없다
  let lag=bestLag;
  if (sc[lag-1]!==undefined && sc[lag+1]!==undefined){ const a=sc[lag-1], b=sc[lag], c=sc[lag+1], den=a-2*b+c; if (den<0) lag += 0.5*(a-c)/den; }
  return clamp(Math.round(6000/lag), 40, 200);
}
function trackBeats(){
  const spb = 60/S.bpm, end = Math.max(S.duration, lastNoteEnd()) + 2*spb;
  const uniform = () => { BEATS=[]; for (let t=S.offset; t<=end || BEATS.length<2; t+=spb) BEATS.push(t); };
  if (DEV_BEATS){ BEATS = DEV_BEATS.slice(); let l=BEATS[BEATS.length-1]; while (l < end){ l += spb; BEATS.push(l); } return; }   // 점검용: 밖에서 준 박
  if (!S.follow){ uniform(); return; }
  const env=ENV, N=env.length, P=spb*EFS, a0=clamp(Math.round(S.offset*EFS),0,N-1);
  let mean=0; for (let i=0;i<N;i++) mean+=env[i]; mean/=N;
  let sd=0; for (let i=0;i<N;i++) sd+=(env[i]-mean)**2; sd=Math.sqrt(sd/N)||1;
  const score=new Float32Array(N).fill(-1e9), back=new Int32Array(N).fill(-1);
  score[a0]=env[a0]/sd;
  const lo=Math.max(1,Math.round(P*0.5)), hi=Math.round(P*2);
  for (let t=a0+lo; t<N; t++){
    let best=-1e9, bi=-1;
    for (let u=Math.max(a0,t-hi); u<=t-lo; u++){
      const s=score[u]; if (s<-1e8) continue;
      const d=Math.log((t-u)/P), v=s-TIGHT*d*d;
      if (v>best){ best=v; bi=u; }
    }
    if (bi>=0){ score[t]=best+env[t]/sd; back[t]=bi; }
  }
  let lastOn=a0; for (const n of S.notes) if (visible(n)) lastOn=Math.max(lastOn, Math.round(n.t*EFS));
  let e=-1, eb=-1e9;
  for (let t=Math.max(a0,lastOn-Math.round(P)); t<=Math.min(N-1,lastOn+Math.round(P)); t++) if (score[t]>eb){ eb=score[t]; e=t; }
  const fr=[]; while (e>=0){ fr.push(e); if (e===a0) break; e=back[e]; }
  if (!fr.length || fr[fr.length-1]!==a0){ uniform(); return; }
  BEATS = fr.reverse().map(f => f/EFS);
  let last = BEATS[BEATS.length-1];
  while (last < end || BEATS.length<2){ last += spb; BEATS.push(last); }
}
function beatPos(t){
  const B=BEATS, n=B.length;
  if (t < B[0]) return (t-B[0])/(B[1]-B[0]);
  if (t >= B[n-1]) return n-1 + (t-B[n-1])/(B[n-1]-B[n-2]);
  let lo=0, hi=n-1; while (hi-lo>1){ const m=(lo+hi)>>1; if (B[m]<=t) lo=m; else hi=m; }
  return lo + (t-B[lo])/(B[lo+1]-B[lo]);
}
function timeAt(bp){
  const B=BEATS, n=B.length;
  if (bp < 0) return B[0] + bp*(B[1]-B[0]);
  if (bp >= n-1) return B[n-1] + (bp-n+1)*(B[n-1]-B[n-2]);
  const i=Math.floor(bp); return B[i] + (bp-i)*(B[i+1]-B[i]);
}
function avgTempo(){
  const lastBeat = beatPos(lastNoteEnd()), k = clamp(Math.floor(lastBeat), 1, BEATS.length-1);
  return Math.round(60*k/(BEATS[k]-BEATS[0]));
}

/* ---------- 분석: 박에 맞추기 → 마디 나누기 ---------- */
const TPB = 24;                                   // 한 박 = 24틱 (2·3·4·8 분할 모두 정수)
const T8 = TPB/2, T16 = TPB/4, T32 = TPB/8, TR = TPB/3;   // 8분, 16분, 32분, 셋잇단 8분음표
const gridTicks = () => S.grid*TPB/12;             // 설정값(가장 짧은 음표, 쉼표 채우기)은 1박 = 12 단위로 저장돼 있다
const CHORD_TOGETHER = 0.05;                       // 이 시간(초) 안에 시작한 음은 함께 친 화음으로 본다
const BPMEAS = {'4/4':4,'3/4':3,'2/4':2,'6/8':3};
let A = null;

// 지속 페달을 밟고 있는 동안 뗀 음은 페달을 뗄 때까지 울린다
function pedalEnd(n){
  const off = n.t+n.d;
  for (const e of S.pedals) if (e.type==='sustain' && off>=e.t && off<e.t+e.d) return e.t+e.d;
  return off;
}
// 음 길이 쓰는 방식: 'key' = 건반을 누른 길이대로, 'sound' = 페달로 울리는 만큼 길게
const keyLen = () => S.noteLen !== 'sound';
const soundingEnd = n => keyLen() ? n.t+n.d : pedalEnd(n);

/* 꾸밈음: 아주 짧은 음이 같은 손의 더 긴 음 바로 앞에 가까운 음높이로 붙어 있으면 꾸밈음으로 본다.
 * 짧은 음이 2~3개 이어진 뒤 주음이 오면 꾸밈음 묶음으로 본다. */
const GRACE_DUR = 0.13, GRACE_GAP = 0.15, GRACE_STEP = 4;
function findGraces(vis){
  const main = new Map(), ids = new Set();
  if (!S.graces) return {main, ids};
  for (const h of ['R','L']){
    const ns = vis.filter(n => handOf(n)===h).sort((a,b) => a.t-b.t || a.p-b.p);
    for (let i=0; i<ns.length; i++){
      const g = ns[i];
      if (g.d > GRACE_DUR || g.noGrace || ids.has(g.id)) continue;
      // 빠른 런의 중간 음은 꾸밈음이 아니다 (바로 앞에도 짧은 음이 가까운 음높이로 붙어 있다)
      let k = i-1; while (k>=0 && ns[k].t > g.t-0.025) k--;
      const pv = ns[k];
      if (pv && g.t-pv.t <= GRACE_GAP && Math.abs(g.p-pv.p) <= GRACE_STEP && pv.d <= GRACE_DUR*1.5) continue;
      const beat = timeAt(beatPos(g.t)+1) - timeAt(beatPos(g.t));
      const maxGap = Math.min(GRACE_GAP, beat*0.2);   // 16분음표보다 확실히 빠른 것만
      const chain = [g]; let cur = g, found = null;
      for (let j=i+1; j<ns.length && chain.length<=3; j++){
        const m = ns[j], gap = m.t-cur.t;
        if (gap < 0.025) continue;                     // 같이 친 화음
        if (gap > maxGap || Math.abs(m.p-cur.p) > GRACE_STEP) break;
        if (m.d >= Math.max(0.15, 2*g.d)){ found = m; break; }
        if (m.d > GRACE_DUR || m.noGrace) break;
        chain.push(m); cur = m;
      }
      if (!found || g.noGrace) continue;
      chain.forEach(x => ids.add(x.id));
      main.set(found.id, chain);
    }
  }
  return {main, ids};
}

/* 양손 판정용: 음마다 악보에서 들어갈 박자 칸(g)을 붙인다 (같은 칸의 음은 한 화음으로 그려진다) */
const slots = ns => ns.map(n => ({id:n.id, p:n.p, t:n.t, g:Math.round(beatPos(n.t)*TPB/gridTicks())}));

function compute(){
  ENV = onsetEnvelope(); trackBeats();
  const vis = S.notes.filter(visible);
  AUTOHAND = S.handMode==='auto' && window.ScoreHands ? ScoreHands.assign(slots(vis), S.split) : new Map();
  GRACE = findGraces(vis);
  const G = gridTicks();
  // 함께 친 음(시작이 50ms 안)은 박자 칸에 맞추기 전에 한 묶음으로 만들어 같은 위치에 둔다.
  // 따로 맞추면 칸 경계 근처에서 한 음은 앞 칸, 다른 음은 뒤 칸으로 가서 화음이 쪼개진다.
  const onsetOf = new Map(), sorted = vis.filter(n => !GRACE.ids.has(n.id)).sort((a,b) => a.t-b.t);
  for (let i=0; i<sorted.length;){
    let j = i+1; while (j<sorted.length && sorted[j].t - sorted[i].t < CHORD_TOGETHER) j++;
    const group = sorted.slice(i, j), t = group.reduce((s,n) => s+n.t, 0)/group.length;
    group.forEach(n => onsetOf.set(n.id, t));
    i = j;
  }
  const qs = sorted.map(n => {
    const tick = beatPos(onsetOf.get(n.id))*TPB, endTick = beatPos(soundingEnd(n))*TPB, keyUpTick = beatPos(n.t+n.d)*TPB;
    return {n, h:handOf(n), tick, endTick, keyUpTick, playTick:beatPos(pedalEnd(n))*TPB, qS:Math.round(tick/G)*G, qT:Math.round(tick/TR)*TR, q32:Math.round(tick/T32)*T32, beat:Math.floor((tick+TPB/6)/TPB)};
  });
  const trip = {R:new Set(), L:new Set()};
  if (S.triplet && G < TPB){
    for (const h of ['R','L']){
      const by = new Map();
      qs.forEach(q => { if (q.h!==h) return; if (!by.has(q.beat)) by.set(q.beat,[]); by.get(q.beat).push(q); });
      by.forEach((arr,b) => {
        // 셋잇단 자리(⅓, ⅔ 박)에 음이 두 개 이상 정확히 있고, 셋잇단으로 볼 때 오차가 절반 이하일 때만
        const onTrip = arr.filter(q => { const r=((q.qT%TPB)+TPB)%TPB; return (r===TR||r===2*TR) && Math.abs(q.tick-q.qT)<TPB/12; }).length;
        if (onTrip < 2) return;
        let eS=0, eT=0; arr.forEach(q => { eS+=Math.abs(q.tick-q.qS); eT+=Math.abs(q.tick-q.qT); });
        if (eT < eS*0.5) trip[h].add(b);
      });
    }
  }
  // 32분음표: 16분음표 칸에 따로 친 음이 몰리고, 32분음표 칸으로 나누면 더 갈라질 때만 그 박을 32분음표로 쓴다 (빠른 런)
  const fast = {R:new Set(), L:new Set()};
  if (G <= T16){
    for (const h of ['R','L']){
      const by = new Map();
      qs.forEach(q => { if (q.h!==h) return; if (!by.has(q.beat)) by.set(q.beat,[]); by.get(q.beat).push(q); });
      by.forEach((arr,b) => {
        const cl = [...new Map(arr.map(q => [onsetOf.get(q.n.id), q])).values()];   // 따로 친 묶음마다 하나
        const n16 = new Set(cl.map(q => q.qS)).size, n32 = new Set(cl.map(q => q.q32)).size;
        if (n16 < cl.length && n32 > n16){ fast[h].add(b); trip[h].delete(b); }
      });
    }
  }
  const EG = keyLen() ? Math.max(G, T8) : G;         // 누른 길이대로 쓸 때는 음 끝을 8분음표 단위로 (자잘한 쉼표를 줄인다)
  qs.forEach(q => {
    q.trip = trip[q.h].has(q.beat); q.fast = fast[q.h].has(q.beat);
    q.start = Math.max(0, q.trip ? q.qT : q.fast ? q.q32 : q.qS);
    if (q.trip){
      const e3 = Math.round(q.endTick/TR)*TR;
      q.end = e3 <= (q.beat+1)*TPB ? Math.max(q.start+TR, e3) : Math.max(q.start+TR, Math.round(q.endTick/G)*G);
    } else if (q.fast){
      const e32 = Math.round(q.endTick/T32)*T32;
      q.end = e32 <= (q.beat+1)*TPB ? Math.max(q.start+T32, e32) : Math.max(q.start+T32, Math.round(q.endTick/EG)*EG);
    } else q.end = Math.max(q.start+G, Math.round(q.endTick/EG)*EG);
    q.keyUp = Math.max(q.start+(q.fast ? T32 : G), Math.round(q.keyUpTick/G)*G);   // 페달과 상관없이 실제로 건반을 뗀 때
  });

  // 같은 손에서 따로 친 음(50ms 넘게 떨어짐)이 같은 칸에 몰리면 한 화음으로 붙어 버린다.
  // 앞 음을 앞 칸으로, 또는 뒤 음을 뒤 칸으로 옮겨 순서를 살린다 (빈 칸이고, 옮긴 뒤 오차가 한 칸 안일 때만. 오차가 적은 쪽)
  const crowd = {before:0, after:0, left:[]};
  for (const h of ['R','L']){
    const byOnset = new Map();
    qs.forEach(q => { if (q.h!==h) return; const k = onsetOf.get(q.n.id); if (!byOnset.has(k)) byOnset.set(k, []); byOnset.get(k).push(q); });
    const cs = [...byOnset.entries()].sort((a,b) => a[0]-b[0]).map(([,g]) => ({g, tick:g[0].tick, start:g[0].start, step:g[0].trip ? TR : g[0].fast ? T32 : G}));
    const move = (c, to) => { c.start = to; c.g.forEach(q => { q.start = to; q.end = Math.max(q.end, to+c.step); q.keyUp = Math.max(q.keyUp, to+c.step); }); };
    const ok = (c, to) => to >= 0 && Math.abs(c.tick-to) < c.step && (Math.floor(to/TPB)===Math.floor(c.start/TPB) || to%TPB===0);
    for (let i=1; i<cs.length; i++){
      const a = cs[i-1], b = cs[i];
      if (b.start !== a.start) continue;
      crowd.before++;
      const prev = i>=2 ? cs[i-2].start : -Infinity, next = i+1<cs.length ? cs[i+1].start : Infinity;
      const aTo = a.start - a.step, bTo = b.start + b.step;
      const costA = aTo > prev && ok(a, aTo) ? Math.abs(a.tick-aTo) : Infinity;
      const costB = bTo < next && ok(b, bTo) ? Math.abs(b.tick-bTo) : Infinity;
      if (costA === Infinity && costB === Infinity){ crowd.after++; crowd.left.push({h, start:b.start, gap:b.g[0].n.t - a.g[0].n.t}); continue; }
      if (costA < costB) move(a, aTo); else move(b, bTo);
    }
  }

  // 성부: 같은 손이 음을 누르고 있는 동안 새 음을 치면 두 성부로 나눈다.
  // 누르고 있는 음이 그동안 친 음들보다 위에 있으면 위 성부(멜로디를 누른 채 아래가 움직임),
  // 아래에 있으면 아래 성부(베이스를 누른 채 위가 움직임). 위아래로 섞이면 오른손은 맨 위 음, 왼손은 맨 아래 음 기준.
  // 누르고 있는 음: 새 음보다 반 박 넘게 더, 전체로 한 박 이상 누른 음 (빠른 런에서 손가락을 살짝 늦게 떼는 것은 제외).
  // 같이 치고 같이 뗀 음은 한 화음으로 둔다 (그래야 성부가 엇갈리지 않는다).
  for (const h of ['R','L']){
    const mine = qs.filter(q => q.h===h);
    const over = q => q.keyUp - q.start >= TPB ? mine.filter(o => o.start > q.start && o.start <= q.keyUp - T8) : [];
    const side = new Map(), ovOf = new Map();
    mine.forEach(q => {
      q.v = 1;
      const ov = over(q); if (!ov.length) return;
      const ps = ov.map(o => o.n.p);
      ovOf.set(q, ov);
      side.set(q, q.n.p > Math.max(...ps) ? 'above' : q.n.p < Math.min(...ps) ? 'below' : 'mixed');
    });
    const lower = new Set();
    side.forEach((sd, q) => {
      const mates = mine.filter(o => o.start===q.start && o!==q);
      if (sd==='above'){
        ovOf.get(q).forEach(o => lower.add(o));
        mates.forEach(o => { if (o.n.p < q.n.p && side.get(o)!=='above') lower.add(o); });   // 같이 쳤지만 일찍 뗀 아래 음
      } else if (sd==='below') lower.add(q);
      else if (h==='R' ? mates.some(o => o.n.p > q.n.p) : !mates.some(o => o.n.p < q.n.p)) lower.add(q);
    });
    lower.forEach(q => q.v = 2);
    // 같은 순간 친 음 중 아래 성부 음보다 낮은 음은 아래 성부로 (성부가 위아래로 엇갈리지 않게)
    lower.forEach(q => mine.forEach(o => { if (o.start===q.start && o.n.p < q.n.p) o.v = 2; }));
  }
  const chordsOf = list => {
    const m = new Map();
    list.forEach(q => { let c=m.get(q.start);
      if (!c){ c={start:q.start, end:q.end, keyUp:q.keyUp, byP:new Map()}; m.set(q.start,c); }
      c.byP.set(q.n.p, q.n.id); c.end=Math.max(c.end,q.end); c.keyUp=Math.max(c.keyUp,q.keyUp); });
    return [...m.values()].sort((a,b) => a.start-b.start);
  };
  const ch = {};
  for (const h of ['R','L']){
    const mine = qs.filter(q => q.h===h);
    ch[h] = {all:chordsOf(mine), v1:chordsOf(mine.filter(q => q.v===1)), v2:chordsOf(mine.filter(q => q.v===2))};
  }
  const M = BPMEAS[S.ts]*TPB;
  const lastTick = Math.max(M, ...qs.map(q => q.end)), nMeas = Math.ceil(lastTick/M);
  const ends = {}, fill = (+S.fill || 6)*TPB/12;           // 이 길이(틱) 이하의 빈틈은 앞 음을 늘려 채운다 (쉼표 채우기 설정)
  for (const h of ['R','L']) ends[h] = {all:chordEnds(ch[h].all, trip[h], M, nMeas*M, fill), v1:chordEnds(ch[h].v1, trip[h], M, nMeas*M, fill), v2:chordEnds(ch[h].v2, trip[h], M, nMeas*M, fill)};
  const k = detectKey(), key = S.key==='auto' ? k.key : KEYS.find(x => x.id===S.key);
  const measures = [], clefNow = {R:'treble', L:'bass'};
  for (let i=0; i<nMeas; i++){
    const m0=i*M, m1=m0+M, meas = {index:i};
    for (const h of ['R','L']){
      // 두 성부: 이 마디에 멜로디와, 그 밑에서 누르고 있는 음이 둘 다 있을 때만 (앞 마디에서 이어지는 음도 친다)
      const active = (list, E) => list.some(c => c.start<m1 && E.get(c)>m0);
      const two = S.voices && active(ch[h].v1, ends[h].v1) && active(ch[h].v2, ends[h].v2);
      // 음자리표: 덧줄이 확실히 적어지는 쪽으로만 바꾸고, 필요하면 마디 중간(박 경계)에서 한 번 바꾼다
      const inMeasure = qs.filter(q => q.h===h && q.start>=m0 && q.start<m1).map(q => ({p:q.n.p, tick:q.start}));
      const clefs = inMeasure.length ? chooseClefs(inMeasure, clefNow[h], key.flats, m0, BPMEAS[S.ts])
                                     : {start:clefNow[h], change:null};
      clefNow[h] = clefs.change ? clefs.change.clef : clefs.start;
      let voices;
      if (two){
        const v1 = buildItems(ch[h].v1, ends[h].v1, trip[h], m0, m1), v2 = buildItems(ch[h].v2, ends[h].v2, trip[h], m0, m1);
        // 위 성부의 쉼표도 아래 성부가 소리 내는 동안이거나 한 박보다 짧으면 숨긴다 (음표와 겹치지 않게)
        v1.forEach(it => { if (!it.c && (it.e-it.s < TPB || v2.some(o => o.c && o.s < it.e && o.e > it.s))) it.ghost = true; });
        voices = [{items:v1, stem:1}, {items:v2, stem:-1, ghost:true}];
      } else voices = [{items:buildItems(ch[h].all, ends[h].all, trip[h], m0, m1), stem:0}];
      meas[h] = {clef:clefs.start, change:clefs.change, endClef:clefNow[h], voices};
    }
    measures.push(meas);
  }
  const result = [];
  qs.forEach(q => {
    const t=timeAt(q.start/TPB);   // 재생은 페달로 울리는 길이까지
    result.push({t, d:Math.max(0.05, timeAt(Math.max(q.end, q.playTick)/TPB)-t), p:q.n.p, v:q.n.v});
    (GRACE.main.get(q.n.id) || []).forEach(g => result.push({t:t-(q.n.t-g.t), d:g.d, p:g.p, v:g.v}));
  });
  A = {trip, fast, measures, M, crowd, auto:k, key, result: result.sort((a,b) => a.t-b.t)};
}

/* 음을 오선 위치(온음 단위, C0 = 0)로 */
const LETTER = {c:0, d:1, e:2, f:3, g:4, a:5, b:6};
const STAFF_LINES = {treble:{top:38, bottom:30}, bass:{top:26, bottom:18}};
const staffStep = (p, flats) => (Math.floor(p/12)-1)*7 + LETTER[(flats?VFL:VSH)[p%12][0]];
/* 이 음자리표로 쓸 때의 부담: 음높이마다 필요한 덧줄 수의 합(같은 음의 반복은 한 번만) + 가장 많은 덧줄 × 2 */
function clefCost(ps, clef, flats){
  const L = STAFF_LINES[clef]; let sum = 0, max = 0;
  for (const p of new Set(ps)){
    const s = staffStep(p, flats);
    const n = s > L.top+1 ? Math.floor((s-L.top)/2) : s < L.bottom-1 ? Math.floor((L.bottom-s)/2) : 0;
    sum += n; max = Math.max(max, n);
  }
  return sum + 2*max;
}
/* 한 마디의 음자리표: 그대로 / 마디 처음부터 바꾸기 / 마디 중간 박 경계에서 한 번 바꾸기 중 부담이 가장 적은 것.
 * 바꾸는 데도 부담을 매겨 마디마다 오가지 않게 한다. notes: [{p, tick}] */
const CLEF_SWITCH_COST = 3, CLEF_MID_COST = 4;
function chooseClefs(notes, prev, flats, m0, beats){
  const other = c => c==='treble' ? 'bass' : 'treble';
  const cost = (arr, c) => clefCost(arr.map(x => x.p), c, flats);
  let best = {start:prev, change:null, cost:cost(notes, prev)};
  const whole = cost(notes, other(prev)) + CLEF_SWITCH_COST;
  if (whole < best.cost) best = {start:other(prev), change:null, cost:whole};
  for (const c0 of ['treble','bass']) for (let k=1; k<beats; k++){
    const t = m0 + k*TPB, a = notes.filter(x => x.tick < t), b = notes.filter(x => x.tick >= t);
    if (!a.length || !b.length) continue;
    const c = cost(a,c0) + cost(b,other(c0)) + CLEF_MID_COST + (c0!==prev ? CLEF_SWITCH_COST : 0);
    if (c < best.cost) best = {start:c0, change:{tick:t, clef:other(c0)}, cost:c};
  }
  return best;
}
const clefAt = (staff, tick) => staff.change && tick >= staff.change.tick ? staff.change.clef : staff.clef;

/* 화음에 딸린 꾸밈음들 (그 화음의 첫 조각에만 붙인다) */
function gracesOf(c){
  const out = [];
  for (const id of c.byP.values()) (GRACE.main.get(id) || []).forEach(g => { if (!out.includes(g)) out.push(g); });
  return out.sort((a,b) => a.t-b.t || a.p-b.p);
}
function graceAccidental(p, key){
  const scale = [0,2,4,5,7,9,11].map(x => (x+key.pc)%12);
  if (scale.includes(p%12)) return null;
  const name = (key.flats?VFL:VSH)[p%12];
  return name.includes('#') ? '#' : name.includes('b') ? 'b' : 'n';
}

/* 한 성부의 화음마다 악보에 쓸 끝 틱. 마디선을 넘으면 다음 마디로 붙임줄로 이어진다 (Map: 화음 → 끝 틱) */
function chordEnds(chs, trip, M, endTick, fill){
  const snapEnd = e => (trip.has(Math.floor(e/TPB)) && e%TPB) ? Math.round(e/TR)*TR : e;
  const ends = new Map();
  chs.forEach((c,i) => {
    const nxt = i+1<chs.length ? chs[i+1].start : endTick, bar = Math.min(nxt, (Math.floor(c.start/M)+1)*M);
    let e = Math.min(c.end, nxt);
    if (nxt-e <= fill) e = nxt;                  // 조금 일찍 뗀 음은 다음 음까지 이어 붙임
    else if (e < bar && bar-e <= fill) e = bar;  // 다음 음이 멀면 마디선까지만
    // 셋잇단 박 안에서 실제로 뗀 음은 페달·빈틈 채우기로 박을 넘겨 늘리지 않는다 (붙임줄 + 같은 음 재타건이 생긴다)
    const b0 = Math.floor(c.start/TPB);
    if (trip.has(b0) && c.keyUp <= (b0+1)*TPB + TPB/6) e = Math.min(e, (b0+1)*TPB);
    e = snapEnd(e);
    if (e <= c.start) e = Math.min(nxt, c.start + (trip.has(b0) ? TR : T16));
    ends.set(c, Math.min(e, endTick));
  });
  return ends;
}

function buildItems(chs, ends, trip, m0, m1){
  const cuts = [m0,m1];
  trip.forEach(b => { const s=b*TPB; if (s>=m0 && s<m1) cuts.push(s, s+TPB); });
  const cutArr = [...new Set(cuts)].sort((a,b) => a-b);
  const items = [];
  // last: 마디선을 넘어서까지 포함한 진짜 끝. 거기에 못 미쳐 끊긴 조각은 붙임줄로 잇는다
  const push = (s,e,c,last=e) => { while (s<e){ const cut=Math.min(e, cutArr.find(x => x>s)); items.push({s, e:cut, c, tie:!!c && cut<last}); s=cut; } };
  let pos = m0;
  const carry = chs.find(c => c.start < m0 && ends.get(c) > m0);   // 앞 마디에서 이어지는 음
  if (carry){
    const e = Math.min(ends.get(carry), m1), k = items.length;
    push(m0, e, carry, ends.get(carry)); items[k].cont = true; pos = e;
  }
  chs.filter(c => c.start>=m0 && c.start<m1).forEach(c => {
    if (c.start > pos) push(pos, c.start, null);
    const e = Math.min(ends.get(c), m1);
    push(c.start, e, c, ends.get(c));
    pos = e;
  });
  if (pos < m1) push(pos, m1, null);
  return items;
}

/* 한 항목을 그릴 음표 길이들로 쪼갠다: [{d:'qd', ticks, trip}] */
const STRAIGHT = [[96,'w'],[72,'hd'],[48,'h'],[36,'qd'],[24,'q'],[18,'8d'],[12,'8'],[9,'16d'],[6,'16'],[3,'32']];
function pieces(it, trip){
  const L = it.e-it.s, inTrip = trip.has(Math.floor(it.s/TPB)) && L<TPB && L%TR===0, out=[];
  if (inTrip){ let r=L; while (r>=2*TR){ out.push({d:'q', ticks:2*TR, trip:true}); r-=2*TR; } while (r>=TR){ out.push({d:'8', ticks:TR, trip:true}); r-=TR; } }
  else {
    const fill = r => { for (const [t,d] of STRAIGHT) while (r>=t){ out.push({d, ticks:t, trip:false}); r-=t; } };
    // 한 음표로 못 쓰는 길이면 박 경계에서 끊는다 (붙임줄이 박 경계에 오게)
    const head = it.s%TPB && !STRAIGHT.some(([t]) => t===L) ? Math.min(L, TPB - it.s%TPB) : 0;
    fill(head); fill(L-head);
  }
  return out;
}

/* ---------- 악보 그리기 (VexFlow) ---------- */
const ink = n => getComputedStyle(document.documentElement).getPropertyValue(n).trim();
let PLAIN = false;                                 // PDF용: 색 표시 없이
let layout = [], hitboxes = [];

// 쉼표 높이: 위 성부는 위쪽, 아래 성부는 아래쪽에 둔다
const REST_KEY = {treble:{0:'b/4', 1:'e/5', '-1':'f/4'}, bass:{0:'d/3', 1:'g/3', '-1':'a/2'}};

function makeNote(c, d, clef, key, stem=0, ghost=false){
  const rest = !c;
  if (rest && ghost){ const g = new VF.GhostNote({duration:d}); g.__ghost = true; return g; }   // 아래 성부의 쉼표는 숨긴다
  const ps = rest ? null : [...c.byP.keys()].sort((a,b) => a-b);
  const keys = rest ? [REST_KEY[clef][stem]] : ps.map(p => vfKey(p, key.flats));
  const opts = {keys, duration:d+(rest?'r':''), clef};
  if (!rest){ if (stem) opts.stem_direction = stem; else opts.auto_stem = true; }
  const sn = new VF.StaveNote(opts);
  if (d.indexOf('d') > 0){ if (VF.Dot.buildAndAttach) VF.Dot.buildAndAttach([sn],{all:true}); else if (sn.addDotToAll) sn.addDotToAll(); }
  if (!rest && !PLAIN) ps.forEach((p,i) => {
    const n = byId(c.byP.get(p)); let col = null;
    if (n && n.id===S.sel) col = ink('--paper-sel'); else if (n && needsReview(n)) col = ink('--paper-warn');
    if (col) sn.setKeyStyle(i, {fillStyle:col, strokeStyle:col});
  });
  return sn;
}

/* staff: {clef, change} — 마디 중간에 음자리표가 바뀌면 그 뒤 음표는 새 음자리표로 그린다.
 * showClef: 이 성부에 바뀌는 자리의 작은 음자리표를 넣을지 (보표당 한 성부만) */
function buildVoice(items, staff, trip, key, ts, stem=0, ghost=false, showClef=false){
  const notes=[], tiePairs=[], groups=[], runs=[[]], hits=[];
  let curTrip=-1, tieFrom=null, tieIn=null, clefShown=false;
  for (const it of items){
    const b = Math.floor(it.s/TPB), ps = pieces(it, trip), clef = clefAt(staff, it.s);
    if (showClef && staff.change && !clefShown && it.s >= staff.change.tick){
      notes.push(new VF.ClefNote(staff.change.clef, 'small'));
      clefShown = true; curTrip = -1; runs.push([]);
    }
    ps.forEach((pc,k) => {
      const sn = makeNote(it.c, pc.d, clef, key, stem, (ghost || it.ghost) && !pc.trip);
      if (k===0 && it.c && it.s===it.c.start){
        const gs = gracesOf(it.c);
        if (gs.length){
          const gn = gs.map(g => {
            const n = new VF.GraceNote({keys:[vfKey(g.p, key.flats)], duration:gs.length>1?'16':'8', slash:gs.length===1, clef});
            const acc = graceAccidental(g.p, key); if (acc) n.addModifier(new VF.Accidental(acc), 0);
            return n;
          });
          const group = new VF.GraceNoteGroup(gn, true);
          if (gn.length>1) group.beamNotes();
          sn.addModifier(group, 0);
        }
      }
      if (tieFrom && it.c) tiePairs.push([tieFrom, sn]);
      if (k===0 && it.cont) tieIn = sn;
      tieFrom = it.c && (k<ps.length-1 || it.tie) ? sn : null;
      notes.push(sn);
      if (it.c) hits.push({sn, c:it.c});
      if (pc.trip){ if (curTrip!==b){ curTrip=b; groups.push([]); runs.push([]); } groups[groups.length-1].push(sn); }
      else if (sn.__ghost){ curTrip=-1; runs.push([]); }   // 숨긴 쉼표는 빔을 끊는다
      else { if (curTrip!==-1){ curTrip=-1; runs.push([]); } runs[runs.length-1].push(sn); }
    });
  }
  const tuplets = groups.filter(g => g.length).map(g => new VF.Tuplet(g, {num_notes:3, notes_occupied:2, location: stem<0 ? -1 : 1}));
  const beamGroups = ts==='6/8' ? [new VF.Fraction(3,8)] : [new VF.Fraction(2,8)];
  const beamOpts = stem ? {groups:beamGroups, stem_direction:stem} : {groups:beamGroups};
  const beams = [];
  runs.forEach(r => { if (r.length>1) beams.push(...VF.Beam.generateBeams(r, beamOpts)); });
  groups.forEach(g => { if (g.length>1 && g.every(n => !n.isRest() && n.getDuration()==='8')) beams.push(new VF.Beam(g)); });
  const [num,den] = ts.split('/').map(Number);
  const voice = new VF.Voice({num_beats:num, beat_value:den});
  voice.setMode(VF.Voice.Mode.SOFT);
  voice.addTickables(notes);
  const ties = tiePairs.map(([a,b]) => new VF.StaveTie({first_note:a, last_note:b,
    first_indices:a.getKeys().map((_,i)=>i), last_indices:b.getKeys().map((_,i)=>i)}));
  // tieIn: 앞 마디에서 이어 온 첫 음표, tieOut: 다음 마디로 이어지는 마지막 음표 (마디를 넘는 붙임줄은 drawScore가 긋는다)
  return {voice, beams, tuplets, ties, hits, tieIn, tieOut:tieFrom};
}

/* 음이 오선 밖으로 얼마나 나가는지(px): 위쪽, 아래쪽. 음자리표마다 오선의 맨 위·아래 줄 위치가 다르다 */
function staffReach(m, h, flats){
  let above = 0, below = 0;
  for (const v of m[h].voices) for (const it of v.items){
    if (!it.c) continue;
    const lines = STAFF_LINES[clefAt(m[h], it.s)];
    for (const p of [...it.c.byP.keys(), ...gracesOf(it.c).map(g => g.p)]){
      const step = staffStep(p, flats);
      above = Math.max(above, (step-lines.top)*5); below = Math.max(below, (lines.bottom-step)*5);
    }
  }
  return {above, below};
}

/* 줄마다 보표 위치를 정한다. 음이 오선 밖으로 많이 나가는 줄은 그만큼 위·사이·아래를 넓혀 겹치지 않게 한다.
 * lines: [[마디, …], …] */
function systemLayout(lines, flats){
  const out = []; let cursor = 6;
  for (const ms of lines){
    const r = ms.map(m => staffReach(m,'R',flats)), l = ms.map(m => staffReach(m,'L',flats));
    const aboveR = Math.max(0, ...r.map(x => x.above)), belowR = Math.max(0, ...r.map(x => x.below));
    const aboveL = Math.max(0, ...l.map(x => x.above)), belowL = Math.max(0, ...l.map(x => x.below));
    const yT = cursor + Math.max(0, aboveR + 34 - 40);         // 오선 맨 윗줄은 yT+40에 그려진다. 34는 기둥·빔·셋잇단 자리
    const gap = Math.max(50, belowR + aboveL + 56);              // 오른손 맨 아랫줄 ~ 왼손 맨 윗줄
    const yB = yT + 40 + gap;
    out.push({yT, yB});
    cursor = yB + 80 + belowL + 30;
  }
  return {systems: out, height: cursor + 6};
}

/* 한 마디의 성부들을 만든다 (그리기 전에 폭을 재는 데도 쓴다) */
function buildMeasure(m, key, ts){
  const staffVoices = h => m[h].voices.map((v,idx) => buildVoice(v.items, m[h], A.trip[h], key, ts, v.stem, v.ghost, idx===0));
  const vR = staffVoices('R'), vL = staffVoices('L');
  VF.Accidental.applyAccidentals(vR.map(v => v.voice), key.id);   // 같은 보표의 두 성부는 임시표를 함께 따진다
  VF.Accidental.applyAccidentals(vL.map(v => v.voice), key.id);
  const fmt = new VF.Formatter(); fmt.joinVoices(vR.map(v => v.voice)); fmt.joinVoices(vL.map(v => v.voice));
  return {vR, vL, fmt};
}

/* 마디마다 음표가 겹치지 않는 최소 폭을 재고, 그 폭으로 한 줄에 들어가는 만큼 마디를 담는다 */
const LINE_HEAD = 74, TIME_SIG_W = 28, CLEF_CHANGE_W = 24, MIN_MEASURE_W = 110;
function measureNeeds(meas, key, ts){
  return meas.map(m => {
    const b = buildMeasure(m, key, ts);
    // VexFlow의 최소 폭은 넉넉하게 잡힌 값이라 7할이면 음표가 겹치지 않는다. 꾸밈음 폭은 덜 들어가 따로 더한다
    const min = b.fmt.preCalculateMinTotalWidth([...b.vR, ...b.vL].map(v => v.voice));
    let graces = 0;
    for (const h of ['R','L']) for (const v of m[h].voices) for (const it of v.items) if (it.c && it.s===it.c.start) graces += gracesOf(it.c).length;
    return Math.max(MIN_MEASURE_W, min*0.7 + 32 + 18*graces);
  });
}
function headOf(m, lineStart){
  const prev = A.measures[m.index-1];
  if (lineStart) return LINE_HEAD + (m.index===0 ? TIME_SIG_W : 0);
  return (prev && (prev.R.endClef!==m.R.clef || prev.L.endClef!==m.L.clef) ? CLEF_CHANGE_W : 0)
       + (m.R.change || m.L.change ? CLEF_CHANGE_W : 0);   // 마디 중간 음자리표 자리
}
function breakLines(meas, needs, usable, maxPer){
  const lines = []; let cur = [], used = 0;
  meas.forEach((m,k) => {
    if (cur.length &&(used + needs[k] + headOf(m, false) > usable || cur.length >= maxPer)){ lines.push(cur); cur = []; used = 0; }
    cur.push({m, need:needs[k]}); used += needs[k] + headOf(m, cur.length===1);
  });
  if (cur.length) lines.push(cur);
  return lines;
}

function drawScore(box, W, meas, maxPer){
  const key = A.key, ts = S.ts, total = A.measures.length;
  const left=34, right=6, usable=W-left-right;
  maxPer = maxPer || clamp(Math.floor(usable/150), 1, 6);
  const lines = breakLines(meas, measureNeeds(meas, key, ts), usable, maxPer);
  const L = systemLayout(lines.map(line => line.map(e => e.m)), key.flats);
  const r = new VF.Renderer(box, VF.Renderer.Backends.SVG); r.resize(W, L.height);
  const ctx = r.getContext();
  const lay = [], hits = [];
  let carry = null;                                // 앞 마디에서 다음 마디로 이어지는 음표들 {i, R:[], L:[]}
  lines.forEach((line, sys) => {
    const heads = line.map((e,k) => headOf(e.m, k===0));
    const sumNeed = line.reduce((s,e) => s+e.need, 0), free = usable - heads.reduce((s,h) => s+h, 0);
    let stretch = free/sumNeed;
    if (sys===lines.length-1) stretch = Math.min(stretch, 1.4);  // 마디가 적은 마지막 줄은 너무 늘이지 않는다
    let x = left;
    line.forEach((e,col) => {
      const w = heads[col] + e.need*stretch;
      drawMeasure(e.m, x, w, col, col===line.length-1, L.systems[sys]);
      x += w;
    });
  });
  return {lay, hits};

  // 마디를 넘는 붙임줄: 같은 줄이면 두 음표를 잇고, 줄이 바뀌면 줄 끝·줄 처음에 반쪽씩 긋는다
  function crossTies(i, vR, vL, col, lineEnd){
    const tie = (a, b, ia, ib) => new VF.StaveTie({first_note:a, last_note:b, first_indices:ia, last_indices:ib}).setContext(ctx).draw();
    const all = sn => sn.getKeys().map((_,k) => k);
    const outs = {R:vR.map(v => v.tieOut).filter(Boolean), L:vL.map(v => v.tieOut).filter(Boolean)};
    for (const [h, vs] of [['R',vR], ['L',vL]]) for (const b of vs.map(v => v.tieIn).filter(Boolean)){
      if (col===0 || !carry || carry.i!==i-1){ tie(null, b, all(b), all(b)); continue; }
      const kb = b.getKeys();
      for (const a of carry[h]){
        const ia = [], ib = [];
        a.getKeys().forEach((key,k) => { const j = kb.indexOf(key); if (j>=0){ ia.push(k); ib.push(j); } });
        if (ia.length) tie(a, b, ia, ib);
      }
    }
    if (lineEnd){ for (const a of [...outs.R, ...outs.L]) tie(a, null, all(a), all(a)); carry = null; }
    else carry = {i, ...outs};
  }

  function drawMeasure(m, x, w, col, lineEnd, {yT, yB}){
    const i = m.index;
    const sT = new VF.Stave(x,yT,w), sB = new VF.Stave(x,yB,w), prev = A.measures[i-1];
    if (col===0){ sT.addClef(m.R.clef).addKeySignature(key.id); sB.addClef(m.L.clef).addKeySignature(key.id);
      if (i===0){ sT.addTimeSignature(ts); sB.addTimeSignature(ts); } }
    else {   // 줄 중간에서 음자리표가 바뀌면 마디 앞에 작게 쓴다
      if (prev && prev.R.endClef!==m.R.clef) sT.addClef(m.R.clef, 'small');
      if (prev && prev.L.endClef!==m.L.clef) sB.addClef(m.L.clef, 'small');
    }
    if (i===total-1){ try { const BT = VF.BarlineType || VF.Barline.type; sT.setEndBarType(BT.END); sB.setEndBarType(BT.END); } catch(e){} }
    const sx = Math.max(sT.getNoteStartX(), sB.getNoteStartX()); sT.setNoteStartX(sx); sB.setNoteStartX(sx);
    sT.setContext(ctx).draw(); sB.setContext(ctx).draw();
    if (col===0){ new VF.StaveConnector(sT,sB).setType('brace').setContext(ctx).draw(); new VF.StaveConnector(sT,sB).setType('singleLeft').setContext(ctx).draw(); }
    new VF.StaveConnector(sT,sB).setType(i===total-1 ? 'boldDoubleRight' : 'singleRight').setContext(ctx).draw();
    if (PLAIN && col===0 && i>0){ ctx.save(); ctx.setFont('Arial', 10); ctx.setFillStyle('#777777'); ctx.fillText(String(i+1), x, yT+28); ctx.restore(); }
    const {vR, vL, fmt} = buildMeasure(m, key, ts);   // 폭을 잴 때 쓴 것과 별개로 새로 만든다 (VexFlow 객체는 한 번만 배치할 수 있다)
    fmt.format([...vR, ...vL].map(v => v.voice), Math.max(40, sT.getNoteEndX()-sx-14));
    vR.forEach(v => v.voice.draw(ctx,sT)); vL.forEach(v => v.voice.draw(ctx,sB));
    [...vR, ...vL].forEach(v => {
      v.beams.forEach(b => b.setContext(ctx).draw());
      v.tuplets.forEach(t => t.setContext(ctx).draw());
      v.ties.forEach(t => t.setContext(ctx).draw());
      v.hits.forEach(({sn,c}) => { try { const bb=sn.getBoundingBox(); hits.push({x:bb.getX(), y:bb.getY(), w:bb.getW(), h:bb.getH(), c}); } catch(e){} });
    });
    crossTies(i, vR, vL, col, lineEnd);
    lay.push({i, x, y:yT+26, w, h:(yB+86)-(yT+26)});
  }
}

function renderScore(){
  const host = $('#score');
  if (!VF){ host.innerHTML = '<p class="score-fail">악보 엔진(VexFlow)을 불러오지 못했습니다.</p>'; return; }
  host.innerHTML = '';
  const box = document.createElement('div'); host.appendChild(box);
  const out = drawScore(box, Math.max(300, host.clientWidth), A.measures);
  layout = out.lay; hitboxes = out.hits;
  layout.forEach(L => {
    const d = document.createElement('div'); d.className='mbox';
    d.style.cssText = `left:${L.x}px;top:${L.y}px;width:${L.w}px;height:${L.h}px`;
    d.innerHTML = `<span class="mnum">${L.i+1}</span>`; host.appendChild(d); L.el = d;
  });
  lastMeasure = -1;
}
let scoreTimer = 0;
function scheduleScore(){
  clearTimeout(scoreTimer);
  scoreTimer = setTimeout(() => { try { renderScore(); } catch(e){ console.error(e); } }, A && A.measures.length>40 ? 150 : 50);
}

/* ---------- 내보내기 ---------- */
// A4에 폭 760px로 그리면 한 쪽에 약 1100px, 제목이 있는 첫 쪽은 약 1040px가 들어간다
const PAGE_H = 1100, FIRST_PAGE_H = 1040;
function printPages(){
  const host=$('#printHost'), W=760, maxPer=4, all=A.measures, pages=[];
  PLAIN = true;
  try {
    // 줄 나누기를 먼저 정하고, 줄을 하나씩 더해 가며 쪽에 들어가는 만큼만 담는다
    const lines = breakLines(all, measureNeeds(all, A.key, S.ts), W-40, maxPer).map(line => line.map(e => e.m));
    let start = 0;
    while (start < lines.length){
      const limit = pages.length ? PAGE_H : FIRST_PAGE_H;
      let n = 1;
      while (start+n < lines.length && systemLayout(lines.slice(start, start+n+1), A.key.flats).height <= limit) n++;
      host.innerHTML=''; const box=document.createElement('div'); host.appendChild(box);
      drawScore(box, W, lines.slice(start, start+n).flat(), maxPer);
      pages.push(new XMLSerializer().serializeToString(box.querySelector('svg')));
      start += n;
    }
  } finally { PLAIN = false; host.innerHTML=''; }
  return pages;
}
const xmlEsc = s => String(s).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const XTYPE = {w:'whole',h:'half',q:'quarter','8':'eighth','16':'16th','32':'32nd'};
function xmlPitch(p, flats){
  const name=(flats?VFL:VSH)[p%12], alter = name.length>1 ? (name[1]==='#'?1:-1) : 0;
  return `<pitch><step>${name[0].toUpperCase()}</step>${alter?`<alter>${alter}</alter>`:''}<octave>${Math.floor(p/12)-1}</octave></pitch>`;
}
function partXml(items, trip, staff, voice, flats, ghost=false, change=null){
  let out='', tieOpen=false, clefDone=false;
  for (const it of items){
    if (change && !clefDone && it.s >= change.tick){ out += `<attributes>${clefXml(staff, change.clef)}</attributes>`; clefDone = true; }
    const ps = pieces(it, trip);
    ps.forEach((pc,k) => {
      const base = pc.d.replace('d',''), dot = pc.d.includes('d') ? '<dot/>' : '';
      const tm = pc.trip ? '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>' : '';
      const tail = `<voice>${voice}</voice><type>${XTYPE[base]}</type>${dot}`;
      if (!it.c){ out += `<note${ghost||it.ghost?' print-object="no"':''}><rest/><duration>${pc.ticks}</duration>${tail}${tm}<staff>${staff}</staff></note>`; tieOpen=false; return; }
      if (k===0 && it.s===it.c.start){
        const gs = gracesOf(it.c);
        gs.forEach(g => { out += `<note><grace${gs.length===1?' slash="yes"':''}/>${xmlPitch(g.p,flats)}<voice>${voice}</voice><type>${gs.length===1?'eighth':'16th'}</type><staff>${staff}</staff></note>`; });
      }
      const stop = tieOpen || (k===0 && !!it.cont), start = k<ps.length-1 || it.tie;
      const ties = (stop?'<tie type="stop"/>':'') + (start?'<tie type="start"/>':'');
      const tied = (stop||start) ? `<notations>${stop?'<tied type="stop"/>':''}${start?'<tied type="start"/>':''}</notations>` : '';
      [...it.c.byP.keys()].sort((a,b)=>a-b).forEach((p,i) => {
        out += `<note>${i?'<chord/>':''}${xmlPitch(p,flats)}<duration>${pc.ticks}</duration>${ties}${tail}${tm}<staff>${staff}</staff>${tied}</note>`;
      });
      tieOpen = start;
    });
  }
  return out;
}
const clefXml = (num, clef) => clef==='treble' ? `<clef number="${num}"><sign>G</sign><line>2</line></clef>` : `<clef number="${num}"><sign>F</sign><line>4</line></clef>`;
/* 한 보표의 성부들 (오른손 1·2, 왼손 5·6번 성부) */
function staffXml(m, h, staff, flats){
  return m[h].voices.map((v,idx) => (idx ? `<backup><duration>${A.M}</duration></backup>` : '')
    + partXml(v.items, A.trip[h], staff, (staff===1 ? 1 : 5)+idx, flats, v.ghost, idx===0 ? m[h].change : null)).join('');
}
function musicXml(){
  const [beats, type] = S.ts.split('/'), key = A.key, last = A.measures.length-1;
  const measures = A.measures.map((m,i) => {
    const prev = A.measures[i-1];
    let attrs = i ? '' : `<attributes><divisions>${TPB}</divisions><key><fifths>${FIFTHS[key.id]}</fifths></key><time><beats>${beats}</beats><beat-type>${type}</beat-type></time><staves>2</staves>${clefXml(1,m.R.clef)}${clefXml(2,m.L.clef)}</attributes>`
      + `<direction placement="above"><direction-type><metronome><beat-unit>quarter</beat-unit><per-minute>${avgTempo()}</per-minute></metronome></direction-type><sound tempo="${avgTempo()}"/></direction>`;
    if (prev && (prev.R.endClef!==m.R.clef || prev.L.endClef!==m.L.clef))
      attrs += `<attributes>${prev.R.endClef!==m.R.clef ? clefXml(1,m.R.clef) : ''}${prev.L.endClef!==m.L.clef ? clefXml(2,m.L.clef) : ''}</attributes>`;
    const end = i===last ? '<barline location="right"><bar-style>light-heavy</bar-style></barline>' : '';
    return `<measure number="${i+1}">${attrs}${staffXml(m,'R',1,key.flats)}<backup><duration>${A.M}</duration></backup>${staffXml(m,'L',2,key.flats)}${end}</measure>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8" standalone="no"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN" "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0"><work><work-title>${xmlEsc(baseName())}</work-title></work><identification><encoding><software>ScoreMake</software></encoding></identification>
<part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list><part id="P1">
${measures}
</part></score-partwise>`;
}
const baseName = () => S.name.replace(/\.[^.]+$/, '');

/* ---------- 캔버스 공통 ---------- */
function fit(cv, w, h){
  const dpr = window.devicePixelRatio || 1;
  if (cv.width!==Math.round(w*dpr) || cv.height!==Math.round(h*dpr)){ cv.width=Math.round(w*dpr); cv.height=Math.round(h*dpr); }
  cv.style.width = w+'px'; cv.style.height = h+'px';
  const ctx = cv.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0); return ctx;
}
function colors(){ const s=getComputedStyle(document.documentElement), g=n=>s.getPropertyValue(n).trim();
  return {roll:g('--roll'), rollDark:g('--roll-dark'), grid:g('--grid'), gridStrong:g('--grid-strong'), fg:g('--fg'), muted:g('--muted'),
    accent:g('--accent'), rh:g('--rh'), lh:g('--lh'), warn:g('--warn'), panel:g('--panel'), line:g('--line'), raise:g('--raise'),
    keyW:g('--key-white'), keyB:g('--key-black'), pedal:g('--pedal')}; }
const BLACK = new Set([1,3,6,8,10]);
const ROLL = {ruler:26, row:7, minP:36, maxP:88, pedal:10};
const rollH = () => ROLL.ruler + (ROLL.maxP-ROLL.minP+1)*ROLL.row + ROLL.pedal;
const yOf = p => ROLL.ruler + (ROLL.maxP-p)*ROLL.row;
const pOfY = y => ROLL.maxP - Math.floor((y-ROLL.ruler)/ROLL.row);
const splitY = () => yOf(S.split) + ROLL.row;
const lastNoteEnd = () => S.notes.length ? Math.max(...S.notes.map(n => n.t+n.d)) : 0;
const totalSec = () => Math.max(S.duration, lastNoteEnd()) + 0.5;
const fmtT = t => { const m=Math.floor(t/60), s=t-m*60; return `${m}:${s.toFixed(1).padStart(4,'0')}`; };
function sounding(){ const t=now(), m=new Map(); for (const n of S.notes) if (t>=n.t && t<n.t+n.d) m.set(n.p, handOf(n)); return m; }

/* ---------- 피아노롤 (화면 폭만큼만 그리고, 가로 스크롤 위치에 맞춰 옮겨 그림) ---------- */
function drawRoll(){
  const cv=$('#roll'), sc=$('#rollScroll'), inner=$('#rollInner'), pps=S.zoom, H=rollH();
  const total = Math.ceil(totalSec()*pps);
  inner.style.width = Math.max(total, sc.clientWidth)+'px'; inner.style.height = H+'px';
  const W = sc.clientWidth, X = sc.scrollLeft, t0 = X/pps, t1 = (X+W)/pps;
  const ctx = fit(cv, W, H), C = colors();
  ctx.translate(-X, 0);
  ctx.fillStyle=C.roll; ctx.fillRect(X,0,W,H);
  for (let p=ROLL.minP; p<=ROLL.maxP; p++){
    if (BLACK.has(p%12)){ ctx.fillStyle=C.rollDark; ctx.fillRect(X,yOf(p),W,ROLL.row); }
    if (p%12===0){ ctx.fillStyle=C.grid; ctx.fillRect(X,yOf(p)+ROLL.row-1,W,1); }
  }
  ctx.fillStyle=C.panel; ctx.fillRect(X,0,W,ROLL.ruler); ctx.fillStyle=C.line; ctx.fillRect(X,ROLL.ruler-1,W,1);
  ctx.fillStyle=C.panel; ctx.fillRect(X,H-ROLL.pedal,W,ROLL.pedal);
  // 박 / 마디
  const bm = BPMEAS[S.ts];
  ctx.font='500 10px "Cascadia Mono", Consolas, monospace';
  for (let k=0; k<BEATS.length; k++){
    const t=BEATS[k]; if (t < t0-1) continue; if (t > t1+1) break;
    const x=t*pps, bar=k%bm===0;
    if (k>0){ ctx.fillStyle = bar ? C.gridStrong : C.grid; ctx.fillRect(Math.round(x), ROLL.ruler, 1, H-ROLL.ruler-ROLL.pedal); }
    if (bar){ ctx.fillStyle=C.muted; ctx.fillText(String(k/bm+1), x+4, ROLL.ruler-6); ctx.fillStyle=C.gridStrong; ctx.fillRect(Math.round(x), ROLL.ruler-8, 1, 8); }
  }
  // 첫 박 깃발
  const ox = S.offset*pps;
  ctx.fillStyle=C.accent; ctx.fillRect(Math.round(ox)-0.5, 2, 1.5, H-2-ROLL.pedal);
  ctx.beginPath(); ctx.moveTo(ox,2); ctx.lineTo(ox+11,6.5); ctx.lineTo(ox,11); ctx.closePath(); ctx.fill();
  ctx.font='600 9px "Malgun Gothic", sans-serif'; ctx.fillText('첫 박', ox+14, 10);
  // 페달
  ctx.fillStyle=C.pedal;
  for (const e of S.pedals){ if (e.type!=='sustain' || e.t+e.d < t0 || e.t > t1) continue; ctx.fillRect(e.t*pps, H-ROLL.pedal+3, Math.max(2,e.d*pps), 4); }
  // 음표
  for (const n of S.notes){
    if (n.t+n.d < t0-0.1 || n.t > t1+0.1) continue;
    const x=n.t*pps, w=Math.max(3,n.d*pps), y=yOf(n.p)+0.5, h=ROLL.row-1;
    if (!visible(n)){
      ctx.setLineDash([2,2]); ctx.strokeStyle=C.muted; ctx.lineWidth=1; ctx.globalAlpha=.7; ctx.strokeRect(x+.5,y+.5,w-1,h-1); ctx.setLineDash([]); ctx.globalAlpha=1;
    } else {
      ctx.globalAlpha = 0.5 + 0.5*Math.min(1, n.v/85);
      ctx.fillStyle = handOf(n)==='R' ? C.rh : C.lh;
      if (GRACE.ids.has(n.id)) ctx.fillRect(x, y+h*0.3, w, h*0.4);   // 꾸밈음은 가늘게
      else ctx.fillRect(x,y,w,h);
      ctx.globalAlpha=1;
      if (n.hand){ ctx.fillStyle=C.fg; ctx.fillRect(x+1,y+h/2-1,2,2); }
      if (needsReview(n)){ ctx.strokeStyle=C.warn; ctx.lineWidth=2; ctx.strokeRect(x-1,y-1,w+2,h+2); }
    }
    if (n.id===S.sel){ ctx.strokeStyle=C.fg; ctx.lineWidth=1.5; ctx.strokeRect(x-3,y-3,w+6,h+6); }
  }
  // 양손 기준선 (자동 방식에서는 참고 기준, 경계선 방식에서는 그대로 경계)
  {
    const sy = splitY();
    ctx.setLineDash([6,4]); ctx.strokeStyle=C.fg; ctx.globalAlpha=.55; ctx.lineWidth=1.5;
    ctx.beginPath(); ctx.moveTo(X,sy); ctx.lineTo(X+W,sy); ctx.stroke(); ctx.setLineDash([]); ctx.globalAlpha=1;
    const label = S.handMode==='auto'
      ? `양손 기준선 ${pitchName(S.split, A.key.flats)} · 손이 닿지 않는 화음은 자동으로 나눔`
      : `▲ 오른손 · ▼ 왼손   경계 ${pitchName(S.split, A.key.flats)}`;
    ctx.font='500 10.5px "Malgun Gothic", sans-serif';
    const lw = ctx.measureText(label).width+14, lx = X+8;
    ctx.fillStyle=C.raise; ctx.strokeStyle=C.line; ctx.lineWidth=1;
    ctx.fillRect(lx, sy-9, lw, 18); ctx.strokeRect(lx+.5, sy-8.5, lw-1, 17);
    ctx.fillStyle=C.fg; ctx.textBaseline='middle'; ctx.fillText(label, lx+7, sy+.5); ctx.textBaseline='alphabetic';
  }
  // 재생 위치
  const px = now()*pps;
  ctx.fillStyle=C.fg; ctx.fillRect(Math.round(px)-1, 0, 2, H);
  ctx.beginPath(); ctx.moveTo(px-5,0); ctx.lineTo(px+5,0); ctx.lineTo(px,7); ctx.closePath(); ctx.fill();
  if (playing && (px < X+20 || px > X+W-60)) sc.scrollLeft = px-80;
}

function drawKeys(){
  const cv=$('#keys'), H=rollH(), W=46, ctx=fit(cv,W,H), C=colors(), on=sounding();
  ctx.fillStyle=C.panel; ctx.fillRect(0,0,W,H);
  ctx.fillStyle=C.line; ctx.fillRect(0,ROLL.ruler-1,W,1); ctx.fillRect(W-1,0,1,H);
  for (let p=ROLL.minP; p<=ROLL.maxP; p++){
    const y=yOf(p), blk=BLACK.has(p%12), hnd=on.get(p);
    ctx.fillStyle = hnd ? (hnd==='R'?C.rh:C.lh) : (blk ? C.keyB : C.keyW);
    ctx.fillRect(0, y, blk ? 28 : W-1, ROLL.row);
    if (!blk && (p%12===4 || p%12===11)){ ctx.fillStyle=C.line; ctx.fillRect(0,y,W-1,1); }
    if (p%12===0){ ctx.fillStyle=C.muted; ctx.font='500 8.5px Consolas, monospace'; ctx.textBaseline='middle'; ctx.fillText('C'+(p/12-1), 30, y+ROLL.row/2); ctx.fillStyle=C.line; ctx.fillRect(0,y+ROLL.row-1,W-1,1); }
  }
  ctx.fillStyle=C.muted; ctx.font='500 8.5px "Malgun Gothic", sans-serif'; ctx.textBaseline='middle'; ctx.fillText('페달', 6, H-ROLL.pedal/2); ctx.textBaseline='alphabetic';
}

/* 소리 파일일 때 영상 자리에 건반을 그린다 */
function drawKbd(){
  const cv=$('#kbd'); if (cv.hidden) return;
  const W=cv.parentElement.clientWidth, H=Math.round(W*9/16), ctx=fit(cv,W,H), C=colors(), on=sounding();
  ctx.fillStyle='#14171D'; ctx.fillRect(0,0,W,H);
  const lo=21, hi=108, whites=[]; for (let p=lo;p<=hi;p++) if (!BLACK.has(p%12)) whites.push(p);
  const kTop=H*0.45, kH=H*0.45, ww=W/whites.length, wx={};
  ctx.fillStyle='#7C1F2C'; ctx.fillRect(0,kTop-3,W,3);
  whites.forEach((p,i) => { wx[p]=i*ww; const h=on.get(p); ctx.fillStyle = h ? (h==='R'?C.rh:C.lh) : '#ECE9E2'; ctx.fillRect(wx[p]+.5,kTop,ww-1,kH); });
  for (let p=lo;p<=hi;p++) if (BLACK.has(p%12)){ const h=on.get(p), x=wx[p-1]+ww*0.66; ctx.fillStyle = h ? (h==='R'?C.rh:C.lh) : '#121418'; ctx.fillRect(x,kTop,ww*0.68,kH*0.62); }
  ctx.fillStyle='rgba(255,255,255,.75)'; ctx.font='500 11px Consolas, monospace';
  ctx.fillText(S.name, 10, 18); const tc=fmtT(now()); ctx.fillText(tc, W-10-ctx.measureText(tc).width, H-10);
}

/* ---------- 재생: 원본은 영상 소리, 인식 결과는 합성음 ---------- */
const media = () => $('#media');
const now = () => media().currentTime || 0;
let playing=false, actx=null, master=null, out=null, bus=null, synthOn=false, schedTo=0;
let volume = 1;                                    // 0~2. 원본 소리는 1까지, 인식 결과는 2배까지 키울 수 있다
function audioCtx(){
  if (!actx){
    actx=new (window.AudioContext||window.webkitAudioContext)();
    master=actx.createGain(); master.gain.value=1.4;
    const comp=actx.createDynamicsCompressor();   // 화음이 겹쳐도 소리가 찢어지지 않게
    comp.threshold.value=-14; comp.knee.value=10; comp.ratio.value=4; comp.attack.value=0.003; comp.release.value=0.25;
    out=actx.createGain(); out.gain.value=volume;
    master.connect(comp); comp.connect(out); out.connect(actx.destination);
  }
  return actx;
}
let volTimer=0;
function setVolume(v, save=true){
  volume = clamp(v, 0, 2);
  media().volume = Math.min(1, volume);
  if (out) out.gain.setTargetAtTime(volume, actx.currentTime, 0.02);
  $('#vol').value = Math.round(volume*100); $('#volVal').textContent = Math.round(volume*100)+'%';
  if (save && API && API.set_pref){ clearTimeout(volTimer); volTimer=setTimeout(() => API.set_pref('volume', volume), 400); }
}
function ensureAudio(){ audioCtx(); if (actx.state==='suspended') actx.resume(); }

/* 피아노 소리: Salamander Grand Piano 샘플(단3도 간격 30개)에서 가장 가까운 것을 음높이만큼 늘이거나 줄여 쓴다 */
const PIANO = new Map(); let pianoLoading = null;
function loadPiano(){
  if (pianoLoading) return pianoLoading;
  const ctx = audioCtx(), names = {0:'C',3:'Ds',6:'Fs',9:'A'}, jobs = [];
  for (let m=21; m<=108; m+=3){
    const file = `vendor/piano/${names[m%12]}${Math.floor(m/12)-1}.mp3`;
    jobs.push(fetch(file).then(r => r.arrayBuffer()).then(b => ctx.decodeAudioData(b)).then(buf => PIANO.set(m, buf)).catch(() => {}));
  }
  return pianoLoading = Promise.all(jobs);
}
function tone(dest, when, dur, p, v){
  const base = 21 + 3*Math.round((clamp(p,21,108)-21)/3);
  if (!PIANO.has(base)) return synthTone(dest, when, dur, p, v);
  const vel = v/127, src = actx.createBufferSource(), g = actx.createGain(), lp = actx.createBiquadFilter();
  src.buffer = PIANO.get(base); src.playbackRate.value = Math.pow(2, (p-base)/12);
  lp.type = 'lowpass'; lp.frequency.value = 1800 + 14000*vel*vel;            // 세게 칠수록 밝은 소리
  const amp = 0.25 + 0.75*vel, off = when + Math.max(0.05, dur);            // 약하게 친 음도 들리게
  g.gain.setValueAtTime(amp, when); g.gain.setValueAtTime(amp, off);
  g.gain.setTargetAtTime(0, off, 0.12);                                      // 건반을 떼면 댐퍼가 소리를 멈춘다
  src.connect(lp); lp.connect(g); g.connect(dest);
  src.start(when); src.stop(off + 1.2);
}
function synthTone(dest, when, dur, p, v){
  const f=440*Math.pow(2,(p-69)/12), g=actx.createGain(), lp=actx.createBiquadFilter();
  lp.type='lowpass'; lp.frequency.value=2600;
  const o1=actx.createOscillator(); o1.type='triangle'; o1.frequency.value=f;
  const o2=actx.createOscillator(); o2.type='sine'; o2.frequency.value=f*2;
  const g2=actx.createGain(); g2.gain.value=0.16;
  o1.connect(g); o2.connect(g2); g2.connect(g); g.connect(lp); lp.connect(dest);
  const pk=0.12+0.88*(v/127), off=when+Math.max(0.08,dur);
  g.gain.setValueAtTime(0,when); g.gain.linearRampToValueAtTime(pk,when+0.006);
  g.gain.setTargetAtTime(pk*0.3,when+0.01,0.4); g.gain.setTargetAtTime(0,off,0.06);
  o1.start(when); o2.start(when); o1.stop(off+0.4); o2.stop(off+0.4);
}
function audition(p){ try { ensureAudio(); tone(master, actx.currentTime+0.01, 0.35, p, 80); } catch(e){} }
function startSynth(){ ensureAudio(); bus=actx.createGain(); bus.connect(master); schedTo=now(); synthOn=true; }
function stopSynth(){ synthOn=false; if (bus){ const b=bus; b.gain.setTargetAtTime(0,actx.currentTime,0.02); setTimeout(() => b.disconnect(),300); bus=null; } }
/* 박 소리: 재생 중 박마다 딸깍 소리를 내서 박 추적이 맞는지 귀로 확인한다 (마디 첫 박은 높은 소리) */
let clickOn=false, clickBus=null, clickTo=0;
function click(when, down){
  const o=actx.createOscillator(), g=actx.createGain();
  o.type='square'; o.frequency.value = down ? 1760 : 1175;
  g.gain.setValueAtTime(0, when); g.gain.linearRampToValueAtTime(down ? 0.3 : 0.18, when+0.001);
  g.gain.exponentialRampToValueAtTime(0.001, when+0.04);
  o.connect(g); g.connect(clickBus); o.start(when); o.stop(when+0.05);
}
function startClicks(){ ensureAudio(); clickBus=actx.createGain(); clickBus.connect(master); clickTo=now(); }
function stopClicks(){ if (clickBus){ const b=clickBus; b.gain.setTargetAtTime(0,actx.currentTime,0.01); setTimeout(() => b.disconnect(),200); clickBus=null; } }
function advanceClicks(){
  if (!clickBus) return;
  const t=now(), hz=t+0.25, bm=BPMEAS[S.ts];
  for (let k=0; k<BEATS.length; k++){ const b=BEATS[k]; if (b < clickTo) continue; if (b >= hz) break; click(actx.currentTime+Math.max(0,b-t), k%bm===0); }
  clickTo = hz;
}
function setClick(on){
  clickOn=on; $('#clickBtn').setAttribute('aria-pressed', on);
  if (playing){ on ? startClicks() : stopClicks(); }
}
function play(){ const m=media(); m.muted = S.source==='res'; const pr=m.play(); if (pr) pr.catch(()=>{}); playing=true; if (S.source==='res') startSynth(); if (clickOn) startClicks(); setPlayIcon(); }
function pause(){ media().pause(); playing=false; stopSynth(); stopClicks(); setPlayIcon(); }
function togglePlay(){ playing ? pause() : play(); }
function seek(t){ media().currentTime = clamp(t, 0, totalSec()); if (synthOn){ stopSynth(); startSynth(); } if (clickBus){ stopClicks(); startClicks(); } dirty=true; }
function advanceSynth(){
  if (!synthOn) return;
  const t=now(), hz=t+0.25;
  for (const n of A.result){ if (n.t < schedTo) continue; if (n.t >= hz) break; tone(bus, actx.currentTime+Math.max(0,n.t-t), n.d, n.p, n.v); }
  schedTo = hz;
}
function setSource(s){
  S.source=s; $('#srcRaw').setAttribute('aria-pressed', s==='raw'); $('#srcRes').setAttribute('aria-pressed', s==='res');
  if (playing){ media().muted = s==='res'; s==='res' ? startSynth() : stopSynth(); }
}
function setPlayIcon(){ $('#playIcon').innerHTML = playing ? '<path d="M3.5 2.5h3.2v11H3.5zM9.3 2.5h3.2v11H9.3z"/>' : '<path d="M4 2.5v11l9.5-5.5z"/>';
  $('#play').setAttribute('aria-label', playing ? '일시정지' : '재생'); }

/* ---------- 되돌리기, 자동 저장 ---------- */
const hist = [];
function pushHist(){ hist.push(JSON.stringify({notes:S.notes, split:S.split, offset:S.offset})); if (hist.length>100) hist.shift(); $('#undo').disabled=false; }
function undo(){ const s=hist.pop(); if (!s) return; const o=JSON.parse(s);
  S.notes=o.notes; S.split=o.split; S.offset=o.offset; if (!byId(S.sel)) S.sel=null;
  $('#undo').disabled=!hist.length; update(); toast('되돌렸습니다'); }
let saveTimer=0;
function saveSoon(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    if (!S.path || !API) return;
    const settings = {}; SETTINGS.forEach(k => settings[k]=S[k]);
    API.save_edits(S.path, {notes:S.notes, settings, nid}).catch(()=>{});
  }, 800);
}

/* ---------- 선택, 검토 ---------- */
function select(id, o={}){
  S.sel=id; const n=byId(id);
  if (n){ if (o.scroll){ const sc=$('#rollScroll'); sc.scrollLeft = n.t*S.zoom - sc.clientWidth/3; }
    if (o.seek && !playing) seek(Math.max(0,n.t-0.6)); if (o.sound) audition(n.p); }
  renderInspector(); scheduleScore(); dirty=true;
}
const reviewList = () => S.notes.filter(n => visible(n) && needsReview(n)).sort((a,b) => a.t-b.t);
function goReview(dir){
  const L=reviewList(); if (!L.length) return;
  const cur=byId(S.sel); let i=-1;
  if (cur){ if (dir>0) i=L.findIndex(n => n.t>cur.t+1e-6); else for (let k=L.length-1;k>=0;k--) if (L[k].t<cur.t-1e-6){ i=k; break; } }
  if (i<0) i = dir>0 ? 0 : L.length-1;
  select(L[i].id, {scroll:true, seek:true, sound:true});
}
function act(a){
  const n=byId(S.sel); if (!n) return;
  if (a==='up' || a==='down' || a==='oup' || a==='odown'){ pushHist(); const d={up:1,down:-1,oup:12,odown:-12}[a]; n.p=clamp(n.p+d,21,108); audition(n.p); }
  else if (a==='hand'){ pushHist(); const nh = handOf(n)==='R' ? 'L' : 'R'; n.hand = nh===autoHand(n) ? null : nh; }
  else if (a==='nograce'){ pushHist(); n.noGrace = true; toast('보통 음표로 바꿨습니다.'); }
  else if (a==='ok'){ pushHist(); n.ok=true; update(); const nx=reviewList().find(x => x.t>n.t); if (nx) select(nx.id,{scroll:true,seek:true,sound:true}); toast(nx ? '확인했습니다. 다음 음으로 넘어갑니다.' : '확인이 필요한 음을 모두 봤습니다.'); return; }
  else if (a==='del'){ pushHist(); S.notes=S.notes.filter(x => x!==n); S.sel=null; toast('음을 지웠습니다. Ctrl+Z로 되돌릴 수 있습니다.'); }
  else if (a==='listen'){ seek(Math.max(0,n.t-1.5)); if (!playing) play(); return; }
  update();
}

function renderInspector(){
  const el=$('#inspector'), n=byId(S.sel);
  if (!n){ el.innerHTML='<p class="insp-empty">음표를 클릭하면 여기서 음높이, 손, 삭제를 고칠 수 있습니다. 주황 테두리는 AI가 확신하지 못한 음입니다.</p>'; return; }
  const flats=A.key.flats, h=handOf(n), b=beatPos(n.t), bm=BPMEAS[S.ts];
  const where = b<-0.25 ? '첫 박 전' : `${Math.floor(Math.max(0,b)/bm)+1}마디 ${Math.floor(Math.max(0,b)%bm)+1}박`;
  const conf=Math.round(n.c*100), rev=needsReview(n);
  el.innerHTML = `
    <div class="insp-id">
      <span class="insp-pitch">${pitchName(n.p,flats)}</span>
      <span class="chip ${h==='R'?'chip-r':'chip-l'}">${h==='R'?'오른손':'왼손'} · ${n.hand?'직접 지정':'자동'}</span>
      ${rev ? `<span class="chip chip-warn">확신도 ${conf}%</span>` : `<span class="chip">확신도 ${conf}%${n.ok?' · 확인함':''}</span>`}
      ${!visible(n) ? '<span class="chip">숨김 · 약한 음</span>' : ''}
      ${GRACE.ids.has(n.id) ? '<span class="chip">꾸밈음</span>' : ''}
    </div>
    <dl class="insp-stats">
      <div><dt>위치</dt><dd>${where}</dd></div><div><dt>시작</dt><dd>${fmtT(n.t)}</dd></div>
      <div><dt>길이</dt><dd>${n.d.toFixed(2)}초</dd></div><div><dt>세기</dt><dd>${n.v}</dd></div>
    </dl>
    <div class="insp-actions">
      <button class="btn icon" data-a="up" title="반음 위 (↑)" aria-label="반음 위">▲</button>
      <button class="btn icon" data-a="down" title="반음 아래 (↓)" aria-label="반음 아래">▼</button>
      <button class="btn" data-a="oup" title="한 옥타브 위 (Shift+↑)">+8va</button>
      <button class="btn" data-a="odown" title="한 옥타브 아래 (Shift+↓)">−8va</button>
      <button class="btn" data-a="hand">손 바꾸기<kbd>H</kbd></button>
      ${rev ? '<button class="btn good" data-a="ok">맞음<kbd>Enter</kbd></button>' : ''}
      ${GRACE.ids.has(n.id) ? '<button class="btn" data-a="nograce">꾸밈음 아님</button>' : ''}
      <button class="btn" data-a="listen">이 부분 듣기</button>
      <button class="btn danger" data-a="del">삭제<kbd>Del</kbd></button>
    </div>`;
}

/* ---------- 설정 UI ---------- */
function syncControls(){
  $('#bpm').value=S.bpm; $('#bpmNum').value=S.bpm; $('#ts').value=S.ts; $('#grid').value=String(S.grid);
  $('#trip').checked=S.triplet; $('#trip').disabled=S.grid===12; $('#noteLen').value=S.noteLen; $('#fill').value=S.fill;
  $('#graces').checked=S.graces; $('#voices').checked=S.voices; $('#handMode').value=S.handMode; $('#minVel').value=S.minVel; $('#follow').checked=S.follow;
  $('#minConf').value=Math.round(S.minConf*100); $('#bpmAuto').textContent=`자동 추정값 ${S.autoBpm}로`;
}
function renderInfo(){
  $('#offsetVal').textContent = S.offset.toFixed(2)+'초';
  const sel=$('#key');
  sel.innerHTML=[`<option value="auto">자동 (${A.auto.name})</option>`].concat(KEYS.map(k => `<option value="${k.id}">${keyLabel(k)}</option>`)).join('');
  sel.value=S.key;
  $('#minVelInfo').textContent = `세기 ${S.minVel} 미만 ${S.notes.filter(n => !visible(n)).length}개 숨김`;
  $('#minConfInfo').textContent = `${Math.round(S.minConf*100)}% 미만`;
  if (S.handMode==='auto') $('#handHint').textContent =
    '한 손이 닿는 폭(한 옥타브 남짓, 다섯 음)과 손의 움직임을 따져 나눕니다. 오른손 음역이 낮은 곡이면 피아노롤의 점선(기준선)을 내리세요. 틀린 음은 선택하고 H를 누르세요.';
  else {
    const bad = window.ScoreHands ? ScoreHands.unplayable(slots(S.notes.filter(n => visible(n) && !GRACE.ids.has(n.id))), n => handOf(byId(n.id))) : 0;
    $('#handHint').textContent = '점선을 끌어 경계를 옮기세요. 위는 오른손, 아래는 왼손입니다.'
      + (bad ? ` 지금 한 손이 닿지 않는 화음이 ${bad}곳 있습니다. '자동'을 고르면 손이 닿게 나눕니다.` : '');
  }
  const L=reviewList(), pill=$('#reviewCount');
  pill.className = 'pill ' + (L.length ? 'warn' : 'ok'); pill.textContent = L.length ? `확인 필요 ${L.length}개` : '모두 확인함';
  $('#prevRev').disabled = $('#nextRev').disabled = !L.length;
  const keyName = S.key==='auto' ? A.auto.name : majorName(A.key);
  $('#scoreMeta').textContent = `${A.measures.length}마디 · ${keyName} · ${S.ts} · ♩≈${avgTempo()}${S.follow?' (템포 따라감)':''}`;
}
function update(){ compute(); renderInfo(); renderInspector(); scheduleScore(); saveSoon(); dirty=true; }
function setBpm(v){ S.bpm=clamp(Math.round(v)||S.autoBpm,40,200); syncControls(); update(); }

function bindControls(){
  $('#bpm').addEventListener('input', e => setBpm(+e.target.value));
  $('#bpmNum').addEventListener('change', e => setBpm(+e.target.value));
  $('#bpmAuto').addEventListener('click', () => { setBpm(S.autoBpm); $('#tapInfo').textContent="음악에 맞춰 '탭'을 4번 이상 누르면 템포를 잽니다"; });
  let taps=[];
  $('#tap').addEventListener('click', () => {
    const t=performance.now()/1000; if (taps.length && t-taps[taps.length-1]>2) taps=[];
    taps.push(t); if (taps.length>8) taps.shift();
    if (taps.length>=4){ const iv=(taps[taps.length-1]-taps[0])/(taps.length-1); setBpm(60/iv); $('#tapInfo').textContent=`탭 ${taps.length}번 → ${S.bpm} BPM`; }
    else $('#tapInfo').textContent=`탭 ${taps.length}번… 박자에 맞춰 계속 누르세요`;
  });
  $('#follow').addEventListener('change', e => { S.follow=e.target.checked; update(); });
  $('#ts').addEventListener('change', e => { S.ts=e.target.value; update(); });
  $('#key').addEventListener('change', e => { S.key=e.target.value; update(); });
  $('#grid').addEventListener('change', e => { S.grid=+e.target.value; syncControls(); update(); });
  $('#trip').addEventListener('change', e => { S.triplet=e.target.checked; update(); });
  $('#noteLen').addEventListener('change', e => { S.noteLen=e.target.value; update(); });
  $('#fill').addEventListener('change', e => { S.fill=+e.target.value; update(); });
  $('#graces').addEventListener('change', e => { S.graces=e.target.checked; update(); });
  $('#voices').addEventListener('change', e => { S.voices=e.target.checked; update(); });
  $('#handMode').addEventListener('change', e => { S.handMode=e.target.value; syncControls(); update(); });
  $('#minVel').addEventListener('input', e => { S.minVel=+e.target.value; update(); });
  $('#minConf').addEventListener('input', e => { S.minConf=+e.target.value/100; update(); });
  $('#prevRev').addEventListener('click', () => goReview(-1));
  $('#nextRev').addEventListener('click', () => goReview(1));
  $('#inspector').addEventListener('click', e => { const b=e.target.closest('button[data-a]'); if (b) act(b.dataset.a); });
  $('#undo').addEventListener('click', undo);
  $('#zoomIn').addEventListener('click', () => { S.zoom=clamp(S.zoom*1.25,20,300); saveSoon(); dirty=true; });
  $('#zoomOut').addEventListener('click', () => { S.zoom=clamp(S.zoom/1.25,20,300); saveSoon(); dirty=true; });
  $('#play').addEventListener('click', togglePlay);
  $('#seek').addEventListener('input', e => seek(+e.target.value/1000*totalSec()));
  $('#vol').addEventListener('input', e => setVolume(+e.target.value/100));
  $('#srcRaw').addEventListener('click', () => setSource('raw'));
  $('#srcRes').addEventListener('click', () => setSource('res'));
  $('#clickBtn').addEventListener('click', () => setClick(!clickOn));
  $('#otherBtn').addEventListener('click', chooseAndOpen);
  $('#resetBtn').addEventListener('click', resetEdits);
  $('#exportXml').addEventListener('click', async () => {
    const path = await API.save_musicxml(musicXml(), baseName()+'.musicxml');
    if (path) toast('MusicXML로 저장했습니다: '+path);
  });
  $('#exportPdf').addEventListener('click', async () => {
    toast('PDF를 만드는 중입니다…');
    const path = await API.save_pdf(printPages(), baseName(), baseName()+'.pdf');
    if (path){ toast('PDF로 저장했습니다: '+path); API.reveal(path); }
  });
  const m = media();
  m.addEventListener('pause', () => { if (playing){ playing=false; stopSynth(); setPlayIcon(); } });
  m.addEventListener('seeked', () => { if (synthOn){ schedTo=now(); } dirty=true; });
  m.addEventListener('error', async () => {
    if (!S.isVideo || m.dataset.proxy) return;
    m.dataset.proxy='1'; toast('이 영상 형식은 바로 재생되지 않아 재생용으로 변환하고 있습니다…');
    const r = await API.make_proxy(S.path);
    if (r && r.media){ m.src=r.media; toast('변환을 마쳤습니다.'); } else toast('영상을 재생할 수 없습니다. 악보 작업은 그대로 할 수 있습니다.');
  });
}

let toastTimer=0;
function toast(msg){ const t=$('#toast'); t.textContent=msg; t.hidden=false; clearTimeout(toastTimer); toastTimer=setTimeout(() => t.hidden=true, 3200); }

/* ---------- 피아노롤 조작 ---------- */
function bindRoll(){
  const roll=$('#roll'), sc=$('#rollScroll'); let drag=null;
  const local = e => { const r=roll.getBoundingClientRect(); return {x:e.clientX-r.left+sc.scrollLeft, y:e.clientY-r.top}; };
  const hitNote = (x,y) => { for (let i=S.notes.length-1;i>=0;i--){ const n=S.notes[i], nx=n.t*S.zoom, w=Math.max(3,n.d*S.zoom), ny=yOf(n.p);
    if (x>=nx-2 && x<=nx+w+2 && y>=ny-1 && y<=ny+ROLL.row+1) return n; } return null; };
  roll.addEventListener('pointerdown', e => {
    const {x,y}=local(e);
    if (y < ROLL.ruler){ drag = Math.abs(x-S.offset*S.zoom)<9 ? {type:'offset'} : {type:'seek'}; if (drag.type==='seek') seek(x/S.zoom); roll.setPointerCapture(e.pointerId); return; }
    const n=hitNote(x,y);
    if (n){ select(n.id,{sound:true}); drag={type:'note', n, x0:x, y0:y, t0:n.t, p0:n.p}; roll.setPointerCapture(e.pointerId); roll.style.cursor='grabbing'; return; }
    if (Math.abs(y-splitY())<6){ drag={type:'split'}; roll.setPointerCapture(e.pointerId); return; }
    select(null);
  });
  roll.addEventListener('pointermove', e => {
    const {x,y}=local(e);
    if (!drag){ roll.style.cursor = y<ROLL.ruler ? (Math.abs(x-S.offset*S.zoom)<9 ? 'ew-resize' : 'pointer') : hitNote(x,y) ? 'grab' : Math.abs(y-splitY())<6 ? 'ns-resize' : 'default'; return; }
    if (drag.type==='seek'){ seek(Math.max(0,x/S.zoom)); return; }
    if (!drag.pushed){ if (drag.type==='note' && Math.hypot(x-drag.x0,y-drag.y0)<3) return; pushHist(); drag.pushed=true; }
    if (drag.type==='offset') S.offset=+clamp(x/S.zoom,0,totalSec()).toFixed(3);
    else if (drag.type==='split') S.split=clamp(ROLL.maxP-Math.round((y-ROLL.ruler)/ROLL.row)+1, ROLL.minP+1, ROLL.maxP);
    else { const n=drag.n, np=clamp(drag.p0-Math.round((y-drag.y0)/ROLL.row),ROLL.minP,ROLL.maxP);
      if (np!==n.p) audition(np); n.p=np; n.t=+Math.max(0,drag.t0+(x-drag.x0)/S.zoom).toFixed(3); }
    update();
  });
  const endDrag = () => { drag=null; roll.style.cursor='default'; };
  roll.addEventListener('pointerup', endDrag); roll.addEventListener('pointercancel', endDrag);
  roll.addEventListener('dblclick', e => {
    const {x,y}=local(e); if (y<ROLL.ruler || y>rollH()-ROLL.pedal || hitNote(x,y)) return;
    const bp = beatPos(x/S.zoom), step = gridTicks()/TPB, q = Math.round(bp/step)*step;
    const t = Math.max(0, timeAt(q)), d = Math.max(0.1, timeAt(q+1)-timeAt(q))*0.95;
    pushHist();
    const n={id:nid++, p:clamp(pOfY(y),ROLL.minP,ROLL.maxP), t:+t.toFixed(3), d:+d.toFixed(3), v:64, c:1, hand:null, ok:true};
    S.notes.push(n); S.notes.sort((a,b) => a.t-b.t); update(); select(n.id,{sound:true});
  });
  sc.addEventListener('scroll', () => dirty=true);

  $('#score').addEventListener('click', e => {
    const r=$('#score').getBoundingClientRect(), x=e.clientX-r.left, y=e.clientY-r.top;
    const hb=hitboxes.find(b => x>=b.x-3 && x<=b.x+b.w+3 && y>=b.y-3 && y<=b.y+b.h+3);
    if (hb){ const ids=[...hb.c.byP.values()]; const pick=ids.find(id => needsReview(byId(id))) || ids[0]; select(pick,{scroll:true,seek:true,sound:true}); return; }
    const L=layout.find(L => x>=L.x && x<=L.x+L.w && y>=L.y && y<=L.y+L.h);
    if (L) seek(timeAt(L.i*BPMEAS[S.ts]));
  });

  document.addEventListener('keydown', e => {
    if ($('#editor').hidden) return;
    if ((e.ctrlKey||e.metaKey) && e.key.toLowerCase()==='z'){ e.preventDefault(); undo(); return; }
    if (e.target.closest('input,select,textarea,button')) return;
    if (e.key===' '){ e.preventDefault(); togglePlay(); return; }
    if (e.key.toLowerCase()==='m' && !e.ctrlKey && !e.altKey){ setClick(!clickOn); return; }
    if (!byId(S.sel)) return;
    if (e.key==='Delete' || e.key==='Backspace'){ e.preventDefault(); act('del'); }
    else if (e.key==='ArrowUp'){ e.preventDefault(); act(e.shiftKey?'oup':'up'); }
    else if (e.key==='ArrowDown'){ e.preventDefault(); act(e.shiftKey?'odown':'down'); }
    else if (e.key.toLowerCase()==='h') act('hand');
    else if (e.key==='Enter' && needsReview(byId(S.sel))) act('ok');
    else if (e.key==='Escape') select(null);
  });
}

/* ---------- 유튜브: 링크 → 구간 고르기 → 받기 → 바로 인식 ---------- */
// 미리보기는 유튜브 플레이어(player)로 하고, 퍼가기가 막혀 있으면 받아 둔 저화질 영상(video)으로 한다
const YTS = {info:null, player:null, video:null, ready:false, fallback:false, start:0, end:0, previewing:false, timer:0, waitTimer:0, busy:false};
const parseTime = s => { s=String(s).trim(); if (!s) return NaN; const p=s.split(':').map(Number); return p.some(isNaN) ? NaN : p.reduce((a,b) => a*60+b, 0); };
const fmtHMS = t => { t=Math.max(0,Math.round(t)); const h=Math.floor(t/3600), m=Math.floor(t%3600/60), s=t%60;
  return h ? `${h}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')}` : `${m}:${String(s).padStart(2,'0')}`; };

function loadYTApi(){
  return new Promise(res => {
    if (window.YT && window.YT.Player) return res(true);
    const t = setTimeout(() => res(false), 10000);
    window.onYouTubeIframeAPIReady = () => { clearTimeout(t); res(true); };
    if (!document.getElementById('ytApi')){
      const s=document.createElement('script'); s.id='ytApi'; s.src='https://www.youtube.com/iframe_api';
      s.onerror = () => { clearTimeout(t); res(false); }; document.head.appendChild(s);
    }
  });
}
function ytNoPlay(msg){ $('#ytNoPlay').textContent=msg; $('#ytNoPlay').hidden=!msg; }
function ytDestroyPlayer(){ if (YTS.player){ try { YTS.player.destroy(); } catch(e){} YTS.player=null; } }
function ytStopPlayer(){
  clearInterval(YTS.timer); clearTimeout(YTS.waitTimer); ytDestroyPlayer();
  if (YTS.video){ YTS.video.pause(); YTS.video.removeAttribute('src'); YTS.video.load(); YTS.video=null; }
  if (YTS.fallback) API.yt_preview_cancel();
  YTS.fallback=false; $('#ytPlayerBox').innerHTML='';
}
const ytNow = () => {
  if (YTS.video) return YTS.video.currentTime;
  try { return YTS.ready ? YTS.player.getCurrentTime() : NaN; } catch(e){ return NaN; }
};
function pvSeek(t){ if (YTS.video) YTS.video.currentTime=t; else if (YTS.ready) try { YTS.player.seekTo(t, true); } catch(e){} }
function pvPlay(){ if (YTS.video){ const p=YTS.video.play(); if (p) p.catch(()=>{}); } else if (YTS.ready) try { YTS.player.playVideo(); } catch(e){} }
function pvPause(){ if (YTS.video) YTS.video.pause(); else if (YTS.ready) try { YTS.player.pauseVideo(); } catch(e){} }
const pvReady = () => !!YTS.video || YTS.ready;

/* 유튜브 플레이어를 못 쓰면 저화질 영상을 받아 프로그램 안에서 재생한다 */
function ytFallback(){
  if (YTS.fallback || !YTS.info) return;
  YTS.fallback=true; clearTimeout(YTS.waitTimer); ytDestroyPlayer(); YTS.ready=false;
  $('#ytPlayerBox').innerHTML='';
  ytNoPlay('이 영상은 유튜브 밖에서 재생이 막혀 있어, 구간을 고를 수 있게 미리보기용 저화질 영상을 받고 있습니다… 0%');
  API.yt_preview(YTS.info.url, YTS.info.id);
}

async function ytLoad(e){
  e.preventDefault();
  const url=$('#ytUrl').value.trim(), btn=$('#ytGo'), err=$('#ytErr');
  if (!url){ $('#ytUrl').focus(); return; }
  err.hidden=true; btn.disabled=true; btn.textContent='불러오는 중…';
  try {
    const info = await API.yt_info(url);
    if (info.error){ err.textContent=info.error; err.hidden=false; return; }
    ytEnter(info);
  } finally { btn.disabled=false; btn.textContent='불러오기'; }
}

async function ytEnter(info){
  YTS.info=info; YTS.start=0; YTS.end = info.duration<=600 ? info.duration : Math.min(info.duration, 180);
  $('#ytTitle').textContent=info.title; $('#ytMeta').textContent=[info.uploader, fmtHMS(info.duration)].filter(Boolean).join(' · ');
  $('#ytProg').hidden=true; $('#ytActions').hidden=false; $('#ytErr2').hidden=true; $('#ytNoPlay').hidden=true;
  show('yt'); ytRender();
  ytStopPlayer(); YTS.ready=false;
  YTS.timer = setInterval(() => {
    const t=ytNow(); if (isNaN(t)) return;
    $('#rangeNow').style.left = (t/YTS.info.duration*100)+'%';
    if (YTS.previewing && t >= YTS.end){ YTS.previewing=false; pvPause(); }
  }, 200);
  $('#ytPlayerBox').innerHTML='<div id="ytPlayer"></div>';
  if (!await loadYTApi()){ ytFallback(); return; }
  if (YTS.info!==info) return;
  YTS.player = new YT.Player('ytPlayer', {videoId:info.id, playerVars:{rel:0, playsinline:1},
    events:{onReady: () => { YTS.ready=true; clearTimeout(YTS.waitTimer); }, onError: ytFallback}});
  YTS.waitTimer = setTimeout(() => { if (!YTS.ready) ytFallback(); }, 10000);
}

function ytRender(){
  const d=YTS.info.duration, a=YTS.start/d*100, b=YTS.end/d*100, len=YTS.end-YTS.start;
  $('#rangeSel').style.left=a+'%'; $('#rangeSel').style.width=(b-a)+'%';
  $('#knobA').style.left=a+'%'; $('#knobB').style.left=b+'%';
  $('#knobA').setAttribute('aria-valuetext', fmtHMS(YTS.start)); $('#knobB').setAttribute('aria-valuetext', fmtHMS(YTS.end));
  if (document.activeElement!==$('#ytStart')) $('#ytStart').value=fmtHMS(YTS.start);
  if (document.activeElement!==$('#ytEnd')) $('#ytEnd').value=fmtHMS(YTS.end);
  const est = Math.max(1, Math.round(len*0.75/60));
  $('#selLen').textContent = `고른 길이 ${fmtHMS(len)} · 인식에 약 ${est}분`;
}
function ytSet(which, v){
  const d=YTS.info.duration;
  if (which==='start') YTS.start = clamp(v, 0, YTS.end-1); else YTS.end = clamp(v, YTS.start+1, d);
  ytRender();
}

function bindYouTube(){
  $('#ytForm').addEventListener('submit', ytLoad);
  $('#ytBack').addEventListener('click', () => { if (YTS.busy) API.yt_cancel(); ytStopPlayer(); show('start'); loadRecent(); });
  const track=$('#rangeTrack'); let dragging=null;
  const timeAtX = x => { const r=track.getBoundingClientRect(); return clamp((x-r.left)/r.width, 0, 1)*YTS.info.duration; };
  track.addEventListener('pointerdown', e => {
    const t=timeAtX(e.clientX);
    dragging = Math.abs(t-YTS.start) <= Math.abs(t-YTS.end) ? 'start' : 'end';
    ytSet(dragging, t); track.setPointerCapture(e.pointerId);
  });
  track.addEventListener('pointermove', e => { if (dragging) ytSet(dragging, timeAtX(e.clientX)); });
  const drop = () => { if (!dragging) return; pvSeek(dragging==='start' ? YTS.start : YTS.end); dragging=null; };
  track.addEventListener('pointerup', drop); track.addEventListener('pointercancel', drop);
  [['knobA','start'],['knobB','end']].forEach(([id,which]) => $('#'+id).addEventListener('keydown', e => {
    const step = e.shiftKey ? 10 : 1, cur = which==='start' ? YTS.start : YTS.end;
    if (e.key==='ArrowLeft'){ e.preventDefault(); ytSet(which, cur-step); }
    if (e.key==='ArrowRight'){ e.preventDefault(); ytSet(which, cur+step); }
  }));
  [['ytStart','start'],['ytEnd','end']].forEach(([id,which]) => $('#'+id).addEventListener('change', e => {
    const v=parseTime(e.target.value); if (!isNaN(v)) ytSet(which, v); else ytRender();
  }));
  $('#setStart').addEventListener('click', () => { const t=ytNow(); if (!isNaN(t)) ytSet('start', t); });
  $('#setEnd').addEventListener('click', () => { const t=ytNow(); if (!isNaN(t)) ytSet('end', t); });
  $('#previewSel').addEventListener('click', () => {
    if (!pvReady()){ toast(YTS.fallback ? '미리보기 영상을 받는 중입니다. 잠시 후 다시 눌러 주세요.' : '미리보기를 불러오는 중입니다.'); return; }
    pvSeek(YTS.start); pvPlay(); YTS.previewing=true;
  });
  $('#ytDownload').addEventListener('click', async () => {
    const ok = await API.yt_download(YTS.info.url, YTS.info.id, YTS.start, YTS.end, YTS.info.title);
    if (!ok){ toast('이미 받는 중입니다.'); return; }
    YTS.busy=true; pvPause();
    $('#ytActions').hidden=true; $('#ytErr2').hidden=true; $('#ytProg').hidden=false;
    $('#ytBar').style.width='0%'; $('#ytProgText').textContent='받을 준비 중…';
  });
  $('#ytCancel').addEventListener('click', () => API.yt_cancel());
}
function ytEvent(kind, data){
  if (kind.startsWith('yt_pv_')){
    if (!YTS.info || data.vid!==YTS.info.id || !YTS.fallback) return;
    if (kind==='yt_pv_progress') ytNoPlay(`이 영상은 유튜브 밖에서 재생이 막혀 있어, 구간을 고를 수 있게 미리보기용 저화질 영상을 받고 있습니다… ${Math.round(data.f*100)}%`);
    else if (kind==='yt_pv_done'){
      const v=document.createElement('video'); v.controls=true; v.preload='auto'; v.playsInline=true; v.src=data.media;
      $('#ytPlayerBox').innerHTML=''; $('#ytPlayerBox').appendChild(v); YTS.video=v; ytNoPlay('');
    } else ytNoPlay('미리보기 영상을 받지 못했습니다. 시간을 직접 적어 구간을 고르세요. 악보용 다운로드는 그대로 됩니다.\n('+data.error+')');
    return;
  }
  if (kind==='yt_progress'){ const p=Math.round(data.f*100); $('#ytBar').style.width=p+'%'; $('#ytProgText').textContent = data.f<0.9 ? `소리 받는 중 ${p}%` : `구간 잘라 내는 중 ${p}%`; }
  else if (kind==='yt_done'){ YTS.busy=false; ytStopPlayer(); openPath(data.path); }
  else if (kind==='yt_error'){ YTS.busy=false; $('#ytProg').hidden=true; $('#ytActions').hidden=false; $('#ytErr2').textContent=data; $('#ytErr2').hidden=false; }
}

/* ---------- 화면 전환과 파일 열기 ---------- */
function show(id){ ['start','yt','working','editor'].forEach(s => $('#'+s).hidden = s!==id); }

async function loadRecent(){
  const items = await API.recent();
  $('#recent').hidden = !items.length;
  $('#recentList').innerHTML = items.map((it,i) => `<li><button data-i="${i}"><span>${xmlEsc(it.name)}</span><span class="when">${new Date(it.when*1000).toLocaleString('ko-KR',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'})}</span></button></li>`).join('');
  $('#recentList').onclick = e => { const b=e.target.closest('button[data-i]'); if (b) openPath(items[+b.dataset.i].path); };
}
async function chooseAndOpen(){ const p = await API.choose_file(); if (p) openPath(p); }

async function openPath(path){
  if (playing) pause();
  const info = await API.open(path);
  if (info.error){ toast(info.error); return; }
  S.path=info.path; S.name=info.name; S.isVideo=info.isVideo;
  const m=media(); delete m.dataset.proxy; m.src=info.media;
  m.hidden=!info.isVideo; $('#kbd').hidden=info.isVideo;
  if (info.result){ startEditor(info.result, info.edits); return; }
  show('working'); $('#workName').textContent=info.name;
  $('#workErr').hidden=true; $('#backBtn').hidden=true; setStep('model'); $('#barFill').style.width='0%'; $('#pct').textContent='';
  API.transcribe(path);
}
window.openPath = openPath;

function setStep(stage){
  const order=['model','notes','score'], ids={model:'stModel', notes:'stNotes', score:'stScore'}, k=order.indexOf(stage);
  order.forEach((s,i) => { const el=$('#'+ids[s]); el.className = i<k ? 'ok' : i===k ? 'now' : ''; });
}
window.onEngine = (kind, data) => {
  if (kind.startsWith('yt_')){ ytEvent(kind, data); return; }
  if (kind==='progress'){
    setStep(data.stage);
    if (data.stage==='notes'){ $('#pct').textContent=Math.round(data.f*100)+'%'; $('#barFill').style.width=(5+data.f*90)+'%'; }
  } else if (kind==='done'){
    setStep('score'); $('#barFill').style.width='100%';
    setTimeout(() => startEditor(data, null), 30);
  } else if (kind==='error'){
    $('#workErr').textContent='인식하지 못했습니다.\n'+data; $('#workErr').hidden=false; $('#backBtn').hidden=false;
  }
};

function startEditor(result, edits){
  S.result=result; S.duration=result.duration||0; S.pedals=result.pedals||[]; S.sel=null; hist.length=0; $('#undo').disabled=true;
  if (edits && edits.notes){
    S.notes=edits.notes; Object.assign(S, DEFAULTS, edits.settings||{}); nid=edits.nid || (Math.max(0,...S.notes.map(n=>n.id))+1);
  } else freshFromResult();
  const ps=S.notes.map(n=>n.p);
  ROLL.minP = clamp(Math.min(48, ...ps)-3, 21, 60); ROLL.maxP = clamp(Math.max(84, ...ps)+3, 72, 108);
  $('#fileName').textContent=S.name; $('#fileLen').textContent=fmtT(S.duration);
  $('#fileInfo').textContent = `음 ${result.notes.length}개 인식` + (result.seconds ? ` · ${result.seconds}초 걸림` : '');
  show('editor'); syncControls(); update();
  if (!result.notes.length) toast('피아노 음을 찾지 못했습니다. 피아노 소리가 있는 구간인지 확인하세요.');
  try { renderScore(); } catch(e){ console.error(e); }
  requestAnimationFrame(() => { $('#rollScroll').scrollLeft = Math.max(0, S.offset*S.zoom-60); dirty=true; });
}
function freshFromResult(){
  nid=1;
  S.notes = S.result.notes.map(n => ({id:nid++, p:n.p, t:n.t, d:n.d, v:n.v, c:n.c, hand:null, ok:false}));
  Object.assign(S, DEFAULTS);
  ENV = onsetEnvelope();
  S.bpm = S.autoBpm = estimateTempo(ENV);
  const firstLoud = S.notes.find(n => n.v >= 30) || S.notes[0];
  S.offset = firstLoud ? +firstLoud.t.toFixed(3) : 0;
}
async function resetEdits(){
  if (!S.result) return;
  pushHist(); freshFromResult(); S.sel=null; syncControls(); update();
  toast('처음 인식 결과로 돌아갔습니다. Ctrl+Z로 되돌릴 수 있습니다.');
}

/* ---------- 루프 ---------- */
let dirty=true, lastMeasure=-1;
function frame(){
  if (!$('#editor').hidden && A){
    if (playing){ advanceSynth(); advanceClicks(); dirty=true; }
    if (dirty){
      drawRoll(); drawKeys(); drawKbd();
      const tot=totalSec(), t=now(); $('#timeNow').textContent=`${fmtT(t)} / ${fmtT(tot)}`;
      if (document.activeElement!==$('#seek')) $('#seek').value=Math.round(t/tot*1000);
      const mi=Math.floor(beatPos(t)/BPMEAS[S.ts]);
      if (mi!==lastMeasure){ layout.forEach(L => L.el && L.el.classList.toggle('now', L.i===mi)); lastMeasure=mi; }
      dirty=false;
    }
  }
  requestAnimationFrame(frame);
}

window.__dev = {printPages, musicXml, ytRange:(a,b) => { ytSet('end',b); ytSet('start',a); },
  ytPlayer:() => { try { return YTS.player && YTS.player.getDuration ? YTS.player.getDuration() : 0; } catch(e){ return -1; } },
  ytFallback, ytVideo:() => YTS.video && YTS.video.duration || 0,
  measure:i => { const m=A.measures[i]; const f=h => ({clef:m[h].clef, change:m[h].change && {beat:(m[h].change.tick-i*A.M)/TPB, clef:m[h].change.clef}, voices:m[h].voices.map(v => ({stem:v.stem,
    items:v.items.map(it => it.c ? `${it.s-i*A.M}-${it.e-i*A.M}:${[...it.c.byP.keys()].join('/')}` : `${it.s-i*A.M}-${it.e-i*A.M}:rest${it.ghost?'(숨김)':''}`)}))});
    return JSON.stringify({R:f('R'), L:f('L')}); },
  // 함께 친 화음 중, 음을 하나씩 따로 박자 칸에 맞췄다면 쪼개졌을 화음 수
  wouldSplit:() => { const ns = S.notes.filter(visible).sort((a,b) => a.t-b.t); let n = 0;
    for (let i=0; i<ns.length;){ let j=i+1; while (j<ns.length && ns[j].t-ns[i].t < CHORD_TOGETHER) j++;
      const pos = new Set(ns.slice(i,j).map(x => Math.round(beatPos(x.t)*TPB/gridTicks()))); if (pos.size>1) n++; i=j; } return n; },
  // 입력(인식된 음)과 악보를 음 하나하나 대조해 이상한 곳을 센다 (점검용, 고치지 않음)
  audit:(nEx=5) => {
    const bm = BPMEAS[S.ts], mOf = t => Math.floor(beatPos(t)/bm)+1, nm = p => pitchName(p, A.key.flats);
    const vis = S.notes.filter(visible), ins = vis.filter(n => !GRACE.ids.has(n.id));
    const rec = new Map(), slots = new Map(), ties = {n:0, bar:0};
    A.measures.forEach((m,i) => ['R','L'].forEach(h => m[h].voices.forEach((v,vi) => {
      const its = v.items;
      for (let k=0; k<its.length; k++){
        const it = its[k]; if (!it.c) continue;
        if (pieces(it, A.trip[h]).length > 1) ties.n++;
        if (it.s !== it.c.start && !it.cont) continue;
        let e = it.e, j = k; while (its[j].tie && j+1<its.length && its[j+1].c===it.c){ j++; e = its[j].e; }
        if (it.cont){   // 앞 마디에서 붙임줄로 이어진 부분까지 쓴 길이에 더한다
          ties.bar++;
          for (const id of it.c.byP.values()){ const r = rec.get(id); if (r) r.e = Math.max(r.e, e); }
          continue;
        }
        for (const [p,id] of it.c.byP) rec.set(id, {m:i+1, s:it.s, e, h, vi, bar:(i+1)*A.M});
        const key = `${i}|${it.s}`; if (!slots.has(key)) slots.set(key, {R:[[],[]], L:[[],[]], m:i+1});
        slots.get(key)[h][vi].push(...it.c.byP.keys());
      }
    })));
    const R = {}, ex = (arr, f, n=nEx) => arr.slice(0,n).map(f);
    R['입력 음(보이는 음)'] = vis.length; R['꾸밈음으로 처리'] = GRACE.ids.size;
    const lost = ins.filter(n => !rec.has(n.id));
    R['악보에서 빠진 음'] = {개수:lost.length, 예:ex(lost, n => `${mOf(n.t)}마디 ${nm(n.p)}`)};
    const shifted = ins.filter(n => rec.has(n.id)).map(n => ({n, d:rec.get(n.id).s/TPB - beatPos(n.t)})).filter(x => Math.abs(x.d) > 0.2)
      .sort((a,b) => Math.abs(b.d)-Math.abs(a.d));
    R['시작이 0.2박 넘게 밀린 음'] = {개수:shifted.length, 예:ex(shifted, x => `${mOf(x.n.t)}마디 ${nm(x.n.p)} ${x.d>0?'+':''}${x.d.toFixed(2)}박`)};
    const short = [], barCut = [], long = [];
    ins.forEach(n => {
      const r = rec.get(n.id); if (!r) return;
      const held = beatPos(n.t+n.d) - beatPos(n.t), wrote = (r.e-r.s)/TPB, sound = beatPos(pedalEnd(n)) - beatPos(n.t);
      if (held >= 1 && wrote < held*0.5) (r.e===r.bar && r.s/TPB+held > r.bar/TPB ? barCut : short).push({n, held, wrote});
      if (wrote >= 1 && wrote > Math.max(held, sound)*2) long.push({n, held, wrote});
    });
    const fmtD = x => `${mOf(x.n.t)}마디 ${nm(x.n.p)} 누름 ${x.held.toFixed(1)}박→악보 ${x.wrote.toFixed(2)}박`;
    R['누른 것보다 절반 넘게 짧게 쓴 음 (다음 음 때문)'] = {개수:short.length, 예:ex(short, fmtD)};
    R['마디선에서 잘린 음 (다음 마디로 안 이어짐)'] = {개수:barCut.length, 예:ex(barCut, fmtD)};
    R['소리보다 두 배 넘게 길게 쓴 음'] = {개수:long.length, 예:ex(long, fmtD)};
    const pickup = ins.filter(n => beatPos(n.t) < -0.25);
    R['첫 박보다 앞에 있어 맨 앞에 뭉친 음'] = {개수:pickup.length, 예:ex(pickup, n => `${nm(n.p)} ${beatPos(n.t).toFixed(2)}박`)};
    let handCross = [], voiceCross = [];
    slots.forEach((s,key) => {
      const r = [...s.R[0], ...s.R[1]], l = [...s.L[0], ...s.L[1]];
      if (r.length && l.length && Math.max(...l) > Math.min(...r)) handCross.push(`${s.m}마디 왼손 ${nm(Math.max(...l))} > 오른손 ${nm(Math.min(...r))}`);
      if (s.R[1].length && s.R[0].length && Math.max(...s.R[1]) > Math.min(...s.R[0])) voiceCross.push(`${s.m}마디 오른손`);
      if (s.L[1].length && s.L[0].length && Math.max(...s.L[1]) > Math.min(...s.L[0])) voiceCross.push(`${s.m}마디 왼손`);
    });
    R['같은 순간 왼손이 오른손보다 높음'] = {개수:handCross.length, 예:handCross.slice(0,5)};
    R['두 성부가 위아래로 엇갈림'] = {개수:voiceCross.length, 예:voiceCross.slice(0,5)};
    R['같은 칸에 몰린 따로 친 음 (옮김 전 → 남은 것)'] = {개수:`${A.crowd.before} → ${A.crowd.after}`, 예:ex(A.crowd.left, c => `${Math.floor(c.start/A.M)+1}마디 ${c.h==='R'?'오른손':'왼손'} ${(c.start%A.M/TPB+1).toFixed(2)}박 (${Math.round(c.gap*1000)}ms 차)`)};
    R['붙임줄로 쪼갠 음표 묶음'] = ties.n; R['마디를 넘는 붙임줄'] = ties.bar;
    R['보이는 쉼표'] = A.measures.reduce((s,m) => s + ['R','L'].reduce((a,h) => a + m[h].voices.reduce((b,v) =>
      b + v.items.filter(it => !it.c && !it.ghost && !v.ghost).length, 0), 0), 0);
    const hidden = S.notes.filter(n => !visible(n));
    R['약한 음으로 숨긴 음'] = {개수:hidden.length, '그중 확신도 80% 이상':hidden.filter(n => n.c >= 0.8).length,
      예:ex(hidden.filter(n => n.c >= 0.8), n => `${mOf(n.t)}마디 ${nm(n.p)} 세기${n.v} 확신${Math.round(n.c*100)}%`)};
    R['확인 필요(확신도 낮음)'] = reviewList().length;
    const last = beatPos(lastNoteEnd()), iv = [];
    for (let k=0; k+1<BEATS.length && k<last; k++) iv.push(60/(BEATS[k+1]-BEATS[k]));
    R['박 추적 템포 범위(BPM)'] = `${Math.round(Math.min(...iv))} ~ ${Math.round(Math.max(...iv))} (평균 ${avgTempo()})`;
    const errMs = ins.filter(n => rec.has(n.id)).map(n => Math.abs(timeAt(rec.get(n.id).s/TPB) - n.t)*1000);
    R['박자 칸에 맞추며 옮긴 거리(ms)'] = `평균 ${Math.round(errMs.reduce((a,b)=>a+b,0)/errMs.length)}, 100ms 넘음 ${errMs.filter(x => x>100).length}개`;
    R['셋잇단으로 쓴 박'] = {오른손:A.trip.R.size, 왼손:A.trip.L.size};
    R['32분음표로 쓴 박'] = {오른손:A.fast.R.size, 왼손:A.fast.L.size};
    R['두 성부 마디'] = A.measures.filter(m => m.R.voices.length>1 || m.L.voices.length>1).length;
    R['마디 중간 음자리표 변경'] = A.measures.filter(m => m.R.change || m.L.change).length;
    return JSON.stringify(R, null, 1);
  },
  beats:() => JSON.stringify({offset:S.offset, bpm:S.bpm, follow:S.follow, ts:S.ts, beats:BEATS.map(x => +x.toFixed(3))}),
  useBeats:arr => { DEV_BEATS = arr; update(); return A.measures.length; },
  measureTime:i => { const bm=BPMEAS[S.ts]; return [+timeAt(i*bm).toFixed(3), +timeAt((i+1)*bm).toFixed(3)]; },
  inputOf:i => { const bm=BPMEAS[S.ts], t0=timeAt(i*bm), t1=timeAt((i+1)*bm);
    return JSON.stringify(S.notes.filter(n => visible(n) && n.t>=t0-0.05 && n.t<t1).sort((a,b) => a.t-b.t)
      .map(n => `${n.p}${handOf(n)} 박${(beatPos(n.t)-i*bm).toFixed(2)} 길이${((beatPos(n.t+n.d)-beatPos(n.t))).toFixed(2)}박${GRACE.ids.has(n.id)?' 꾸밈':''}`)); },
  notesIn:(t0,t1) => JSON.stringify(S.notes.filter(n => n.t>=t0 && n.t<t1).map(n => [n.p, +n.t.toFixed(2), +n.d.toFixed(2), handOf(n)])),
  state:() => ({notes:S.notes.length, measures:A && A.measures.length, bpm:S.bpm,
  offset:S.offset, key:A && A.auto.name, svg:!!$('#score svg'), piano:PIANO.size, graces:GRACE.ids.size,
  hands:[...AUTOHAND.values()].reduce((o,h) => (o[h]=(o[h]||0)+1, o), {}), errors:window.__errors || []})};

function init(api){
  API = api;
  if (API.log){
    window.__errors = [];
    const report = msg => { window.__errors.push(msg); API.log(msg); };
    window.addEventListener('error', e => report(`${e.message} @${e.lineno}:${e.colno}`));
    window.addEventListener('unhandledrejection', e => report('promise: '+(e.reason && (e.reason.stack || e.reason))));
  }
  bindControls(); bindRoll(); bindYouTube();
  loadPiano();
  setVolume(1, false);
  if (API.get_pref) API.get_pref('volume').then(v => { if (typeof v === 'number') setVolume(v, false); });
  $('#openBtn').addEventListener('click', chooseAndOpen);
  $('#backBtn').addEventListener('click', () => { show('start'); loadRecent(); });
  let rw=0; new ResizeObserver(() => { dirty=true; const w=$('#score').clientWidth; if (A && Math.abs(w-rw)>4){ rw=w; scheduleScore(); } }).observe(document.body);
  const mq=window.matchMedia('(prefers-color-scheme: dark)'); if (mq.addEventListener) mq.addEventListener('change', () => { dirty=true; scheduleScore(); });
  requestAnimationFrame(frame);
  if (params.has('yt')) API.yt_info().then(ytEnter);
  else if (params.has('demo')) openPath('demo'); else loadRecent();
}
if (params.has('demo')) init(devApi());
else if (window.pywebview && window.pywebview.api) init(window.pywebview.api);
else window.addEventListener('pywebviewready', () => init(window.pywebview.api), {once:true});
})();
