// 실제 인식 결과에서 한 손이 닿지 않는 화음이 몇 곳인지 센다 (경계선 방식 vs 자동 방식).
// 사용법: node tools/check_playable.js 프로젝트.json [기준선 MIDI, 기본 55=G3]
const fs = require('fs');
const {assign, unplayable} = require('../scoremake/ui/hands.js');

const data = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const split = +(process.argv[3] || 55);
const notes = (data.edits && data.edits.notes) || data.result.notes.map((n,i) => ({...n, id:i}));
// 악보처럼 박자 칸으로 묶는다 (저장된 템포·첫 박·음표 단위 사용, 템포 변화는 무시한 근사)
const st = (data.edits && data.edits.settings) || {};
const spb = 60/(st.bpm || 100), off = st.offset || 0, grid = st.grid || 3;
const vis = notes.filter(n => n.v >= 12).map(n => ({...n, g:Math.round((n.t-off)/spb*12/grid)}));
const auto = assign(vis, split);
console.log(`음 ${vis.length}개, 기준선 MIDI ${split}`);
console.log(`경계선 방식: 손이 닿지 않는 화음 ${unplayable(vis, n => n.p >= split ? 'R' : 'L')}곳`);
console.log(`자동 방식:   손이 닿지 않는 화음 ${unplayable(vis, n => auto.get(n.id))}곳`);
