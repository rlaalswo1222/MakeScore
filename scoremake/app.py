"""ScoreMake 프로그램 창과 화면(JS)이 부르는 기능들."""
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
import traceback

import webview

from . import youtube
from .ffmpeg import NO_WINDOW, find_ffmpeg
from .server import register_media, start_server

BASE = getattr(sys, "_MEIPASS", os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
UI_DIR = os.path.join(BASE, "scoremake", "ui")
DATA_DIR = os.path.join(os.environ.get("LOCALAPPDATA", os.path.expanduser("~")), "ScoreMake")
PROJECT_DIR = os.path.join(DATA_DIR, "projects")
PROXY_DIR = os.path.join(DATA_DIR, "proxy")
PREFS_FILE = os.path.join(DATA_DIR, "prefs.json")
VIDEO_EXT = {".mp4", ".mov", ".m4v", ".mkv", ".webm", ".avi", ".wmv"}
MEDIA_TYPES = ("영상 또는 소리 파일 (*.mp4;*.mov;*.m4v;*.mkv;*.webm;*.avi;*.wmv;*.mp3;*.wav;*.m4a;*.flac;*.ogg)",
               "모든 파일 (*.*)")


def _dialog(name):
    kind = getattr(webview, "FileDialog", None)
    return getattr(kind, name) if kind else getattr(webview, name + "_DIALOG")


def _project_key(path):
    st = os.stat(path)
    return hashlib.sha1(f"{os.path.abspath(path).lower()}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()[:20]


def _project_file(path):
    return os.path.join(PROJECT_DIR, _project_key(path) + ".json")


def _read_json(path):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return None


def _write_json(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False)
    os.replace(tmp, path)


class Api:
    def __init__(self):
        self._window = None
        self._engine = None
        self._busy = False
        self._download = None
        self._preview = None

    # ---------- 파일 ----------
    def choose_file(self):
        result = self._window.create_file_dialog(_dialog("OPEN"), file_types=MEDIA_TYPES)
        return result[0] if result else None

    def open(self, path):
        """파일을 열어 재생 주소와, 전에 작업한 내용이 있으면 그것도 돌려준다."""
        if not path or not os.path.isfile(path):
            return {"error": "파일을 찾을 수 없습니다."}
        saved = _read_json(_project_file(path)) or {}
        return {"path": path, "name": os.path.basename(path), "media": register_media(path),
                "isVideo": os.path.splitext(path)[1].lower() in VIDEO_EXT,
                "result": saved.get("result"), "edits": saved.get("edits")}

    def recent(self):
        items = []
        if os.path.isdir(PROJECT_DIR):
            for name in os.listdir(PROJECT_DIR):
                if not name.endswith(".json"):
                    continue
                full = os.path.join(PROJECT_DIR, name)
                data = _read_json(full) or {}
                path = data.get("path")
                if path and os.path.isfile(path):
                    items.append({"path": path, "name": os.path.basename(path), "when": os.path.getmtime(full)})
        items.sort(key=lambda x: -x["when"])
        return items  # 저장된 작업 전부 (최근 것부터)

    def save_edits(self, path, edits):
        file = _project_file(path)
        data = _read_json(file) or {}
        data["edits"] = edits
        _write_json(file, data)
        return True

    # ---------- 사용자 설정 (볼륨 등, 파일과 상관없이 유지) ----------
    def get_pref(self, key):
        return (_read_json(PREFS_FILE) or {}).get(key)

    def set_pref(self, key, value):
        prefs = _read_json(PREFS_FILE) or {}
        prefs[key] = value
        _write_json(PREFS_FILE, prefs)
        return True

    def forget_edits(self, path):
        file = _project_file(path)
        data = _read_json(file) or {}
        data.pop("edits", None)
        _write_json(file, data)
        return True

    # ---------- 음 인식 ----------
    def transcribe(self, path, separate=False):
        """separate: 인식 전에 음원 분리로 노래·드럼·베이스를 걸러 낸다 (사용자가 고를 때만)"""
        if self._busy:
            return False
        self._busy = True
        threading.Thread(target=self._transcribe, args=(path, bool(separate)), daemon=True).start()
        return True

    def _transcribe(self, path, separate=False):
        try:
            self._emit("progress", {"stage": "model", "f": 0})
            if self._engine is None:
                from .engine import Engine  # torch는 무거워서 처음 인식할 때 불러온다
                self._engine = Engine()

            def reporter(stage):
                last = [-1.0]

                def progress(f):
                    if f - last[0] >= 0.01 or f >= 1:
                        last[0] = f
                        self._emit("progress", {"stage": stage, "f": f})
                return progress

            if separate:
                self._emit("progress", {"stage": "separate", "f": 0})
            started = time.time()
            notes_progress = reporter("notes")
            result = self._engine.transcribe(path, progress=notes_progress, separate=separate,
                                             sep_progress=reporter("separate"))
            result["seconds"] = round(time.time() - started, 1)
            _write_json(_project_file(path), {"path": path, "result": result})
            self._emit("done", result)
        except Exception as e:  # 화면에 이유를 보여 준다
            traceback.print_exc()
            self._emit("error", str(e))
        finally:
            self._busy = False

    def _emit(self, kind, data):
        payload = json.dumps(data, ensure_ascii=False)
        self._window.evaluate_js(f"window.onEngine && window.onEngine({json.dumps(kind)}, {payload})")

    # ---------- 유튜브 ----------
    def yt_info(self, url):
        try:
            return youtube.info(url.strip())
        except Exception as e:
            traceback.print_exc()
            return {"error": str(e)}

    def yt_download(self, url, vid, start, end, title):
        if self._download:
            return False
        self._download = youtube.Download()
        threading.Thread(target=self._yt_download, args=(self._download, url, vid, float(start), float(end), title),
                         daemon=True).start()
        return True

    def _yt_download(self, job, url, vid, start, end, title):
        try:
            self._emit("yt_progress", {"f": 0})
            last = [0.0]

            def progress(f):
                if f - last[0] >= 0.01 or f >= 1:
                    last[0] = f
                    self._emit("yt_progress", {"f": f})

            self._emit("yt_done", {"path": job.run(url, vid, start, end, title, progress)})
        except Exception as e:
            traceback.print_exc()
            self._emit("yt_error", str(e))
        finally:
            self._download = None

    def yt_cancel(self):
        if self._download:
            self._download.cancel()
        return True

    def yt_preview(self, url, vid):
        if self._preview:
            self._preview.cancel()
        job = self._preview = youtube.Download()
        threading.Thread(target=self._yt_preview, args=(job, url, vid), daemon=True).start()
        return True

    def _yt_preview(self, job, url, vid):
        try:
            last = [0.0]

            def progress(f):
                if f - last[0] >= 0.02 or f >= 1:
                    last[0] = f
                    self._emit("yt_pv_progress", {"vid": vid, "f": f})

            path = job.preview(url, vid, progress)
            self._emit("yt_pv_done", {"vid": vid, "media": register_media(path)})
        except Exception as e:
            if not job.cancelled:
                traceback.print_exc()
                self._emit("yt_pv_error", {"vid": vid, "error": str(e)})
        finally:
            if self._preview is job:
                self._preview = None

    def yt_preview_cancel(self):
        if self._preview:
            self._preview.cancel()
        return True

    # ---------- 재생 ----------
    def make_proxy(self, path):
        """브라우저가 바로 못 트는 영상(HEVC 등)을 H.264 미리보기용으로 바꾼다."""
        out = os.path.join(PROXY_DIR, _project_key(path) + ".mp4")
        if not os.path.exists(out):
            os.makedirs(PROXY_DIR, exist_ok=True)
            cmd = [find_ffmpeg(), "-v", "error", "-y", "-i", path, "-vf", "scale=-2:'min(720,ih)'",
                   "-c:v", "libx264", "-preset", "veryfast", "-crf", "26", "-c:a", "aac", "-b:a", "160k",
                   "-movflags", "+faststart", out + ".part.mp4"]
            proc = subprocess.run(cmd, capture_output=True, creationflags=NO_WINDOW)
            if proc.returncode != 0:
                return {"error": proc.stderr.decode(errors="ignore")[-400:]}
            os.replace(out + ".part.mp4", out)
        return {"media": register_media(out)}

    # ---------- 저장 ----------
    def _ask_save(self, filename, types):
        result = self._window.create_file_dialog(_dialog("SAVE"), save_filename=filename, file_types=types)
        if not result:
            return None
        return result if isinstance(result, str) else result[0]

    def save_musicxml(self, xml, filename):
        path = self._ask_save(filename, ("MusicXML (*.musicxml)",))
        if not path:
            return None
        with open(path, "w", encoding="utf-8") as f:
            f.write(xml)
        return path

    def save_pdf(self, pages, title, filename):
        path = self._ask_save(filename, ("PDF (*.pdf)",))
        if not path:
            return None
        write_pdf(path, pages, title)
        return path

    def reveal(self, path):
        if os.name == "nt" and path and os.path.exists(path):
            subprocess.Popen(["explorer", "/select,", os.path.normpath(path)])

    def log(self, msg):
        print("[화면]", msg, flush=True)


def write_pdf(path, pages, title):
    """화면이 그린 악보 SVG 페이지들을 A4 PDF로 만든다."""
    from reportlab.graphics import renderPDF
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfgen import canvas
    from svglib.svglib import svg2rlg

    font = _korean_font()
    _register_svg_fonts()
    w, h = A4
    margin = 40
    pdf = canvas.Canvas(path, pagesize=A4)
    pdf.setTitle(title)
    with tempfile.TemporaryDirectory() as tmp:
        for i, svg in enumerate(pages):
            file = os.path.join(tmp, f"p{i}.svg")
            with open(file, "w", encoding="utf-8") as f:
                f.write(svg)
            drawing = svg2rlg(file)
            scale = (w - 2 * margin) / drawing.width
            drawing.scale(scale, scale)
            drawing.width *= scale
            drawing.height *= scale
            top = h - margin
            if i == 0:
                pdf.setFont(font, 18)
                pdf.drawCentredString(w / 2, top - 18, title)
                top -= 44
            renderPDF.draw(drawing, pdf, margin, top - drawing.height)
            pdf.setFont(font, 8)
            pdf.drawCentredString(w / 2, 22, f"{i + 1} / {len(pages)}")
            pdf.showPage()
    pdf.save()


def _register_svg_fonts():
    """악보 SVG의 코드 이름 글꼴(♭·♯가 모두 있는 Segoe UI Symbol)을 PDF 변환기에 알려 준다. 없으면 기본 글꼴로 나온다."""
    try:
        from svglib.fonts import register_font
        file = os.path.join(os.environ.get("WINDIR", r"C:\Windows"), "Fonts", "seguisym.ttf")
        if os.path.exists(file):
            register_font("Segoe UI Symbol", file)
    except Exception:
        traceback.print_exc()


def _korean_font():
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    windir = os.environ.get("WINDIR", r"C:\Windows")
    for name in ("malgun.ttf", "gulim.ttc"):
        file = os.path.join(windir, "Fonts", name)
        if os.path.exists(file):
            try:
                pdfmetrics.registerFont(TTFont("KR", file))
                return "KR"
            except Exception:
                continue
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    pdfmetrics.registerFont(UnicodeCIDFont("HYSMyeongJo-Medium"))
    return "HYSMyeongJo-Medium"


def main():
    api = Api()
    url = start_server(UI_DIR)
    window = webview.create_window("ScoreMake", url + "/index.html", js_api=api,
                                   width=1440, height=920, min_size=(1000, 680), background_color="#E8EBEF")
    api._window = window

    def on_drop(event):
        files = (event.get("dataTransfer") or {}).get("files") or []
        if files and files[0].get("pywebviewFullPath"):
            path = files[0]["pywebviewFullPath"]
            window.evaluate_js(f"window.openPath && window.openPath({json.dumps(path)})")

    def on_start():
        try:
            from webview.dom import DOMEventHandler
            window.dom.document.events.dragover += DOMEventHandler(lambda e: None, True, True)
            window.dom.document.events.drop += DOMEventHandler(on_drop, True, True)
        except Exception:
            traceback.print_exc()
        if os.environ.get("SCOREMAKE_AUTOTEST") or os.environ.get("SCOREMAKE_AUTOTEST_YT"):
            _autotest(window, os.environ.get("SCOREMAKE_AUTOTEST", ""), os.environ.get("SCOREMAKE_AUTOTEST_OUT", DATA_DIR))

    webview.start(on_start, debug=bool(os.environ.get("SCOREMAKE_DEBUG")))


def _autotest(window, media, out):
    """개발용: 파일 열기 → 인식 → 편집 화면 → PDF/MusicXML까지 자동으로 돌려 보고 창을 닫는다."""
    def wait(expr, timeout):
        end = time.time() + timeout
        while time.time() < end:
            if window.evaluate_js(expr):
                return True
            time.sleep(0.5)
        return False

    try:
        if not wait("typeof window.openPath === 'function' && !!window.__dev", 30):
            print("[시험] 화면 준비 실패", flush=True)
            return
        started = time.time()
        yt = os.environ.get("SCOREMAKE_AUTOTEST_YT")  # "링크|시작초|끝초"
        if yt:
            url, start, end = yt.split("|")
            window.evaluate_js(f"document.querySelector('#ytUrl').value={json.dumps(url)};"
                               "document.querySelector('#ytForm').requestSubmit()")
            if not wait("!document.querySelector('#yt').hidden", 120):
                print("[시험] 유튜브 정보 실패:", window.evaluate_js("document.querySelector('#ytErr').textContent"), flush=True)
                return
            print(f"[시험] 유튜브 정보 {time.time() - started:.1f}초:", window.evaluate_js("document.querySelector('#ytTitle').textContent"), flush=True)
            if os.environ.get("SCOREMAKE_AUTOTEST_FALLBACK"):
                window.evaluate_js("window.__dev.ytFallback()")
                loaded = wait("window.__dev.ytVideo() > 0", 180)
                print(f"[시험] 대체 미리보기 {time.time() - started:.1f}초:", f"저화질 영상 {window.evaluate_js('window.__dev.ytVideo()')}초 재생 준비"
                      if loaded else "실패 / " + str(window.evaluate_js("document.querySelector('#ytNoPlay').textContent")), flush=True)
            else:
                loaded = wait("window.__dev.ytPlayer() > 0", 20)
                print("[시험] 미리보기 플레이어:", f"영상 길이 {window.evaluate_js('window.__dev.ytPlayer()')}초 읽음" if loaded
                      else "불러오지 못함 / " + str(window.evaluate_js("document.querySelector('#ytNoPlay').textContent")), flush=True)
            window.evaluate_js(f"window.__dev.ytRange({float(start)},{float(end)}); document.querySelector('#ytDownload').click()")
            if not wait("!document.querySelector('#working').hidden || !document.querySelector('#editor').hidden", 300):
                print("[시험] 다운로드 실패:", window.evaluate_js("document.querySelector('#ytErr2').textContent"), flush=True)
                return
            print(f"[시험] 다운로드 끝 {time.time() - started:.1f}초", flush=True)
        else:
            window.evaluate_js(f"window.openPath({json.dumps(media)})")
        if not wait("!document.querySelector('#editor').hidden", 900):
            print("[시험] 편집 화면이 뜨지 않음:", window.evaluate_js("document.querySelector('#workErr').textContent"), flush=True)
            return
        print(f"[시험] 편집 화면까지 {time.time() - started:.1f}초", flush=True)
        time.sleep(2)
        print("[시험] 상태:", window.evaluate_js("JSON.stringify(window.__dev.state())"), flush=True)
        for expr in filter(None, os.environ.get("SCOREMAKE_AUTOTEST_EVAL", "").split(";;")):
            if expr.startswith("sleep:"):  # 재생처럼 시간이 지나야 하는 시험: "sleep:초"
                time.sleep(float(expr[6:]))
                continue
            print(f"[시험] {expr} →", window.evaluate_js(expr), flush=True)
        os.makedirs(out, exist_ok=True)
        pages = json.loads(window.evaluate_js("JSON.stringify(window.__dev.printPages())"))
        write_pdf(os.path.join(out, "autotest.pdf"), pages, "자동 시험")
        with open(os.path.join(out, "autotest.musicxml"), "w", encoding="utf-8") as f:
            f.write(window.evaluate_js("window.__dev.musicXml()"))
        print(f"[시험] PDF {len(pages)}쪽, MusicXML 저장 완료 → {out}", flush=True)
    except Exception:
        traceback.print_exc()
    finally:
        window.destroy()


if __name__ == "__main__":
    main()
