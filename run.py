"""ScoreMake 실행 파일 (exe로 묶을 때도 이 파일이 시작점)."""
import os
import sys
import warnings

warnings.filterwarnings("ignore")

# 창 프로그램(exe)에는 콘솔이 없으므로, 오류 기록을 로그 파일로 남긴다
if sys.stdout is None or sys.stderr is None:
    log_dir = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScoreMake")
    os.makedirs(log_dir, exist_ok=True)
    log = open(os.path.join(log_dir, "scoremake.log"), "a", encoding="utf-8", buffering=1)
    sys.stdout = sys.stdout or log
    sys.stderr = sys.stderr or log

from scoremake.app import main  # noqa: E402

if __name__ == "__main__":
    main()
