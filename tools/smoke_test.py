"""엔진 동작 확인: 정답을 아는 곡을 합성음으로 만들어 인식시키고 정답과 비교한다.

사용법: python tools/smoke_test.py [출력 폴더]
합성음은 진짜 피아노 소리가 아니므로 점수는 참고용이다. 실제 정확도는 실제 녹음으로 잰다.
"""
import json
import os
import sys
import time
import wave

import numpy as np
import mir_eval

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scoremake.engine import Engine  # noqa: E402

FS = 44100
BPM, OFFSET = 92, 0.42
T3 = 1 / 3
RH = [[71,0,1],[74,1,.5],[72,1.5,.5],[71,2,1],[67,3,1],[76,4,1.5],[74,5.5,.5],[72,6,1],[76,7,1],
      [74,8,1],[78,9,.5],[76,9.5,.5],[74,10,1],[69,11,1],[71,12,2],[74,14,1],
      [79,16,1],[78,17,.5],[76,17.5,.5],[74,18,1],[71,19,1],
      [72,20,T3],[74,20+T3,T3],[76,20+2*T3,T3],[79,21,1],[76,22,1],[72,23,1],
      [74,24,1],[72,25,.5],[71,25.5,.5],[69,26,1],[66,27,1],[67,28,4],[71,28,4],[74,28,4]]
CHORDS = [[43,[47,50]],[48,[52,55]],[50,[54,57]],[43,[47,50]],[40,[47,52]],[48,[52,55]],[50,[54,60]]]


def score():
    lh = []
    for i, (r, tones) in enumerate(CHORDS):
        b = i * 4
        lh.append([r, b, 1]); lh += [[p, b + 1, 1] for p in tones]
        lh.append([r + 7, b + 2, 1]); lh += [[p, b + 3, 1] for p in tones]
    lh += [[43, 28, 4], [47, 28, 4], [50, 28, 4]]
    spb = 60 / BPM
    rng = np.random.default_rng(1)
    notes = []
    for part, vel in ((RH, 0.75), (lh, 0.5)):
        for p, b, d in part:
            notes.append((p, OFFSET + b * spb + rng.normal(0, 0.012), d * spb * 0.92, vel * rng.uniform(0.85, 1.1)))
    return notes


def synth(notes, length):
    """배음이 섞이고 소리가 서서히 줄어드는, 피아노에 가까운 합성음."""
    y = np.zeros(int(length * FS), dtype=np.float64)
    for p, t, d, a in notes:
        f = 440 * 2 ** ((p - 69) / 12)
        n = int((d + 0.6) * FS)
        tt = np.arange(n) / FS
        tone = sum((0.6 ** k) * np.sin(2 * np.pi * f * (k + 1) * tt * (1 + 0.0004 * k * k)) for k in range(8))
        env = np.exp(-tt * (1.2 + p / 60)) * np.minimum(1, tt / 0.004)
        env[int(d * FS):] *= np.exp(-(tt[int(d * FS):] - d) * 18)
        s = int(t * FS)
        y[s:s + n] += a * tone * env
    y /= np.abs(y).max() * 1.1
    return (np.stack([y, y], 1) * 32767).astype(np.int16)


def main():
    out = sys.argv[1] if len(sys.argv) > 1 else "."
    os.makedirs(out, exist_ok=True)
    ref = score()
    wav = os.path.join(out, "smoke.wav")
    with wave.open(wav, "wb") as w:
        w.setnchannels(2); w.setsampwidth(2); w.setframerate(FS)
        w.writeframes(synth(ref, max(t + d for _, t, d, _ in ref) + 1.5).tobytes())

    t0 = time.time(); eng = Engine(); print(f"모델 불러오기: {time.time() - t0:.1f}초")
    t0 = time.time()
    res = eng.transcribe(wav, progress=lambda f: print(f"  진행 {f * 100:.0f}%"))
    print(f"인식: {time.time() - t0:.1f}초 (곡 길이 {res['duration']:.1f}초), 음 {len(res['notes'])}개 / 정답 {len(ref)}개")
    with open(os.path.join(out, "smoke.json"), "w", encoding="utf-8") as f:
        json.dump(res, f)

    ri = np.array([[t, t + d] for _, t, d, _ in ref]); rp = np.array([440 * 2 ** ((p - 69) / 12) for p, *_ in ref])
    ei = np.array([[n["t"], n["t"] + n["d"]] for n in res["notes"]]); ep = np.array([440 * 2 ** ((n["p"] - 69) / 12) for n in res["notes"]])
    pr, rc, f1, _ = mir_eval.transcription.precision_recall_f1_overlap(ri, rp, ei, ep, offset_ratio=None)
    print(f"음 시작 기준  정밀도 {pr:.3f}  재현율 {rc:.3f}  F1 {f1:.3f}")

    match = mir_eval.transcription.match_notes(ri, rp, ei, ep, offset_ratio=None)
    hit = {j for _, j in match}
    conf_hit = [n["c"] for j, n in enumerate(res["notes"]) if j in hit]
    conf_miss = [n["c"] for j, n in enumerate(res["notes"]) if j not in hit]
    print(f"확신도 평균  맞은 음 {np.mean(conf_hit):.2f} ({len(conf_hit)}개)"
          + (f"  틀린 음 {np.mean(conf_miss):.2f} ({len(conf_miss)}개)" if conf_miss else "  틀린 음 없음"))
    for j, n in enumerate(res["notes"]):
        if j not in hit or n["c"] < 0.6:
            print(f"    {'오답' if j not in hit else '정답'}  p={n['p']} t={n['t']:.2f} v={n['v']} c={n['c']:.2f}")


if __name__ == "__main__":
    main()
