#!/usr/bin/env python3
# /storage/emulated/0/Download/iptv/register_test.py
# End-to-end IPTV Trial Registration Test with TLS Spoofing

import os
import sys
import time
import json
import random
import re
from curl_cffi import requests

TARGET_URL = "https://iptvload.org/free-iptv-trial-24-hours/"

FIRST_NAMES = ['David', 'James', 'Michael', 'Robert', 'Thomas', 'Daniel', 'Sarah', 'Emily']
LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Miller', 'Davis']
COUNTRIES = ['United Kingdom', 'Germany', 'Norway', 'Sweden', 'Netherlands', 'Denmark']
DEVICES = ['Android Box', 'Smart TV', 'Fire Tv Stick', 'Apple TV']
APPS = ['Iptv Smarters Pro', 'Tivimate']


def generate_emailnator():
    print("[*] Emailnator GoogleMail cím generálása...")
    for attempt in range(1, 4):
        try:
            res = requests.post(
                "https://www.emailnator.com/api/generate-email",
                json={"ids": [8]},
                impersonate="chrome120",
                timeout=15,
                headers={
                    "Origin": "https://www.emailnator.com",
                    "Referer": "https://www.emailnator.com/"
                }
            )
            data = res.json()
            if data.get("status") == "success" and data.get("email"):
                print(f"[+] Generált email cím: {data['email']}")
                return data["email"]
        except Exception as e:
            print(f"[-] Emailnator hiba ({attempt}/3): {e}")
        time.sleep(2)
    return None


def check_emailnator_inbox(email: str, max_wait: int = 75):
    print(f"[*] Várakozás a megerősítő kódra ({email})...")
    start = time.time()
    while time.time() - start < max_wait:
        time.sleep(5)
        try:
            res = requests.post(
                "https://www.emailnator.com/api/message-list",
                json={"email": email, "limit": 10},
                impersonate="chrome120",
                headers={
                    "Origin": "https://www.emailnator.com",
                    "Referer": "https://www.emailnator.com/"
                }
            )
            data = res.json()
            for msg in data.get("messages", []):
                subject = msg.get("subject", "")
                m = re.search(r"\b(\d{6})\b", subject)
                if m:
                    code = m.group(1)
                    print(f"[+] Megerősítő kód megtalálva tárgyban: {code}")
                    return code

                # Törzs lekérése ha tárgyban nincs
                msg_id = msg.get("id")
                m_res = requests.get(
                    f"https://www.emailnator.com/api/message/{msg_id}",
                    impersonate="chrome120"
                )
                m_data = m_res.json()
                body = m_data.get("content", "")
                m2 = re.search(r"\b(\d{6})\b", body)
                if m2:
                    code = m2.group(1)
                    print(f"[+] Megerősítő kód megtalálva törzsben: {code}")
                    return code
        except Exception as e:
            print(f"[-] Inbox ellenőrzési hiba: {e}")
    return None


