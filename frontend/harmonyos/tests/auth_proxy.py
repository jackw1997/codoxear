"""Docker-only fault proxy for native authentication/reconnect UI verification.

Forward to the isolated fixture server. Touch /tmp/reject-auth inside this
container to expire API requests; remove it before signing in again. SSE is
disabled so fallback polling deterministically observes the injected response.
"""
import http.client
import http.server
import os
import socket
import time
from pathlib import Path

assert Path('/.dockerenv').exists(), 'Fault proxy is container-only'


class Proxy(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def respond(self, status, body, headers=()):
        self.send_response(status)
        for name, value in headers:
            if name.lower() not in ('transfer-encoding', 'content-length', 'connection'):
                self.send_header(name, value)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def forward(self):
        body = self.rfile.read(int(self.headers.get('Content-Length', '0')))
        if Path('/tmp/network-unavailable').exists():
            self.respond(503, b'{"error":"temporary fixture outage"}')
            return
        if self.path == '/api/login' and Path('/tmp/reject-password').exists():
            self.respond(403, b'{"error":"bad password"}')
            return
        if Path('/tmp/reject-auth').exists() and self.path.startswith('/api/'):
            self.respond(401, b'{"error":"authentication expired"}')
            return
        if '/live?' in self.path and '/messages/live?' not in self.path:
            self.respond(503, b'{"error":"SSE disabled by test proxy"}')
            return
        if self.path.endswith('/inject_file') and Path('/tmp/delay-upload').exists():
            time.sleep(8)
        if self.path.endswith('/inject_file') and Path('/tmp/reject-upload').exists():
            self.respond(503, b'{"error":"Fixture upload rejected before staging"}')
            return
        port_file = Path('/tmp/fixture-port')
        fixture_port = int(port_file.read_text()) if port_file.exists() else 19743
        connection = http.client.HTTPConnection(os.environ['FIXTURE_HOST'], fixture_port, timeout=15)
        try:
            headers = {key: value for key, value in self.headers.items() if key.lower() not in ('host', 'connection')}
            connection.request(self.command, self.path, body=body, headers=headers)
            response = connection.getresponse()
            payload = response.read()
            drop_send = self.path.endswith('/send') and Path('/tmp/drop-send-response').exists()
            drop_upload = self.path.endswith('/inject_file') and Path('/tmp/drop-upload-response').exists()
            if self.command == 'POST' and (drop_send or drop_upload):
                self.connection.shutdown(socket.SHUT_RDWR)
                self.connection.close()
                return
            self.respond(response.status, payload, response.getheaders())
        finally:
            connection.close()

    do_GET = forward
    do_POST = forward


http.server.ThreadingHTTPServer(('0.0.0.0', 19744), Proxy).serve_forever()
