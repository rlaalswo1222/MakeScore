# -*- mode: python ; coding: utf-8 -*-
# 빌드: .venv\Scripts\python.exe -m PyInstaller ScoreMake.spec --noconfirm
# 결과: dist\ScoreMake\ScoreMake.exe (폴더째로 옮겨야 함)
import shutil

from PyInstaller.utils.hooks import collect_data_files

ffmpeg = shutil.which("ffmpeg")
if not ffmpeg:
    raise SystemExit("ffmpeg를 찾을 수 없습니다. PATH에 ffmpeg를 두고 다시 빌드하세요.")

a = Analysis(
    ["run.py"],
    binaries=[(ffmpeg, "bin")],
    # demucs: 음원 분리 모델 목록(remote/*.yaml, files.txt)
    datas=[("scoremake/ui", "scoremake/ui")] + collect_data_files("transkun") + collect_data_files("demucs"),
    hiddenimports=["transkun.ModelTransformer", "scoremake.engine", "demucs.htdemucs", "demucs.hdemucs", "demucs.demucs"],
    excludes=["matplotlib", "pandas", "seaborn", "tensorboard", "torch_optimizer", "IPython", "tkinter", "pytest"],
    # Transkun은 실행 중에 TorchScript가 소스코드를 읽으므로 .py 원본도 같이 넣는다.
    # scoremake는 .py 파일 그대로 두어 tools/sync_dist.py로 다시 빌드하지 않고 고칠 수 있게 한다.
    module_collection_mode={"transkun": "pyz+py", "scoremake": "py"},
)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name="ScoreMake", console=False, upx=False)
coll = COLLECT(exe, a.binaries, a.datas, name="ScoreMake", upx=False)
