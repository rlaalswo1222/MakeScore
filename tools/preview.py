"""개발용: 화면만 브라우저로 띄워 본다 (파이썬 창 없이).

사용법: python tools/preview.py 결과.json 소리.wav [포트]
출력된 주소를 브라우저로 열면, 저장해 둔 인식 결과로 편집 화면이 뜬다.
"""
import os
import sys
import time
import urllib.parse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from scoremake.server import _Handler, _Server, register_media  # noqa: E402

result, audio = sys.argv[1], sys.argv[2]
port = int(sys.argv[3]) if len(sys.argv) > 3 else 0
_Handler.ui_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "scoremake", "ui"))
_Server.allow_reuse_address = False  # Windows에서는 이 옵션 때문에 이미 쓰는 포트에 겹쳐 붙을 수 있다
server = _Server(("127.0.0.1", port), _Handler)
port = server.server_address[1]
query = urllib.parse.urlencode({"demo": register_media(result), "media": register_media(audio), "name": os.path.basename(audio)})
print(f"http://127.0.0.1:{port}/index.html?{query}", flush=True)
try:
    server.serve_forever()
except KeyboardInterrupt:
    time.sleep(0)
