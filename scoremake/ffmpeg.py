"""ffmpeg 위치 찾기 (torch를 불러오지 않는 가벼운 모듈)."""
import os
import shutil
import subprocess
import sys

NO_WINDOW = subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0


def find_ffmpeg():
    """exe에 같이 넣은 ffmpeg를 먼저 찾고, 없으면 PATH에서 찾는다."""
    base = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    bundled = os.path.join(base, "bin", "ffmpeg.exe")
    if os.path.exists(bundled):
        return bundled
    found = shutil.which("ffmpeg")
    if not found:
        raise RuntimeError("ffmpeg를 찾을 수 없습니다.")
    return found
