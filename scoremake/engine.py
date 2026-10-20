"""음 인식 엔진: 영상/오디오 파일 → 음표 목록.

Transkun V2(Semi-CRF)로 음을 찾고, 같은 CRF의 forward-backward 주변확률로
음마다 '실제로 이 근처에서 음이 시작됐을 확률'(확신도)을 붙인다.
"""
import math
import os
import subprocess

import numpy as np
import torch

import moduleconf
import transkun
from transkun.CRF.NeuralSemiCRFInterval import forward_backward

from .ffmpeg import NO_WINDOW, find_ffmpeg

PRETRAINED = os.path.join(os.path.dirname(transkun.__file__), "pretrained")
ONSET_WINDOW = 2  # 확신도 계산 시 시작 프레임 앞뒤로 허용하는 프레임 수 (1프레임 ≈ 23ms)


def extract_audio(path, fs):
    """영상이든 오디오든 ffmpeg로 [샘플, 2채널] float32 배열을 뽑는다."""
    cmd = [find_ffmpeg(), "-v", "error", "-i", path, "-vn", "-ac", "2", "-ar", str(fs), "-f", "f32le", "-"]
    proc = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW)
    if proc.returncode != 0:
        raise RuntimeError("소리를 읽지 못했습니다: " + proc.stderr.decode(errors="ignore").strip())
    audio = np.frombuffer(proc.stdout, dtype=np.float32).reshape(-1, 2)
    if len(audio) == 0:
        raise RuntimeError("이 파일에는 소리가 없습니다.")
    return audio


class Engine:
    def __init__(self, device="cpu", weight=None, conf=None):
        torch.set_num_threads(os.cpu_count() or 4)
        torch.set_grad_enabled(False)
        manager = moduleconf.parseFromFile(conf or os.path.join(PRETRAINED, "2.0.conf"))
        model = manager["Model"].module.TransKun(conf=manager["Model"].config).to(device)
        # 패키지에 들어 있는 체크포인트에는 설정 객체도 들어 있어 weights_only=False가 필요하다
        ckpt = torch.load(weight or os.path.join(PRETRAINED, "2.0.pt"), map_location=device, weights_only=False)
        model.load_state_dict(ckpt.get("best_state_dict", ckpt.get("state_dict")), strict=False)
        model.eval()
        self.model = model
        self.device = device
        self.frame_dur = model.hopSize / model.fs
        self._crf = None
        self._progress = None
        self._done = 0
        self._total = 1

        # Transkun 내부 두 함수를 감싸서, 구간마다 CRF를 붙잡아 두고 음마다 확신도를 단다
        orig_process = model.processFramesBatch
        orig_frames = model.transcribeFrames

        def process(frames):
            crf, ctx = orig_process(frames)
            self._crf = crf
            return crf, ctx

        def frames(framesBatch, *args, **kwargs):
            notes, last = orig_frames(framesBatch, *args, **kwargs)
            self._attach_confidence(notes)
            self._done += 1
            if self._progress:
                self._progress(min(self._done / self._total, 1.0))
            return notes, last

        model.processFramesBatch = process
        model.transcribeFrames = frames

    def _attach_confidence(self, notes_batch):
        crf = self._crf
        if crf is None or not any(notes_batch):
            return
        _, marginal, _ = forward_backward(crf.score, crf.noiseScore)  # [끝, 시작, 트랙]
        onset = marginal.sum(0)                                       # [시작 프레임, 트랙]
        k = ONSET_WINDOW
        cum = torch.nn.functional.pad(onset.cumsum(0), (0, 0, 1, 0))
        n_frames = onset.shape[0]
        symbols = list(self.model.targetMIDIPitch)
        for b, notes in enumerate(notes_batch):
            for n in notes:
                track = b * len(symbols) + symbols.index(n.pitch)
                f = min(max(int(round(n.start / self.frame_dur)), 0), n_frames - 1)
                lo, hi = max(f - k, 0), min(f + k + 1, n_frames)
                n.conf = float(min(1.0, (cum[hi, track] - cum[lo, track]).item()))

    def transcribe(self, path, progress=None):
        """path의 소리를 인식해 {duration, notes, pedals}를 돌려준다.

        notes: [{p: MIDI 음높이, t: 시작(초), d: 길이(초), v: 세기 0~127, c: 확신도 0~1}]
        pedals: [{type: 'sustain'|'sostenuto'|'soft', t, d}]
        """
        model = self.model
        audio = extract_audio(path, model.fs)
        x = torch.from_numpy(audio.copy()).to(self.device)

        # Transkun.transcribe의 구간 나누기와 같은 계산으로 전체 구간 수를 미리 구한다
        hop_s, seg_s = model.segmentHopSizeInSecond, model.segmentSizeInSecond
        n_sample = len(audio) + 2 * math.ceil((seg_s - hop_s) * model.fs)
        step = math.ceil(hop_s * model.fs / model.hopSize) * model.hopSize
        self._total = max(1, math.ceil(n_sample / step))
        self._done = 0
        self._progress = progress

        raw = model.transcribe(x, discardSecondHalf=False)

        pedal_names = {64: "sustain", 66: "sostenuto", 67: "soft"}
        notes, pedals = [], []
        for n in raw:
            t, d = round(float(n.start), 4), round(float(n.end - n.start), 4)
            if n.pitch > 0:
                notes.append({"p": int(n.pitch), "t": t, "d": d, "v": int(n.velocity),
                              "c": round(getattr(n, "conf", 1.0), 3)})
            else:
                pedals.append({"type": pedal_names.get(-n.pitch, str(-n.pitch)), "t": t, "d": d})
        notes.sort(key=lambda n: (n["t"], n["p"]))
        pedals.sort(key=lambda e: e["t"])
        return {"duration": round(len(audio) / model.fs, 3), "notes": notes, "pedals": pedals}
