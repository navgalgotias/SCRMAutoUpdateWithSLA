"""
Local development server for vTiger CRM Auto Update.

vTiger only allows browser calls from the hosted app's origin (GitHub Pages),
so a copy opened from http://localhost is blocked by CORS. This server:

  * serves this folder as static files, and
  * forwards /vtiger-proxy/<path> to the vTiger CRM, so the browser only
    ever talks to localhost.

When the app runs on localhost it sends vTiger calls to /vtiger-proxy/
automatically (see webserviceUrl() in js/app.js). Listens on 127.0.0.1 only.

Usage:
    python dev-server.py [--port 8080] [--crm https://scrm.altametrics.com/]
"""
import argparse
import http.server
import os
import urllib.error
import urllib.request

PROXY_PREFIX = "/vtiger-proxy/"


def make_handler(crm_base):
    class Handler(http.server.SimpleHTTPRequestHandler):
        def _proxy(self):
            target = crm_base + self.path[len(PROXY_PREFIX):]
            length = int(self.headers.get("Content-Length") or 0)
            body = self.rfile.read(length) if length else None
            headers = {"User-Agent": "crm-auto-update-dev-proxy"}
            if self.headers.get("Content-Type"):
                headers["Content-Type"] = self.headers["Content-Type"]
            request = urllib.request.Request(target, data=body, headers=headers, method=self.command)
            try:
                with urllib.request.urlopen(request, timeout=120) as resp:
                    status, content_type, data = resp.status, resp.headers.get("Content-Type"), resp.read()
            except urllib.error.HTTPError as err:
                status, content_type, data = err.code, err.headers.get("Content-Type"), err.read()
            except Exception as err:  # network failure reaching vTiger
                status, content_type = 502, "application/json"
                data = ('{"success":false,"error":{"message":"Dev proxy could not reach vTiger: %s"}}'
                        % str(err).replace('"', "'")).encode()
            self.send_response(status)
            self.send_header("Content-Type", content_type or "application/octet-stream")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            if self.path.startswith(PROXY_PREFIX):
                return self._proxy()
            return super().do_GET()

        def do_POST(self):
            if self.path.startswith(PROXY_PREFIX):
                return self._proxy()
            self.send_error(405)

        def end_headers(self):
            # Always serve fresh files while developing.
            if not self.path.startswith(PROXY_PREFIX):
                self.send_header("Cache-Control", "no-store")
            super().end_headers()

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--port", type=int, default=8080)
    parser.add_argument("--crm", default="https://scrm.altametrics.com/", help="vTiger CRM base URL")
    args = parser.parse_args()

    crm_base = args.crm.rstrip("/") + "/"
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(crm_base))
    print("Serving http://localhost:%d  (vTiger calls -> %s)" % (args.port, crm_base), flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
