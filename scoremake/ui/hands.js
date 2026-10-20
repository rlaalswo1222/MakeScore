/* 양손 자동 나누기.
 *
 * 거의 동시에 친 음들을 한 덩어리로 묶고, 덩어리마다 "아래 몇 개는 왼손, 나머지는 오른손"으로 나누는 방법 중
 * 곡 전체에서 가장 자연스러운 것을 동적계획법으로 고른다. 자연스러움의 기준:
 *   - 한 손이 동시에 누르는 폭은 한 옥타브 남짓이다
 *   - 손은 갑자기 멀리 뛰지 않는다 (가까운 시간일수록 강하게)
 *   - 왼손이 오른손보다 위로 가지 않는다
 *   - 사용자가 정한 기준선(split) 위는 오른손, 아래는 왼손일 때가 많다 (약하게, 손이 닿는지가 먼저)
 */
(function(root){
'use strict';
const CHORD_GAP = 0.035;   // 이 시간(초) 안에 시작한 음은 함께 친 것으로 본다
const REACH = 12;          // 한 손 폭이 이 반음 수를 넘으면 벌점

function center(arr){ return arr.length ? (arr[0].p + arr[arr.length-1].p)/2 : null; }
function span(arr){ return arr.length ? arr[arr.length-1].p - arr[0].p : 0; }

function localCost(L, R, split, HOME){
  let c = 8*Math.max(0, span(L)-REACH)**2 + 8*Math.max(0, span(R)-REACH)**2;
  if (L.length > 5) c += 200*(L.length-5);       // 손가락은 다섯 개
  if (R.length > 5) c += 200*(R.length-5);
  const lc=center(L), rc=center(R);
  if (lc!==null) c += 0.04*Math.abs(lc-HOME.L);
  if (rc!==null) c += 0.04*Math.abs(rc-HOME.R);
  for (const n of L) if (n.p >= split) c += 0.3*(n.p-split+1);   // 기준선 위인데 왼손
  for (const n of R) if (n.p < split) c += 0.3*(split-n.p);      // 기준선 아래인데 오른손
  return c;
}

/* 함께 칠 음끼리 묶는다. 음에 g(악보에서 같은 박자 칸)가 있으면 그것으로, 없으면 시작 시각이 가까운 것끼리.
 * 악보는 같은 칸의 음을 한 화음으로 그리므로, 손이 닿는지도 그 묶음으로 따져야 한다. */
function groups(notes){
  const keyed = notes.length && notes[0].g !== undefined;
  const ns = notes.slice().sort(keyed ? (a,b) => a.g-b.g || a.p-b.p : (a,b) => a.t-b.t || a.p-b.p);
  const ev = [];
  for (const n of ns){
    const last = ev[ev.length-1];
    if (last && (keyed ? n.g===last.g : n.t-last.t < CHORD_GAP)) last.notes.push(n);
    else ev.push({t:n.t, g:n.g, notes:[n]});
  }
  return ev;
}

/* notes: [{id, p, t, g?}], split: 기준선(이 음 이상은 오른손일 때가 많다) → Map(id → 'L'|'R') */
function assign(notes, split=60){
  const HOME = {L:split-12, R:split+12};
  const out = new Map();
  const ev = groups(notes);
  ev.forEach(e => e.notes.sort((a,b) => a.p-b.p));
  const table = [];
  let prev = null;
  for (let i=0; i<ev.length; i++){
    const e=ev[i], k=e.notes.length, row=[];
    const move = prev ? 0.6/(1+(e.t-ev[i-1].t)/0.4) : 0;   // 멀리 떨어진 시간이면 손이 옮겨 갈 여유가 있다
    for (let s=0; s<=k; s++){
      const L=e.notes.slice(0,s), R=e.notes.slice(s), local=localCost(L,R,split,HOME), lc=center(L), rc=center(R);
      let best={cost:Infinity, back:-1, lc:lc ?? HOME.L, rc:rc ?? HOME.R};
      if (!prev) best.cost = local;
      else prev.forEach((st,j) => {
        const nl = lc ?? st.lc, nr = rc ?? st.rc;
        // 음마다 그 손의 직전 위치에서 얼마나 먼지 (가만히 있는 손에 공짜로 몰아주지 않도록 음 단위로 센다)
        let dist = 0;
        for (const n of L) dist += Math.max(0, Math.abs(n.p-st.lc)-2);
        for (const n of R) dist += Math.max(0, Math.abs(n.p-st.rc)-2);
        let c = st.cost + local + move*dist;
        if (nl > nr-2) c += 30;                                // 왼손이 오른손 위로
        if (c < best.cost) best = {cost:c, back:j, lc:nl, rc:nr};
      });
      row.push(best);
    }
    table.push(row); prev=row;
  }
  if (!table.length) return out;
  let s = 0, last = table[table.length-1];
  last.forEach((st,j) => { if (st.cost < last[s].cost) s=j; });
  for (let i=table.length-1; i>=0; i--){
    ev[i].notes.forEach((n,idx) => out.set(n.id, idx<s ? 'L' : 'R'));
    s = table[i][s].back;
  }
  return out;
}

/* 손이 닿지 않는 화음 수 (폭이 REACH+2 반음 초과이거나 5음 초과): handOf(n) → 'L'|'R' */
function unplayable(notes, handOf){
  let bad = 0;
  for (const e of groups(notes)) for (const h of ['L','R']){
    const ps = e.notes.filter(n => handOf(n)===h).map(n => n.p);
    if (ps.length > 5 || (ps.length && Math.max(...ps)-Math.min(...ps) > REACH+2)){ bad++; break; }
  }
  return bad;
}

const api = {assign, unplayable};
if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.ScoreHands = api;
})(this);
