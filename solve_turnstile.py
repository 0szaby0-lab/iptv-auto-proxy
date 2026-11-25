import os
import asyncio
import sys
import json
import time
from playwright.async_api import async_playwright
from turnstile_solver import TurnstileSolver

async def extract_token(page):
    # 1. Global JS változók ellenőrzése (interceptált callback vagy window.tok)
    try:
        val = await page.evaluate("""() => {
            if (window.__turnstile_token && window.__turnstile_token.length > 10) return window.__turnstile_token;
            if (window.tok && window.tok.length > 10) return window.tok;
            const el = document.querySelector('input[name="cf-turnstile-response"], input[name="cf_challenge_response"], #ivl-ts-box input');
            if (el && el.value && el.value.length > 10) return el.value;
            return '';
        }""")
        if val and len(val.strip()) > 10:
            return val.strip()
    except Exception:
        pass

    # 2. Főoldali input locator
    try:
        loc = page.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response']").first
        if await loc.count() > 0:
            val = await loc.input_value()
            if val and len(val.strip()) > 10:
                return val.strip()
    except Exception:
        pass

    # 3. Összes frame átvizsgálása
    for frame in page.frames:
        try:
            loc = frame.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response'], input[type='hidden'][value*='0.']").first
            if await loc.count() > 0:
                val = await loc.input_value()
                if val and len(val.strip()) > 10:
                    return val.strip()
        except Exception:
            pass

    return None

async def resolve_token(target_url="https://iptvload.org/free-iptv-trial-24-hours/", max_wait=35, headless=True):
    try:
        async with async_playwright() as p:
            print(f"[Solver] Chromium indítása ({target_url})...")
            browser = await p.chromium.launch(
                headless=headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-dev-shm-usage",
                    "--disable-infobars",
                    "--disable-gpu",
                    "--window-size=1280,800"
                ]
            )
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            
            # Anti-detection + Turnstile callback interceptor (kulcsfontosságú a SmailPro 'response-field': false módjához)
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
                window.__turnstile_token = '';

                let _realTurnstile = undefined;
                Object.defineProperty(window, 'turnstile', {
                    configurable: true,
                    enumerable: true,
                    get: function() { return _realTurnstile; },
                    set: function(val) {
                        _realTurnstile = val;
                        if (val && typeof val.render === 'function' && !val.__patched) {
                            val.__patched = true;
                            const origRender = val.render;
                            val.render = function(container, params) {
                                if (params && typeof params.callback === 'function') {
                                    const origCb = params.callback;
                                    params.callback = function(token) {
                                        window.__turnstile_token = token;
                                        return origCb.apply(this, arguments);
                                    };
                                }
                                return origRender.apply(this, arguments);
                            };
                        }
                    }
                });
            """)
            
            page = await context.new_page()
            print(f"[Solver] Navigálás a céloldalra: {target_url}...")
            await page.goto(target_url, wait_until="domcontentloaded", timeout=30000)
            await asyncio.sleep(2.0)

            # Oldal-specifikus triggerek (IPTVLoad lazy-load, SmailPro auto_create widget render)
            try:
                await page.evaluate("""() => {
                    // IPTVload gate script
                    const lzl = document.getElementById('ivl-turnstile-gate');
                    if (lzl && !window.__ivlTs) {
                        try {
                            const sc = document.createElement('script');
                            sc.textContent = lzl.textContent;
                            document.body.appendChild(sc);
                        } catch(e) {}
                    }
                    
                    // SmailPro trigger
                    if (window.Alpine) {
                        const root = document.querySelector('[x-data]');
                        if (root && root.__x) {
                            try { root.__x.$data.captcha('auto_create'); } catch(e) {}
                        }
                    }
                }""")
            except Exception as e:
                print(f"[Solver] Page init trigger hiba: {e}")

            await asyncio.sleep(2.0)

            # Megoldó futtatása
            print("[Solver] TurnstileSolver.solve futtatása...")
            await TurnstileSolver.solve(page, max_wait=max_wait)

            # Token keresése több lépésben
            token = None
            for attempt in range(15):
                token = await extract_token(page)
                if token:
                    print(f"[Solver] Token sikeresen megtalálva ({attempt + 1}. próbálkozásnál)!")
                    break
                await asyncio.sleep(1.0)

            await context.close()
            await browser.close()

            if token and len(token) > 10:
                return {"ok": True, "token": token}
            else:
                return {"ok": False, "error": "Token not found after solve"}
    except Exception as e:
        return {"ok": False, "error": str(e)}

if __name__ == "__main__":
    url = sys.argv[1] if len(sys.argv) > 1 else "https://iptvload.org/free-iptv-trial-24-hours/"
    result = asyncio.run(resolve_token(url))
    print(f"\n__TURNSTILE_JSON__:{json.dumps(result)}")
