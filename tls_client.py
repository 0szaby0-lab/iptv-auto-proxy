#!/usr/bin/env python3
# /storage/emulated/0/Download/iptv/tls_client.py
# High-speed Cloudflare-bypassing HTTP client for server.js using curl_cffi Chrome 120

import sys
import json
from curl_cffi import requests

def handle_request():
    try:
        raw_input = sys.stdin.read()
        if not raw_input:
            print(json.dumps({"ok": False, "error": "No input provided"}))
            return

        payload = json.loads(raw_input)
        url = payload.get("url")
        method = payload.get("method", "GET").upper()
        headers = payload.get("headers", {})
        data = payload.get("data")
        json_data = payload.get("json")
        timeout = payload.get("timeout", 25)

        session = requests.Session(impersonate="chrome120")
        
        # Sütik beállítása ha érkezett
        cookie_header = headers.get("Cookie") or headers.get("cookie")
        if cookie_header:
            for item in cookie_header.split(";"):
                if "=" in item:
                    k, v = item.strip().split("=", 1)
                    session.cookies.set(k, v)

        res = session.request(
            method=method,
            url=url,
            headers=headers,
            data=data,
            json=json_data,
            timeout=timeout
        )

        # Válasz összeállítása
        cookies_list = [f"{k}={v}" for k, v in res.cookies.items()]

        output = {
            "ok": True,
            "status": res.status_code,
            "headers": dict(res.headers),
            "cookies": cookies_list,
            "body": res.text
        }
        print(json.dumps(output))

    except Exception as e:
        print(json.dumps({
            "ok": False,
            "error": str(e),
            "status": 500,
            "body": ""
        }))

if __name__ == "__main__":
    handle_request()
