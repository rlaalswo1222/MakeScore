// 양손 자동 나누기 시험: 손을 알고 있는 테스트 곡으로 정확도를 잰다.
// 사용법: node tools/test_hands.js
const {assign} = require('../scoremake/ui/hands.js');

const T3 = 1/3, SPB = 60/92;
const RH = [[71,0,1],[74,1,.5],[72,1.5,.5],[71,2,1],[67,3,1],[76,4,1.5],[74,5.5,.5],[72,6,1],[76,7,1],
  [74,8,1],[78,9,.5],[76,9.5,.5],[74,10,1],[69,11,1],[71,12,2],[74,14,1],
  [79,16,1],[78,17,.5],[76,17.5,.5],[74,18,1],[71,19,1],
  [72,20,T3],[74,20+T3,T3],[76,20+2*T3,T3],[79,21,1],[76,22,1],[72,23,1],
  [74,24,1],[72,25,.5],[71,25.5,.5],[69,26,1],[66,27,1],[67,28,4],[71,28,4],[74,28,4]];
const CHORDS = [[43,[47,50]],[48,[52,55]],[50,[54,57]],[43,[47,50]],[40,[47,52]],[48,[52,55]],[50,[54,60]]];
const LH = [];
CHORDS.forEach(([r,t],i) => { const b=i*4; LH.push([r,b,1]); t.forEach(p=>LH.push([p,b+1,1])); LH.push([r+7,b+2,1]); t.forEach(p=>LH.push([p,b+3,1])); });
LH.push([43,28,4],[47,28,4],[50,28,4]);

// 오른손 멜로디가 왼손 영역(C4 아래)까지 내려가는 구간도 하나 덧붙인다
const extraR = [[60,32,1],[59,33,1],[57,34,1],[55,35,1]], extraL = [[36,32,4],[43,32,4]];

let id=0; const notes=[], truth=new Map();
for (const [part, hand] of [[RH,'R'],[LH,'L'],[extraR,'R'],[extraL,'L']])
  for (const [p,b] of part){ const n={id:id++, p, t:b*SPB + (Math.random()-0.5)*0.02}; notes.push(n); truth.set(n.id, hand); }

function check(label, ns, split){
  const got = assign(ns, split);
  const wrong = ns.filter(n => got.get(n.id)!==truth.get(n.id));
  const lineWrong = ns.filter(n => (n.p>=split?'R':'L')!==truth.get(n.id));
  const pct = k => (100*(1-k/ns.length)).toFixed(1);
  console.log(`[${label}] 자동 ${pct(wrong.length)}% · 경계선만 ${pct(lineWrong.length)}%`);
  wrong.forEach(n => console.log(`  틀림: 음 ${n.p}, ${n.t.toFixed(2)}초, 정답 ${truth.get(n.id)}`));
}
check('기본 음역, 기준선 C4', notes, 60);
// 오른손 음역이 낮은 곡: 전체를 5반음 내리고 기준선도 G3로 내린다
check('낮은 음역, 기준선 G3', notes.map(n => ({...n, p:n.p-5})), 55);
