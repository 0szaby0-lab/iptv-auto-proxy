import asyncio
import time
import random
from typing import Optional
from playwright.async_api import Page as AsyncPage

class TurnstileSolver:
    """
    Playwright icin Cloudflare Turnstile & 5s Managed Challenge Cozucusu.
    Hicbir harici ucretli API gerektirmez; insansi fare hareketleri, iframe ve shadow DOM hedefleme ile calisir.
    """

    @staticmethod
    async def solve(page: AsyncPage, max_wait: int = 35) -> bool:
        """
        Sayfadaki Cloudflare Turnstile veya 5s Challenge kontrolunu tespit edip cozer.
        
        Args:
            page (AsyncPage): Playwright async sayfa nesnesi.
            max_wait (int): Maksimum bekleme suresi (saniye).
            
        Returns:
            bool: Cozum basarili ise True, aksi halde False.
        """
        print("\n[Turnstile Solver] Cloudflare Turnstile / Challenge tespiti yapiliyor...")

        start_time = asyncio.get_event_loop().time()

        # Eger menulu test sayfasindaysa (peet.ws gibi) 'Managed challenge' linkine tikla
        try:
            menu_link = page.locator("a:has-text('Managed challenge'), a[href*='managed']").first
            if await menu_link.count() > 0:
                print("[Turnstile Solver] Test sayfasindaki 'Managed challenge' secenegine tiklaniyor...")
                await menu_link.click()
                await asyncio.sleep(2.0)
        except Exception:
            pass

        # 1. Onceden cozulmus mu kontrol et
        if await TurnstileSolver._is_already_solved(page):
            print("[Turnstile Solver] [OK] Turnstile zaten onaylanmis!")
            return True

        # 2. Cozum Dongusu
        attempts = 0
        while asyncio.get_event_loop().time() - start_time < max_wait:
            attempts += 1

            # Token olustu mu?
            if await TurnstileSolver._is_already_solved(page):
                print("[Turnstile Solver] [BASARILI] Cloudflare Turnstile tokeni olustu ve onaylandi!")
                await asyncio.sleep(1.0)
                return True

            # A. Tum Frame'leri Tara (Nested ve Cloudflare Frame'leri)
            clicked_any = False
            for frame in page.frames:
                if "challenges.cloudflare.com" in frame.url or "cloudflare" in frame.url:
                    try:
                        # Frame icerisindeki checkbox ve stage elementleri
                        candidates = [
                            frame.locator("input[type='checkbox']").first,
                            frame.locator("[role='checkbox']").first,
                            frame.locator(".ctp-checkbox-label").first,
                            frame.locator("#challenge-stage").first,
                            frame.locator(".cb-i").first,
                            frame.locator(".mark").first,
                        ]
                        for cand in candidates:
                            if await cand.count() > 0 and await cand.is_visible():
                                print(f"[Turnstile Solver] Cloudflare ic frame checkbox tespit edildi, tiklaniyor...")
                                await asyncio.sleep(random.uniform(0.3, 0.7))
                                await cand.click(force=True, timeout=3000)
                                clicked_any = True
                                await asyncio.sleep(1.5)
                                break
                    except Exception:
                        pass

            # B. Ana Sayfadaki Turnstile Iframe ve Bounding Box Tiklama
            iframe_loc = page.locator("#ivl-ts-box iframe, iframe[src*='challenges.cloudflare.com'], iframe[title*='Cloudflare']").first
            if await iframe_loc.count() > 0:
                try:
                    box = await iframe_loc.bounding_box()
                    if box and box['width'] > 0 and box['height'] > 0:
                        # Checkbox genellikle soldan 28-35px, dikeyde orta noktadadir
                        click_x = box['x'] + random.uniform(28, 38)
                        click_y = box['y'] + (box['height'] / 2) + random.uniform(-3, 3)

                        print(f"[Turnstile Solver] Iframe koordinatina dogrudan tiklaniyor (X: {int(click_x)}, Y: {int(click_y)})...")
                        
                        # İnsansı kavisli fare yaklasimi
                        await page.mouse.move(click_x - random.uniform(40, 80), click_y - random.uniform(30, 60))
                        await asyncio.sleep(random.uniform(0.15, 0.3))
                        await page.mouse.move(click_x, click_y)
                        await asyncio.sleep(random.uniform(0.1, 0.2))
                        await page.mouse.click(click_x, click_y)
                        
                        # Alternatif olarak iframe locator'a direkt position ile de gonderelim
                        try:
                            await iframe_loc.click(position={"x": int(box['width'] * 0.15), "y": int(box['height'] * 0.5)}, timeout=2000, force=True)
                        except Exception:
                            pass

                        await asyncio.sleep(2.0)
                        clicked_any = True
                except Exception as e:
                    pass

            # C. Cloudflare 5s / Managed Challenge Sayfasi Kontrolu (#challenge-stage)
            try:
                cf_stage = page.locator("#challenge-stage input[type='button'], #challenge-stage .ctp-checkbox-label, #challenge-stage").first
                if await cf_stage.count() > 0:
                    print("[Turnstile Solver] Cloudflare 5s Challenge sahnesi onaylaniyor...")
                    await asyncio.sleep(random.uniform(0.4, 0.8))
                    await cf_stage.click(timeout=3000, force=True)
                    await asyncio.sleep(2.0)
                    clicked_any = True
            except Exception:
                pass

            # D. Standart wrapper (.cf-turnstile)
            try:
                wrapper_cb = page.locator(".cf-turnstile input[type='checkbox'], .cf-turnstile, [data-sitekey]").first
                if await wrapper_cb.count() > 0 and not clicked_any:
                    print("[Turnstile Solver] .cf-turnstile wrapper alanina tiklaniyor...")
                    await wrapper_cb.click(timeout=2000, force=True)
                    await asyncio.sleep(1.5)
            except Exception:
                pass

            await asyncio.sleep(1.2)

        # Son kontrol
        return await TurnstileSolver._is_already_solved(page)

    @staticmethod
    async def _is_already_solved(page: AsyncPage) -> bool:
        """Turnstile tokeninin olusup olusmadigini veya basarili gecildigini kontrol eder."""
        try:
            # 1. Token input kontrolu (cf-turnstile-response)
            resp_input = page.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response']").first
            if await resp_input.count() > 0:
                val = await resp_input.input_value()
                if val and len(val.strip()) > 10:
                    return True

            # 2. Sayfada challenge-running elementi kalmadiysa ve onay tik'i ciktiysa
            running = page.locator("#challenge-running, #challenge-spinner").first
            if await running.count() == 0:
                # Frame icinde success/checked var mi
                for frame in page.frames:
                    if "challenges.cloudflare.com" in frame.url:
                        success_elem = frame.locator("#success, .success, [aria-label*='Success'], svg.ctp-checkbox-checked, input[type='hidden'][value*='0.']").first
                        if await success_elem.count() > 0:
                            return True
        except Exception:
            pass

        return False


