"""유튜브(또는 인스타 릴스 등 yt-dlp가 아는 사이트) 링크 → 영상 정보 읽기, 원하는 구간만 받기.

유튜브가 자주 바뀌므로 yt-dlp는 exe에 넣지 않고 공식 배포본을 받아 두고 스스로 업데이트한다.
요즘 유튜브는 JavaScript 실행기(deno/node/bun)가 있어야 받을 수 있다.
"""
import json
import os
import re
import shutil
import subprocess
import threading
import time
import urllib.request

from .ffmpeg import NO_WINDOW, find_ffmpeg

DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScoreMake")
YTDLP = os.path.join(DATA_DIR, "bin", "yt-dlp.exe")
YTDLP_URL = "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"
UPDATE_EVERY = 2 * 24 * 3600
OUT_DIR = os.path.join(os.path.expanduser("~"), "Videos", "ScoreMake")
FULL_DIR = os.path.join(DATA_DIR, "ytaudio")       # 구간을 잘라 낼 소리 원본 (같은 영상의 다른 구간은 다시 안 받음)
PREVIEW_DIR = os.path.join(DATA_DIR, "ytpreview")  # 퍼가기가 막힌 영상의 구간 고르기용 저화질
KEEP = 7 * 24 * 3600
# 인식에는 소리만 쓰므로 악보용은 소리만 받는다. m4a(AAC)는 그대로 잘라 붙일 수 있고 프로그램 안에서 바로 재생된다
AUDIO_FORMAT, AUDIO_SORT = "ba/b", "ext:m4a"
# res는 짧은 변 기준이라 세로 영상도 제대로 고른다
PREVIEW_FORMAT, PREVIEW_SORT = "bv*+ba/b", "res:240,ext:mp4:m4a"
STALL = 60  # 이 시간(초) 동안 아무 출력이 없으면 멈춘 것으로 보고 끊는다
FORBIDDEN_TRIES = 3  # 403(막힌 주소)이 나면 처음부터 다시 받아 보는 횟수

KNOWN_ERRORS = [
    ("Private video", "비공개 영상이라 받을 수 없습니다."),
    ("Video unavailable", "볼 수 없는 영상입니다. 삭제되었거나 지역 제한이 있을 수 있습니다."),
    ("Sign in to confirm your age", "연령 제한 영상이라 로그인 없이 받을 수 없습니다."),
    ("members-only", "채널 회원 전용 영상이라 받을 수 없습니다."),
    ("is not a valid URL", "영상 링크가 아닙니다."),
    ("Unsupported URL", "지원하지 않는 링크입니다. 유튜브나 인스타그램 게시물 링크를 넣어 주세요."),
    ("login required", "로그인해야 볼 수 있는 게시물이라 받을 수 없습니다. 비공개 계정이거나 인스타그램이 잠시 막았을 수 있습니다."),
    ("There is no video in this post", "이 게시물에는 영상이 없습니다."),
    ("Unable to download webpage", "인터넷 연결을 확인하세요."),
]


def _ensure_ytdlp():
    if not os.path.exists(YTDLP):
        os.makedirs(os.path.dirname(YTDLP), exist_ok=True)
        tmp = YTDLP + ".part"
        urllib.request.urlretrieve(YTDLP_URL, tmp)
        os.replace(tmp, YTDLP)
    elif time.time() - os.path.getmtime(YTDLP) > UPDATE_EVERY:
        subprocess.run([YTDLP, "-U"], capture_output=True, creationflags=NO_WINDOW, timeout=120)
        os.utime(YTDLP)


def _js_runtime():
    for name in ("deno", "node", "bun"):
        path = shutil.which(name)
        if path:
            return ["--js-runtimes", f"{name}:{path}"]
    raise RuntimeError("유튜브에서 받으려면 Node.js가 필요합니다. https://nodejs.org 에서 설치한 뒤 다시 시도하세요.")


def _error_text(output):
    text = output.decode("utf-8", errors="ignore") if isinstance(output, bytes) else output
    for needle, message in KNOWN_ERRORS:
        if needle in text:
            return message
    errors = [line for line in text.splitlines() if "ERROR" in line]
    return (errors[-1] if errors else text.strip()[-300:]) or "알 수 없는 오류"


