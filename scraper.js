// Gas Price Monitor — scraper.js
// Checks Kwik Trip (direct API) and Casey's (Playwright)
// Sends Gmail alert when any price changes
// Prices are stored in prices.json and committed back to the repo

const { chromium } = require('playwright');
const https = require('https');
const fs = require('fs');
const path = require('path');

// ── Configuration (set via GitHub Secrets / env vars) ─────────────────────────

const ALERT_EMAIL       = process.env.ALERT_EMAIL;        // Where to send alerts
const GMAIL_USER        = process.env.GMAIL_USER;         // Your Gmail address
const GMAIL_APP_PASS    = process.env.GMAIL_APP_PASS;     // Gmail App Password

// Active window: 7am–9pm Central Time
// Script is triggered every 2 hours by GitHub Actions cron (UTC)
// We enforce the local window here so no action is taken outside hours
const TZ_OFFSET_HOURS   = -5;  // Central Standard Time (CST = UTC-5)
                                // During CDT (summer), change to -5 still works
                                // because GitHub will fire at :00 UTC and we check here

const WINDOW_START      = 7;   // 7am local
const WINDOW_END        = 21;  // 9pm local

const KWIKTRIP_IDS = (process.env.KWIKTRIP_IDS || '1213').split(',').map(s => s.trim()).filter(Boolean);
const CASEYS_URLS  = (process.env.CASEYS_URLS  || '').split(',').map(s => s.trim()).filter(Boolean);

const PRICES_FILE = path.join(__dirname, 'prices.json');

// ── Timezone check ────────────────────────────────────────────────────────────

function isInWindow() {
  const nowUTC   = new Date();
  const localHour = (nowUTC.getUTCHours() + 24 + TZ_OFFSET_HOURS) % 24;
  console.log(`Current local hour: ${localHour} (UTC: ${nowUTC.getUTCHours()})`);
  return localHour >= WINDOW_START && localHour < WINDOW_END;
}

// ── Load / save prices ────────────────────────────────────────────────────────

function loadPrices() {
  try {
    return JSON.parse(fs.readFileSync(PRICES_FILE, 'utf8'));
  } catch {
    return {};
  }
}

function savePrices(data) {
  fs.writeFileSync(PRICES_FILE, JSON.stringify(data, null, 2));
}

// ── HTTP helper ───────────────────────────────────────────────────────────────

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' } }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(data);
        else reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

// ── Kwik Trip fetcher ─────────────────────────────────────────────────────────

async function fetchKwikTrip(storeId) {
  const FUEL_MAP = {
    UNLEADED: 'Regular', MIDGRADE: 'Mid-grade',
    PREMIUM: 'Premium', DIESEL: 'Diesel', E85: 'E85',
  };
  const endpoints = [
    `https://api.kwiktrip.com/api/location/store/information/${storeId}`,
    `https://www.kwiktrip.com/maps/api/v1/storefinder/store/${storeId}`,
  ];
  for (const url of endpoints) {
    try {
      const raw  = await httpGet(url);
      const data = JSON.parse(raw);
      const prices = {};
      (data.fuel || data.fuelTypes || []).forEach(f => {
        const p = parseFloat(f.currentPrice ?? f.price ?? f.cashPrice);
        if (!isNaN(p) && p > 1) {
          prices[FUEL_MAP[f.type ?? f.fuelType] || f.type || f.fuelType || 'Other'] = p;
        }
      });
      if (!Object.keys(prices).length) continue;
      const a = data.address || {};
      return {
        brand:   'Kwik Trip',
        name:    data.name || data.storeName || `Kwik Trip #${storeId}`,
        address: [a.address1, a.city, a.state].filter(Boolean).join(', '),
        prices,
      };
    } catch (e) {
      console.warn(`  Kwik Trip #${storeId} endpoint failed (${url}): ${e.message}`);
    }
  }
  throw new Error(`Could not fetch Kwik Trip #${storeId}`);
}

// ── Casey's fetcher via Playwright ────────────────────────────────────────────