class TurnstileSolverSync:
    """
    Playwright Senkron (Sync API) icin Turnstile Cozucusu.
    """

    @staticmethod
    def solve(page, max_wait: int = 35) -> bool:
        """Senkron Playwright icin cozum metodu."""
        print("\n[Turnstile Solver] Cloudflare Turnstile tespiti yapiliyor (Sync Mod)...")
        start_time = time.time()

        while time.time() - start_time < max_wait:
            try:
                resp_input = page.locator("input[name='cf-turnstile-response'], input[name='cf_challenge_response']").first
                if resp_input.count() > 0:
                    val = resp_input.input_value()
                    if val and len(val.strip()) > 10:
                        print("[Turnstile Solver] [BASARILI] Token olustu!")
                        return True
            except Exception:
                pass

            iframe_elem = page.locator("iframe[src*='challenges.cloudflare.com']").first
            if iframe_elem.count() > 0:
                try:
                    box = iframe_elem.bounding_box()
                    if box and box['width'] > 0:
                        click_x = box['x'] + random.uniform(28, 38)
                        click_y = box['y'] + (box['height'] / 2)
                        page.mouse.move(click_x, click_y)
                        time.sleep(0.2)
                        page.mouse.click(click_x, click_y)
                        time.sleep(2.0)
                except Exception:
                    pass

            time.sleep(1.0)

        return False