def info(url):
    _ensure_ytdlp()
    proc = subprocess.run([YTDLP, *_js_runtime(), "--no-playlist", "--no-warnings", "-J", url],
                          capture_output=True, creationflags=NO_WINDOW, timeout=120)
    if proc.returncode != 0:
        raise RuntimeError(_error_text(proc.stderr))
    data = json.loads(proc.stdout)
    if data.get("_type") == "playlist":
        raise RuntimeError("영상이 여러 개인 게시물입니다. 영상 하나의 링크를 넣어 주세요.")
    site = data.get("extractor_key") or ""
    youtube = site == "Youtube"
    if data.get("is_live") or (youtube and not data.get("duration")):
        raise RuntimeError("생방송이나 길이를 알 수 없는 영상은 받을 수 없습니다.")
    # 유튜브가 아니면 화면에서 유튜브 플레이어 대신 받아 둔 미리보기 영상을 쓴다.
    # 인스타그램은 길이를 알려 주지 않아(0) 미리보기 영상을 받은 뒤 화면이 길이를 읽는다
    vid = data["id"] if youtube else f"{site.lower() or 'web'}_{data['id']}"
    title = data.get("title") or data["id"]
    if site == "Instagram" and title.startswith("Video by ") and data.get("description"):
        title = data["description"].strip().splitlines()[0][:60] or title  # "Video by 아이디"보다 글 첫 줄이 알아보기 쉽다
    return {"id": vid, "title": title, "duration": data.get("duration") or 0, "youtube": youtube,
            "site": "유튜브" if youtube else ("인스타그램" if site == "Instagram" else site),
            "uploader": data.get("uploader") or data.get("channel") or "", "url": data.get("webpage_url") or url}


def _stamp(sec):
    sec = int(round(sec))
    return f"{sec // 60}분{sec % 60:02d}초"