async function fetchCaseys(storeUrl, browser) {
  const FUEL_MAP = {
    'regular': 'Regular', 'unleaded': 'Regular',
    'midgrade': 'Mid-grade', 'mid-grade': 'Mid-grade', 'plus': 'Mid-grade',
    'premium': 'Premium', 'super': 'Premium',
    'diesel': 'Diesel', 'e85': 'E85', 'e-85': 'E85',
  };

  const page = await browser.newPage();
  try {
    // Spoof a real browser to avoid bot detection
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    console.log(`  Loading Casey's: ${storeUrl}`);
    await page.goto(storeUrl, { waitUntil: 'networkidle', timeout: 30000 });

    // Wait for price elements to appear (up to 15s)
    try {
      await page.waitForFunction(() => {
        const text = document.body.innerText;
        return /\$[23]\.\d{2,3}/.test(text);
      }, { timeout: 15000 });
    } catch {
      console.warn('  Price elements did not appear within timeout — trying anyway');
    }

    // Extract everything from the live page
    const result = await page.evaluate((fuelMap) => {
      const out = { name: '', address: '', prices: {} };

      // Name
      const nameEl = document.querySelector('h1, [class*="store-name"], [class*="StoreTitle"], [class*="storeName"]');
      if (nameEl) out.name = nameEl.innerText.trim();

      // Address
      const addrEl = document.querySelector('[class*="address"], [class*="Address"], [class*="location-detail"]');
      if (addrEl) out.address = addrEl.innerText.trim().replace(/\n+/g, ', ');

      // Strategy 1: window.__NEXT_DATA__
      if (window.__NEXT_DATA__) {
        try {
          const pp = (window.__NEXT_DATA__.props || {}).pageProps || {};
          const sd = pp.store || pp.storeDetails || pp.storeInfo || (pp.initialData || {}).store || {};
          if (!out.name && sd.name) out.name = sd.name;
          const adr = sd.address || sd.storeAddress || {};
          if (!out.address) {
            out.address = [adr.line1 || adr.address1, adr.city, adr.state || adr.stateCode]
              .filter(Boolean).join(', ');
          }
          const fa = sd.fuelPrices || sd.fuel || sd.gasPrices || sd.fuelTypes || [];
          fa.forEach(f => {
            const t = (f.type || f.fuelType || f.gradeType || f.grade || '').toLowerCase().trim();
            const p = parseFloat(f.price || f.cashPrice || f.currentPrice || f.amount);
            if (!isNaN(p) && p > 1) out.prices[fuelMap[t] || t] = p;
          });
        } catch (e) { /* continue */ }
      }

      // Strategy 2: scan DOM for price text near fuel keywords
      if (!Object.keys(out.prices).length) {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const texts  = [];
        let node;
        while ((node = walker.nextNode())) texts.push({ text: node.textContent.trim(), el: node.parentElement });

        texts.forEach(({ text, el }) => {
          const priceMatch = text.match(/^\$?([23]\.\d{2,3})$/);
          if (!priceMatch || !el) return;
          const price = parseFloat(priceMatch[1]);
          let parent = el;
          for (let i = 0; i < 5; i++) {
            if (!parent) break;
            const pText = (parent.innerText || '').toLowerCase();
            for (const [term, label] of Object.entries(fuelMap)) {
              if (pText.includes(term) && !out.prices[label]) {
                out.prices[label] = price;
                break;
              }
            }
            parent = parent.parentElement;
          }
        });
      }

      return out;
    }, FUEL_MAP);

    if (!Object.keys(result.prices).length) {
      // Last resort: dump visible text so we can debug
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.warn(`  No prices found. Page text snippet:\n${bodyText}`);
      throw new Error(`No fuel prices found on Casey's page: ${storeUrl}`);
    }

    if (!result.name) {
      const parts = storeUrl.replace('https://www.caseys.com/general-store/', '').split('/');
      result.name = "Casey's — " + (parts[1] || parts[0]).replace(/-/g, ' ');
    }

    return { brand: "Casey's", name: result.name, address: result.address, prices: result.prices };

  } finally {
    await page.close();
  }
}

// ── Diff prices ───────────────────────────────────────────────────────────────

function diffPrices(key, store, history) {
  const prev    = history[key]?.prices || {};
  const curr    = store.prices;
  const changes = [];

  for (const [fuel, newPrice] of Object.entries(curr)) {
    const oldPrice = prev[fuel];
    const arrow    = newPrice > (oldPrice ?? newPrice) ? '▲' : '▼';
    console.log(`  [${store.name}] ${fuel}: $${newPrice.toFixed(3)}${oldPrice !== undefined ? `  (was $${oldPrice.toFixed(3)})` : '  (first reading)'}`);
    if (oldPrice !== undefined && Math.abs(newPrice - oldPrice) >= 0.001) {
      changes.push({ fuel, oldPrice, newPrice });
    }
  }

  history[key] = { name: store.name, address: store.address, prices: curr, updatedAt: new Date().toISOString() };
  return changes;
}

// ── Email via Gmail SMTP ──────────────────────────────────────────────────────

function sendEmail(subject, textBody, htmlBody) {
  return new Promise((resolve, reject) => {
    // Use nodemailer if available, otherwise fall back to raw SMTP
    try {
      const nodemailer = require('nodemailer');
      const transporter = nodemailer.createTransport({
        service: 'gmail',
        auth: { user: GMAIL_USER, pass: GMAIL_APP_PASS },
      });
      transporter.sendMail(
        { from: GMAIL_USER, to: ALERT_EMAIL, subject, text: textBody, html: htmlBody },
        (err, info) => {
          if (err) reject(err);
          else { console.log(`Email sent: ${info.response}`); resolve(); }
        }
      );
    } catch {
      reject(new Error('nodemailer not available'));
    }
  });
}

