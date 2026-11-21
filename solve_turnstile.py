import os
import asyncio
import sys
import json
import time
from playwright.async_api import async_playwright
from turnstile_solver import TurnstileSolver

async def extract_token(page):
    # 1. Főoldali input locator
    try:
        loc = page.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response']").first
        if await loc.count() > 0:
            val = await loc.input_value()
            if val and len(val.strip()) > 10:
                return val.strip()
    except Exception:
        pass

    # 2. Összes frame átvizsgálása
    for frame in page.frames:
        try:
            loc = frame.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response'], input[type='hidden'][value*='0.']").first
            if await loc.count() > 0:
                val = await loc.input_value()
                if val and len(val.strip()) > 10:
                    return val.strip()
        except Exception:
            pass

    # 3. DOM elemzés (beleértve a #ivl-ts-box konténert is)
    try:
        val = await page.evaluate("""() => {
            const el = document.querySelector('input[name="cf-turnstile-response"], input[name="cf_challenge_response"], #ivl-ts-box input');
            if (el && el.value && el.value.length > 10) return el.value;
            if (window.tok && window.tok.length > 10) return window.tok;
            return '';
        }""")
        if val and len(val.strip()) > 10:
            return val.strip()
    except Exception:
        pass

    return None

async def resolve_token(target_url="https://iptvload.org/free-iptv-trial-24-hours/", max_wait=25, headless=True):
    try:
        async with async_playwright() as p:
            print("[Solver] Chromium indítása...")
            browser = await p.chromium.launch(
                channel="chrome",
                headless=headless,
                args=[
                    "--disable-blink-features=AutomationControlled",
                    "--no-sandbox",
                    "--disable-infobars",
                    "--window-size=1280,800"
                ]
            )
            context = await browser.new_context(
                user_agent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                viewport={"width": 1280, "height": 800}
            )
            await context.add_init_script("""
                Object.defineProperty(navigator, 'webdriver', {
                    get: () => undefined
                });
            """)
            page = await context.new_page()
            print(f"[Solver] Navigálás a céloldalra: {target_url}...")
            await page.goto(target_url, wait_until="domcontentloaded", timeout=25000)
            await asyncio.sleep(1.5)

            # Seraph-Accel / LiteSpeed lazy loader és script aktiválása
            print("[Solver] Lazy-loaded Turnstile script aktiválása...")
            try:
                await page.evaluate("""() => {
                    window.scrollTo(0, 800);
                    window.dispatchEvent(new Event('scroll'));
                    window.dispatchEvent(new Event('mousemove'));
                    window.dispatchEvent(new Event('touchstart'));

                    const lzl = document.getElementById('ivl-turnstile-gate');
                    if (lzl && !window.__ivlTs) {
                        try {
                            const sc = document.createElement('script');
                            sc.textContent = lzl.textContent;
                            document.body.appendChild(sc);
                        } catch(e) {}
                    }
                }""")
            except Exception as e:
                print(f"[Solver] Lazy load trigger hiba: {e}")
            await asyncio.sleep(2.0)

            # Megoldó futtatása
            print("[Solver] TurnstileSolver.solve futtatása...")
            await TurnstileSolver.solve(page, max_wait=max_wait)

            # Token keresése több lépésben
            token = None
            for attempt in range(12):
                token = await extract_token(page)
                if token:
                    print(f"[Solver] Token sikeresen megtalálva ({attempt + 1}. próbálkozásnál)!")
                    break
                await asyncio.sleep(0.5)

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
