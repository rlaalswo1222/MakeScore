"""빠른 업데이트: 다시 빌드하지 않고 바뀐 화면(ui)·파이썬 파일만 dist 폴더에 덮어쓴다.

사용법: .venv\\Scripts\\python.exe tools/sync_dist.py
전체 빌드(PyInstaller)는 라이브러리를 새로 넣거나 빼는 등 꼭 필요할 때만 한다.
"""
import filecmp
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "scoremake")
DST = os.path.join(ROOT, "dist", "ScoreMake", "_internal", "scoremake")

if not os.path.isdir(DST):
    sys.exit("dist 폴더가 없습니다. 먼저 전체 빌드를 하세요: python -m PyInstaller ScoreMake.spec --noconfirm")

# 파이썬 파일은 'py' 방식으로 빌드했을 때만(= dist에 .py가 있을 때만) 덮어쓰는 것이 효과가 있다
py_mode = any(name.endswith(".py") for name in os.listdir(DST))
copied, skipped_py = [], []
for folder, _, files in os.walk(SRC):
    if "__pycache__" in folder:
        continue
    rel = os.path.relpath(folder, SRC)
    for name in files:
        if name.endswith(".pyc"):
            continue
        src = os.path.join(folder, name)
        dst = os.path.join(DST, rel, name)
        if name.endswith(".py") and rel == "." and not py_mode:
            skipped_py.append(name)
            continue
        if os.path.exists(dst) and filecmp.cmp(src, dst, shallow=False):
            continue
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        shutil.copy2(src, dst)
        copied.append(os.path.join(rel, name))

print(f"덮어쓴 파일 {len(copied)}개" + (": " + ", ".join(copied) if copied else ""))
if skipped_py:
    print("참고: 지금 exe는 파이썬 파일을 안에 묶어 둔 예전 방식으로 빌드되어, 파이썬 파일은 덮어쓰지 않았습니다. "
          "파이썬을 고쳤다면 전체 빌드가 한 번 필요하고, 그다음부터는 파이썬 수정도 이 도구로 바로 반영됩니다.")
