#!/usr/bin/env python3
import sys
import os
import time
import json
import tempfile
import shutil

def emit(ok, token=None, error=None, **extra):
    payload = {"ok": ok, "token": token, "error": error, **extra}
    if ok and token:
        print(f"__TURNSTILE_TOKEN__:{token}")
    print(json.dumps(payload, ensure_ascii=False))
    return 0 if ok else 1

def read_token(page) -> str:
    try:
        token = page.run_js(
            """
            try {
              const t = turnstile.getResponse();
              if (t && String(t).length > 20) return String(t);
            } catch (e) {}
            const inputs = document.querySelectorAll('[name="cf-turnstile-response"], [name="cf_challenge_response"], #ivl-ts-box input');
            for (const input of inputs) {
              if (input.value && input.value.length > 20) return input.value;
            }
            if (window.tok && String(window.tok).length > 20) return String(window.tok);
            return '';
            """
        )
    except Exception:
        return ""
    return str(token or "")

def click_widget(page) -> None:
    try:
        page.run_js("""
            window.scrollTo(0, 800);
            window.dispatchEvent(new Event('scroll'));
            window.dispatchEvent(new Event('mousemove'));
            const lzl = document.getElementById('ivl-turnstile-gate');
            if (lzl && !window.__ivlTs) {
                try {
                    const sc = document.createElement('script');
                    sc.textContent = lzl.textContent;
                    document.body.appendChild(sc);
                } catch(e) {}
            }
        """)
    except Exception:
        pass

    try:
        host = page.ele(".cf-turnstile", timeout=0.5) or page.ele("@data-sitekey", timeout=0.5)
        if host:
            host.click()
    except Exception:
        pass

    try:
        iframe = page.ele("tag:iframe@src:challenges.cloudflare.com", timeout=0.8)
        if iframe:
            iframe.click()
            challenge_input = page.ele("@name=cf-turnstile-response", timeout=0.5)
            if challenge_input:
                wrapper = challenge_input.parent()
                iframe_ele = wrapper.shadow_root.ele("tag:iframe")
                body = iframe_ele.ele("tag:body").shadow_root
                btn = body.ele("tag:input")
                btn.click()
    except Exception:
        pass

def solve_turnstile(page, timeout_s=35.0) -> str:
    deadline = time.time() + timeout_s
    last_click = 0.0
    while time.time() < deadline:
        token = read_token(page)
        if len(token) > 20:
            return token
        now = time.time()
        if last_click == 0.0 or now - last_click >= 2.0:
            try:
                click_widget(page)
                last_click = now
            except Exception:
                pass
        time.sleep(0.4)
    token = read_token(page)
    return token if len(token) > 20 else ""

def main():
    target_url = sys.argv[1] if len(sys.argv) > 1 else "https://iptvload.org/free-iptv-trial-24-hours/"
    
    try:
        from DrissionPage import Chromium, ChromiumOptions
    except ImportError:
        return emit(False, error="DrissionPage not installed")

    patch_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "turnstilePatch")
    
    chrome = None
    for p in ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]:
        if os.path.exists(p):
            chrome = p
            break
            
    if not chrome:
        return emit(False, error="No chrome/chromium binary found")

    import socket
    sock = socket.socket()
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()

    profile = tempfile.mkdtemp(prefix="turnstile-driss-")
    co = ChromiumOptions()
    co.set_paths(
        browser_path=chrome,
        local_port=port,
        address=f"127.0.0.1:{port}",
        user_data_path=profile
    )
    if os.path.isdir(patch_dir) and os.path.exists(os.path.join(patch_dir, "manifest.json")):
        co.add_extension(patch_dir)

    co.set_argument("--no-sandbox")
    co.set_argument("--disable-dev-shm-usage")
    co.set_argument("--disable-gpu")
    co.set_argument("--no-first-run")
    co.set_argument("--no-default-browser-check")
    co.set_argument("--window-size=1280,800")

    browser = None
    t0 = time.time()
    try:
        browser = Chromium(co)
        page = browser.latest_tab
        try:
            page.get(target_url, timeout=25)
        except Exception:
            pass
            
        time.sleep(2.0)
        token = solve_turnstile(page, timeout_s=35.0)
        
        if len(token) > 20:
            return emit(True, token=token, elapsed_s=round(time.time() - t0, 2))
        return emit(False, error="No token received within timeout", elapsed_s=round(time.time() - t0, 2))
    except Exception as exc:
        return emit(False, error=str(exc))
    finally:
        if browser:
            try:
                browser.quit()
            except Exception:
                pass
        shutil.rmtree(profile, ignore_errors=True)

if __name__ == "__main__":
    raise SystemExit(main())
