"""화면 파일과 사용자가 연 영상을 내 PC 안(127.0.0.1)에서만 내보내는 작은 HTTP 서버.

영상 탐색을 위해 Range 요청을 지원한다. 영상은 등록된 토큰으로만 접근할 수 있다.
"""
import http.server
import mimetypes
import os
import secrets
import socketserver
import threading
import urllib.parse

# Windows 레지스트리 설정에 따라 .js가 text/plain으로 잡히는 경우가 있어 직접 지정한다
for ext, kind in {".js": "application/javascript", ".css": "text/css", ".html": "text/html",
                  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
                  ".mkv": "video/x-matroska", ".mp3": "audio/mpeg", ".m4a": "audio/mp4", ".wav": "audio/wav",
                  ".flac": "audio/flac", ".ogg": "audio/ogg"}.items():
    mimetypes.add_type(kind, ext)

_media = {}


def register_media(path):
    token = secrets.token_urlsafe(12) + os.path.splitext(path)[1].lower()
    _media[token] = path
    return "/media/" + token


class _Handler(http.server.BaseHTTPRequestHandler):
    ui_dir = ""

    def log_message(self, *args):
        pass

    def do_GET(self):
        path = urllib.parse.unquote(urllib.parse.urlparse(self.path).path)
        if path.startswith("/media/"):
            target = _media.get(path[len("/media/"):])
        else:
            target = os.path.normpath(os.path.join(self.ui_dir, path.lstrip("/") or "index.html"))
            if not target.startswith(self.ui_dir):
                target = None
        if not target or not os.path.isfile(target):
            self.send_error(404)
            return
        self._send_file(target)

    def _send_file(self, path):
        size = os.path.getsize(path)
        start, end = 0, size - 1
        rng = self.headers.get("Range")
        if rng and rng.startswith("bytes="):
            first, _, last = rng[6:].split(",")[0].partition("-")
            if first:
                start, end = int(first), int(last) if last else size - 1
            else:
                start = max(0, size - int(last))
            end = min(end, size - 1)
            if start > end:
                self.send_response(416)
                self.send_header("Content-Range", f"bytes */{size}")
                self.end_headers()
                return
            self.send_response(206)
            self.send_header("Content-Range", f"bytes {start}-{end}/{size}")
        else:
            self.send_response(200)
        self.send_header("Content-Type", mimetypes.guess_type(path)[0] or "application/octet-stream")
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(end - start + 1))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        with open(path, "rb") as f:
            f.seek(start)
            remaining = end - start + 1
            while remaining > 0:
                chunk = f.read(min(1 << 16, remaining))
                if not chunk:
                    break
                try:
                    self.wfile.write(chunk)
                except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError):
                    return
                remaining -= len(chunk)


class _Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # Windows에서는 켜 두면 이미 쓰이는 포트에 겹쳐 붙을 수 있다


def start_server(ui_dir):
    _Handler.ui_dir = os.path.abspath(ui_dir)
    server = _Server(("127.0.0.1", 0), _Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{server.server_address[1]}"