function buildEmail(allChanges) {
  const now = new Date().toLocaleString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
    hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
  });
  const nTotal  = allChanges.reduce((s, x) => s + x.changes.length, 0);
  const nStores = allChanges.length;
  const subject = `⛽ Gas price change — ${nTotal} update${nTotal !== 1 ? 's' : ''} at ${nStores} store${nStores !== 1 ? 's' : ''}`;

  const textLines = [`Gas price changes detected on ${now}:\n`];
  const htmlParts = [
    `<p style="font-family:sans-serif"><strong>Gas price changes — ${now}</strong></p>`,
  ];

  for (const { store, changes } of allChanges) {
    const brandBg    = store.brand === "Casey's" ? '#ddeeff' : '#fff3cd';
    const brandColor = store.brand === "Casey's" ? '#1a4a80' : '#7a5000';
    textLines.push(`[${store.brand}] ${store.name}${store.address ? '\n' + store.address : ''}`);
    htmlParts.push(
      `<div style="margin:16px 0;font-family:sans-serif">`
      + `<span style="font-size:11px;font-weight:700;padding:2px 8px;border-radius:99px;background:${brandBg};color:${brandColor};margin-right:8px">${store.brand}</span>`
      + `<strong>${store.name}</strong>`
      + (store.address ? `<br><span style="color:#888;font-size:13px">${store.address}</span>` : '')
      + `<table style="border-collapse:collapse;margin-top:8px">`
    );
    for (const c of changes) {
      const up    = c.newPrice > c.oldPrice;
      const diff  = Math.abs(c.newPrice - c.oldPrice).toFixed(3);
      const arrow = up ? '▲' : '▼';
      const color = up ? '#c0392b' : '#27ae60';
      textLines.push(`  ${c.fuel}: $${c.oldPrice.toFixed(3)} → $${c.newPrice.toFixed(3)} (${arrow}${diff})`);
      htmlParts.push(
        `<tr>`
        + `<td style="padding:3px 12px 3px 0">${c.fuel}</td>`
        + `<td style="padding:3px 12px 3px 0;color:#aaa;text-decoration:line-through">$${c.oldPrice.toFixed(3)}</td>`
        + `<td style="padding:3px 12px 3px 0;font-weight:bold">→ $${c.newPrice.toFixed(3)}</td>`
        + `<td style="color:${color};font-weight:bold">${arrow}${diff}</td>`
        + `</tr>`
      );
    }
    textLines.push('');
    htmlParts.push(`</table></div>`);
  }
  htmlParts.push(`<p style="font-size:11px;color:#bbb;font-family:sans-serif">Sent by Gas Price Monitor · GitHub Actions + Playwright</p>`);

  return { subject, text: textLines.join('\n'), html: htmlParts.join('\n') };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\n=== Gas Price Monitor — ${new Date().toISOString()} ===`);

  if (!isInWindow()) {
    console.log('Outside active window (7am–9pm Central). Exiting.');
    process.exit(0);
  }

  if (!ALERT_EMAIL || !GMAIL_USER || !GMAIL_APP_PASS) {
    console.error('Missing required env vars: ALERT_EMAIL, GMAIL_USER, GMAIL_APP_PASS');
    process.exit(1);
  }

  const history    = loadPrices();
  const allChanges = [];
  let   browser    = null;

  try {
    // ── Kwik Trip (no browser needed) ───────────────────────
    for (const id of KWIKTRIP_IDS) {
      console.log(`\nFetching Kwik Trip #${id}...`);
      try {
        const store   = await fetchKwikTrip(id);
        const changes = diffPrices(`kt_${id}`, store, history);
        if (changes.length) allChanges.push({ store, changes });
      } catch (e) {
        console.error(`  ERROR: ${e.message}`);
      }
    }

    // ── Casey's (Playwright) ─────────────────────────────────
    if (CASEYS_URLS.length) {
      console.log('\nLaunching browser for Casey\'s...');
      browser = await chromium.launch({ headless: true });

      for (const url of CASEYS_URLS) {
        console.log(`\nFetching Casey's: ${url}`);
        try {
          const store   = await fetchCaseys(url, browser);
          const changes = diffPrices(`cy_${url.split('/').pop()}`, store, history);
          if (changes.length) allChanges.push({ store, changes });
        } catch (e) {
          console.error(`  ERROR: ${e.message}`);
        }
      }
    }

  } finally {
    if (browser) await browser.close();
  }

  // Save updated prices back to file (GitHub Actions will commit it)
  savePrices(history);
  console.log('\nPrices saved to prices.json');

  // Send email if anything changed
  if (allChanges.length) {
    console.log(`\n${allChanges.reduce((s,x) => s + x.changes.length, 0)} price change(s) detected — sending email...`);
    const { subject, text, html } = buildEmail(allChanges);
    await sendEmail(subject, text, html);
  } else {
    console.log('\nNo price changes detected.');
  }

  console.log('\n=== Done ===\n');
}

main().catch(e => { console.error('Fatal error:', e); process.exit(1); });
