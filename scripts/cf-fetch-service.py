#!/usr/bin/env python3
"""Cloudflare bypass fetch service — local HTTP API for xxb-ts skill system."""

import subprocess, time, os, sys, atexit, json
from flask import Flask, request, jsonify

app = Flask(__name__)

# Start Xvfb once
xvfb = None
def start_xvfb():
    global xvfb
    if xvfb: return
    xvfb = subprocess.Popen(
        ['Xvfb', ':99', '-screen', '0', '1920x1080x24', '-ac'],
        stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    )
    time.sleep(1)
    os.environ['DISPLAY'] = ':99'

def stop_xvfb():
    if xvfb: xvfb.terminate()

atexit.register(stop_xvfb)

def fetch_with_playwright(url, wait=8, timeout=30):
    """Method 1: Playwright + Xvfb."""
    from playwright.sync_api import sync_playwright
    start_xvfb()
    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=False,
            args=['--no-sandbox', '--disable-blink-features=AutomationControlled']
        )
        ctx = browser.new_context(
            viewport={'width': 1920, 'height': 1080},
            user_agent='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
        )
        ctx.add_init_script("Object.defineProperty(navigator, 'webdriver', {get: () => undefined})")
        page = ctx.new_page()
        page.goto(url, timeout=timeout * 1000)
        time.sleep(wait)
        title = page.title()
        if "Just a moment" in title:
            browser.close()
            return None  # CF not bypassed
        text = page.inner_text('body')[:10000]
        browser.close()
        return text

def fetch_with_drission(url, wait=8):
    """Method 2: DrissionPage for strict CF."""
    try:
        from DrissionPage import ChromiumPage, ChromiumOptions
    except ImportError:
        return None
    start_xvfb()
    co = ChromiumOptions()
    # Find playwright chromium
    chrome = subprocess.run(
        ['find', '/root/.cache/ms-playwright', '-name', 'chrome', '-type', 'f'],
        capture_output=True, text=True
    ).stdout.strip().split('\n')[0]
    if chrome:
        co.set_browser_path(chrome)
    co.set_argument('--no-sandbox')
    co.set_argument('--disable-blink-features=AutomationControlled')
    co.set_argument('--disable-gpu')
    co.headless(False)
    page = ChromiumPage(co)
    # Visit homepage first for CF cookies
    from urllib.parse import urlparse
    base = f"{urlparse(url).scheme}://{urlparse(url).netloc}/"
    page.get(base)
    time.sleep(wait)
    page.get(url)
    time.sleep(5)
    title = page.title
    if "Just a moment" in title:
        page.quit()
        return None
    body = page.ele('tag:body')
    text = body.text[:10000] if body else ''
    page.quit()
    return text

@app.route('/fetch')
def cf_fetch():
    url = request.args.get('url')
    if not url:
        return jsonify({"error": "missing url parameter"}), 400

    # Try simple fetch first
    import urllib.request
    try:
        req = urllib.request.Request(url, headers={
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
        })
        with urllib.request.urlopen(req, timeout=10) as resp:
            html = resp.read().decode('utf-8', errors='replace')
            if 'Just a moment' not in html and len(html) > 500:
                # Strip HTML tags
                import re
                text = re.sub(r'<[^>]+>', ' ', html)
                text = re.sub(r'\s+', ' ', text).strip()[:10000]
                return jsonify({"text": text, "method": "direct"})
    except:
        pass

    # Method 1: Playwright
    try:
        text = fetch_with_playwright(url)
        if text:
            return jsonify({"text": text, "method": "playwright"})
    except Exception as e:
        app.logger.warning(f"Playwright failed: {e}")

    # Method 2: DrissionPage
    try:
        text = fetch_with_drission(url)
        if text:
            return jsonify({"text": text, "method": "drissionpage"})
    except Exception as e:
        app.logger.warning(f"DrissionPage failed: {e}")

    return jsonify({"error": "all methods failed", "url": url}), 502

@app.route('/health')
def health():
    return jsonify({"status": "ok"})

if __name__ == '__main__':
    app.run(host='127.0.0.1', port=8900)