def run_test_registration(turnstile_token: str | None = None):
    print("=" * 60)
    print("IPTVLOAD.ORG TELJES REGISZTRÁCIÓS TESZT (TLS SPOOFING + IVL)")
    print("=" * 60)

    # 1. Email fiók
    email = generate_emailnator()
    if not email:
        print("[-] Nem sikerült email címet generálni.")
        return False

    first_name = random.choice(FIRST_NAMES)
    last_name = random.choice(LAST_NAMES)
    full_name = f"{first_name} {last_name}"
    country = random.choice(COUNTRIES)
    device = random.choice(DEVICES)
    iptv_app = random.choice(APPS)

    print(f"[+] Név: {full_name}")
    print(f"[+] Ország: {country}")
    print(f"[+] Eszköz / App: {device} / {iptv_app}")

    # 2. Turnstile token ellenőrzése
    token = turnstile_token or os.environ.get("TURNSTILE_TOKEN")
    if not token:
        print("\n[!] MEGJEGYZÉS: Turnstile token nincs megadva.")
        print("    A Cloudflare Turnstile token az X-IVL-TS fejlécben kötelező a megerősítő kód kiküldéséhez.")
        print("    Render.com-on a Docker konténer háttérben automatikusan megszerzi Playwright-tal.")
        print("    Androidon manuálisan is átadható: export TURNSTILE_TOKEN='0.xxx...'")

    # 3. Kód kiküldése (POST /wp-json/ivl/v1/send)
    print("\n[*] 1. Lépés: Kód kérése (POST /wp-json/ivl/v1/send)...")
    headers = {
        "Origin": "https://iptvload.org",
        "Referer": TARGET_URL,
        "Content-Type": "application/json",
        "Accept": "application/json"
    }
    if token:
        headers["X-IVL-TS"] = token

    send_res = requests.post(
        "https://iptvload.org/wp-json/ivl/v1/send",
        json={"form_id": 1019, "email": email},
        impersonate="chrome120",
        headers=headers,
        timeout=25
    )

    print(f"[+] Send státusz: {send_res.status_code}")
    print(f"[+] Send válasz: {send_res.text}")
    send_data = send_res.json()

    if not send_data.get("ok"):
        if send_data.get("code") == "captcha":
            print("\n[-] A szerver érvényes Turnstile tokent kér (X-IVL-TS) a kód kiküldéséhez.")
        else:
            print(f"[-] Hiba: {send_data.get('message')}")
        return False

    # 4. Kód beolvasása inboxból
    ivl_token = send_data.get("token")
    if not ivl_token:
        code = check_emailnator_inbox(email)
        if not code:
            print("[-] A 6 jegyű kód nem érkezett meg.")
            return False

        # 5. Kód ellenőrzése
        print("\n[*] 2. Lépés: Kód ellenőrzése (POST /wp-json/ivl/v1/verify)...")
        verify_res = requests.post(
            "https://iptvload.org/wp-json/ivl/v1/verify",
            json={"form_id": 1019, "email": email, "code": code},
            impersonate="chrome120",
            headers=headers,
            timeout=25
        )
        print(f"[+] Verify válasz: {verify_res.text}")
        verify_data = verify_res.json()
        if not verify_data.get("ok") or not verify_data.get("token"):
            print("[-] Sikertelen ellenőrzés.")
            return False
        ivl_token = verify_data["token"]

    print(f"[+] Sikeres email hitelesítés! IVL Token: {ivl_token[:20]}...")

    # 6. WPForms küldés
    print("\n[*] 3. Lépés: WPForms beküldése (POST /wp-admin/admin-ajax.php)...")
    page_res = requests.get(TARGET_URL, impersonate="chrome120")
    m = re.search(r'name="wpforms\[time_token\]"\s+value="([^"]+)"', page_res.text)
    time_token = m.group(1) if m else ""

    cookies_dict = dict(page_res.cookies)
    form_data = {
        'wpforms[fields][1]': full_name,
        'wpforms[fields][1][first]': first_name,
        'wpforms[fields][1][last]': last_name,
        'wpforms[fields][36]': country,
        'wpforms[fields][2]': email,
        'wpforms[fields][3]': '',
        'wpforms[fields][5]': device,
        'wpforms[fields][9]': iptv_app,
        'wpforms[fields][23]': 'I would like to try your IPTV service please. Thank you!',
        'wpforms[id]': '1019',
        'wpforms[post_id]': '1321',
        'wpforms[time_token]': time_token,
        'wpforms[hp]': '',
        'page_title': 'Free IPTV Trial',
        'page_url': TARGET_URL,
        'page_id': '1321',
        'action': 'wpforms_submit',
        'ivl_token': ivl_token
    }

    submit_res = requests.post(
        "https://iptvload.org/wp-admin/admin-ajax.php",
        data=form_data,
        cookies=cookies_dict,
        impersonate="chrome120",
        headers={
            "Origin": "https://iptvload.org",
            "Referer": TARGET_URL,
            "X-Requested-With": "XMLHttpRequest"
        },
        timeout=25
    )

    print(f"[+] WPForms státusz: {submit_res.status_code}")
    print(f"[+] WPForms válasz: {submit_res.text[:400]}")

    if "Thank you" in submit_res.text or "successful" in submit_res.text or "true" in submit_res.text:
        print("\n[✓] SIKERES IPTV REGISZTRÁCIÓ!")
        return True
    else:
        print("\n[-] Az űrlap beküldése nem igazolódott vissza.")
        return False


if __name__ == "__main__":
    t_token = sys.argv[1] if len(sys.argv) > 1 else None
    run_test_registration(t_token)
