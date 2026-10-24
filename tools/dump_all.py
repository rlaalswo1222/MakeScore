"""저장된 모든 곡(프로젝트)을 자동 시험으로 열어 window.__dev 식의 결과를 곡마다 파일로 저장한다.
사용: python tools/dump_all.py <출력폴더> <JS식> [곡 이름 일부...]"""
import glob, json, os, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
out_dir, expr, picks = sys.argv[1], sys.argv[2], sys.argv[3:]
os.makedirs(out_dir, exist_ok=True)
for f in sorted(glob.glob(os.path.expandvars(r"%LOCALAPPDATA%\ScoreMake\projects\*.json"))):
    d = json.load(open(f, encoding="utf-8"))
    path = d.get("path", "")
    if not os.path.exists(path) or (picks and not any(p in path for p in picks)):
        continue
    key = os.path.basename(f)[:-5]
    log = os.path.join(out_dir, key + ".log")
    env = dict(os.environ, SCOREMAKE_AUTOTEST=path, SCOREMAKE_AUTOTEST_OUT=os.path.join(out_dir, "pdf"),
               SCOREMAKE_AUTOTEST_EVAL=expr, PYTHONIOENCODING="utf-8")
    with open(log, "w", encoding="utf-8") as fo:
        p = subprocess.Popen([os.path.join(ROOT, ".venv", "Scripts", "python.exe"), "run.py"], cwd=ROOT, env=env,
                             stdout=fo, stderr=subprocess.STDOUT)
        try:
            p.wait(90)
        except subprocess.TimeoutExpired:
            p.kill()
    text = open(log, encoding="utf-8", errors="replace").read()
    res = None
    for line in text.splitlines():
        if line.startswith("[시험] ") and " → " in line and expr.split(";;")[0][:20] in line:
            res = line.split(" → ", 1)[1]
    with open(os.path.join(out_dir, key + ".json"), "w", encoding="utf-8") as fo:
        json.dump({"name": os.path.basename(path), "result": res}, fo, ensure_ascii=False)
    print(key, "ok" if res else "FAIL", flush=True)