class Download:
    """yt-dlp 작업 하나. progress(0~1)를 불러 주고, 끝나면 파일 경로를 돌려준다."""

    def __init__(self):
        self.proc = None
        self.cancelled = False

    def cancel(self):
        self.cancelled = True
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    def _exec(self, cmd, path, on_line):
        """cmd를 돌리며 출력 줄마다 on_line을 부른다. 출력이 STALL초 넘게 없으면 멈춘 것으로 보고 끊는다."""
        self.proc = subprocess.Popen(cmd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                     creationflags=NO_WINDOW)
        last, stalled = [time.time()], [False]

        def watchdog(proc):
            while proc.poll() is None:
                if time.time() - last[0] > STALL:
                    stalled[0] = True
                    proc.kill()
                    return
                time.sleep(2)

        threading.Thread(target=watchdog, args=(self.proc,), daemon=True).start()
        tail, buf = [], b""
        while True:
            chunk = self.proc.stdout.read1(4096)
            if not chunk:
                break
            last[0] = time.time()
            buf += chunk
            parts = re.split(rb"[\r\n]", buf)
            buf = parts.pop()
            for line in parts:
                if line.strip():
                    tail = (tail + [line])[-40:]
                    on_line(line)
        code = self.proc.wait()
        if self.cancelled:
            raise RuntimeError("취소했습니다.")
        if stalled[0]:
            raise RuntimeError("1분 넘게 진행이 없어 중단했습니다. 인터넷 연결을 확인하고 다시 시도하세요.")
        if code != 0 or not os.path.exists(path):
            raise RuntimeError(_error_text(b"\n".join(tail)))
        return path

    def _fetch(self, url, vid, fmt, sort, folder, progress):
        """영상 전체를 yt-dlp 기본 방식으로 받는다 (구간만 받는 방식은 유튜브 서버에서 자주 멈춘다)."""
        _ensure_ytdlp()
        os.makedirs(folder, exist_ok=True)
        for name in os.listdir(folder):
            old = os.path.join(folder, name)
            if time.time() - os.path.getmtime(old) > KEEP:
                try:
                    os.remove(old)
                except OSError:
                    pass
        vid = re.sub(r"[^A-Za-z0-9_-]", "", vid) or "video"
        done = [n for n in os.listdir(folder) if n.startswith(vid + ".") and not n.endswith((".part", ".ytdl"))]
        if done:
            return os.path.join(folder, done[0])
        parts, part = fmt.count("+") + 1, [0]  # 영상과 소리를 따로 받으면 두 번에 나눠 진행률을 센다

        def on_line(line):
            if b"Destination:" in line:
                part[0] += 1
            m = re.search(rb"\[download\]\s+([\d.]+)%", line)
            if m:
                progress(min((min(max(part[0], 1), parts) - 1 + float(m[1]) / 100) / parts, 1.0))

        args = [YTDLP, *_js_runtime(), "--no-playlist", "--no-warnings", "--newline",
                "--ffmpeg-location", os.path.dirname(find_ffmpeg()), "-f", fmt, "-S", sort, "--http-chunk-size", "10M",
                "-o", os.path.join(folder, vid + ".%(ext)s"), url]
        if "+" in fmt:
            args[-1:-1] = ["--merge-output-format", "mp4"]
        result = []
        # 유튜브가 가끔 막힌 주소(403)를 준다. yt-dlp는 같은 주소로만 다시 시도하므로, 처음부터 다시 돌려 새 주소를 받는다
        for attempt in range(FORBIDDEN_TRIES):
            try:
                self._exec(args, folder, lambda line: (on_line(line), result.append(line)))
                break
            except RuntimeError as e:
                if "403" not in str(e) or self.cancelled:
                    raise
                if attempt == FORBIDDEN_TRIES - 1:
                    raise RuntimeError("유튜브가 다운로드를 잠시 막았습니다(403). 잠시 뒤 다시 시도하세요.") from e
                for name in os.listdir(folder):
                    if name.startswith(vid + ".") and name.endswith((".part", ".ytdl")):
                        os.remove(os.path.join(folder, name))
                part[0] = 0
                time.sleep(3)
        files = [n for n in os.listdir(folder) if n.startswith(vid + ".") and not n.endswith((".part", ".ytdl"))]
        if not files:
            raise RuntimeError(_error_text(b"\n".join(result[-40:])))
        return os.path.join(folder, files[0])

    def run(self, url, vid, start, end, title, progress):
        """소리를 받아 start~end 구간을 잘라 동영상\\ScoreMake 폴더에 m4a로 저장한다."""
        os.makedirs(OUT_DIR, exist_ok=True)
        safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]+', " ", title).strip()[:80].rstrip(". ") or "youtube"
        path = os.path.join(OUT_DIR, f"{safe} [{_stamp(start)}-{_stamp(end)}].m4a")
        if os.path.exists(path):
            return path
        full = self._fetch(url, vid, AUDIO_FORMAT, AUDIO_SORT, FULL_DIR, lambda f: progress(f * 0.9))
        length = max(0.1, end - start)

        def on_line(line):
            m = re.search(rb"time=(\d+):(\d+):(\d+(?:\.\d+)?)", line)
            if m:
                progress(0.9 + 0.1 * min((int(m[1]) * 3600 + int(m[2]) * 60 + float(m[3])) / length, 1.0))

        # m4a(AAC)는 다시 압축하지 않고 그대로 잘라 음질 손실이 없다. 다른 형식이면 높은 음질의 AAC로 바꾼다
        codec = ["-c:a", "copy"] if full.lower().endswith(".m4a") else ["-c:a", "aac", "-b:a", "256k"]
        tmp = path[:-4] + ".part.m4a"
        self._exec([find_ffmpeg(), "-y", "-hide_banner", "-ss", f"{start:.3f}", "-i", full, "-t", f"{length:.3f}",
                    "-vn", "-map", "0:a:0", *codec, "-movflags", "+faststart", tmp], tmp, on_line)
        os.replace(tmp, path)
        return path

    def preview(self, url, vid, progress):
        """퍼가기가 막힌 영상의 구간 고르기용으로 영상 전체를 저화질로 받는다."""
        return self._fetch(url, vid, PREVIEW_FORMAT, PREVIEW_SORT, PREVIEW_DIR, progress)
