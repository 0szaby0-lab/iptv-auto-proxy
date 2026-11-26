#!/usr/bin/env python3
import sys
import os
import time
import json
import tempfile
import shutil

def get_token(url="https://iptvload.org/free-iptv-trial-24-hours/", timeout=30):
    try:
        from DrissionPage import Chromium, ChromiumOptions
    except ImportError:
        print(json.dumps({"ok": False, "error": "DrissionPage is not installed"}))
        return

    patch_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), "turnstilePatch")
    
    chrome_path = None
    for p in ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome", "/usr/bin/google-chrome-stable"]:
        if os.path.exists(p):
            chrome_path = p
            break
            
    co = ChromiumOptions()
    if chrome_path:
        co.set_paths(browser_path=chrome_path)
        
    profile_dir = tempfile.mkdtemp(prefix="driss_cf_")
    co.set_paths(user_data_path=profile_dir)
    
    if os.path.isdir(patch_dir) and os.path.exists(os.path.join(patch_dir, "manifest.json")):
        co.add_extension(patch_dir)
        
    co.set_argument("--no-sandbox")
    co.set_argument("--disable-dev-shm-usage")
    co.set_argument("--disable-gpu")
    co.set_argument("--no-first-run")
    co.set_argument("--no-default-browser-check")
    co.set_argument("--window-size=1280,800")
    
    browser = None
    token = None
    try:
        browser = Chromium(co)
        page = browser.latest_tab
        page.get(url, timeout=20)
        
        # Aktiváljuk a lazy load scriptet ha van
        page.run_js("""() => {
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
        }""")
        
        start = time.time()
        while time.time() - start < timeout:
            val = page.run_js("""() => {
                const el = document.querySelector('input[name="cf-turnstile-response"], input[name="cf_challenge_response"], #ivl-ts-box input');
                if (el && el.value && el.value.length > 20) return el.value;
                if (window.tok && window.tok.length > 20) return window.tok;
                return '';
            }""")
            if val and len(str(val).strip()) > 20:
                token = str(val).strip()
                break
                
            try:
                iframe = page.ele('tag:iframe@src:challenges.cloudflare.com', timeout=0.5)
                if iframe:
                    iframe.click()
            except Exception:
                pass
                
            time.sleep(1)
            
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return
    finally:
        if browser:
            try:
                browser.quit()
            except Exception:
                pass
        shutil.rmtree(profile_dir, ignore_errors=True)
        
    if token:
        print(f"__TURNSTILE_TOKEN__:{token}")
        print(json.dumps({"ok": True, "token": token}))
    else:
        print(json.dumps({"ok": False, "error": "Timeout waiting for Turnstile token"}))

if __name__ == "__main__":
    target = sys.argv[1] if len(sys.argv) > 1 else "https://iptvload.org/free-iptv-trial-24-hours/"
    get_token(target)
