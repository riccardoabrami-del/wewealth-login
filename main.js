const { chromium, devices } = require('playwright');
const fs = require('fs');
const Imap = require('imap');
const { simpleParser } = require('mailparser');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractOtp(text) {
  if (!text) return null;
  const patterns = [
    /\b(\d{6})\b/,
    /codice[^0-9]{0,20}(\d{6})/i,
    /otp[^0-9]{0,20}(\d{6})/i,
    /verification code[^0-9]{0,20}(\d{6})/i
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1];
  }
  return null;
}

async function saveDebug(page, name) {
  try { await page.screenshot({ path: `${name}.png`, fullPage: true }); } catch (_) {}
  try {
    const html = await page.content();
    fs.writeFileSync(`${name}.html`, html || '', 'utf8');
  } catch (_) {}
  console.log(`Debug salvato: ${name}.png / ${name}.html`);
}

async function jsClick(page, selector) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (el) { el.click(); return true; }
    return false;
  }, selector);
}

async function closePossibleOverlays(page) {
  const selectors = [
    'button[aria-label="Close"]',
    'button[aria-label="Chiudi"]',
    '.iubenda-cs-close-btn',
    '.iubenda-cs-accept-btn',
    '#iubenda-cs-accept-btn',
    '.cc-btn',
    '.cookie-accept',
    '.cookie-banner-accept'
  ];
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ force: true }).catch(() => {});
        await wait(500);
      }
    } catch (_) {}
  }
}

function getGmailCreds() {
  const user = process.env.EMAIL_USER || process.env.email_user || process.env.GMAIL_USER || '';
  const pass = process.env.EMAIL_APP_PASSWORD || process.env.EMAIL_USER_PASSWORD || process.env.gmail_app_password || '';
  return { user, pass };
}

async function readLatestOtpFromGmailIMAP(expectedEmail) {
  const { user, pass } = getGmailCreds();
  if (!user || !pass) {
    console.log('[IMAP] Credenziali Gmail non presenti.');
    return null;
  }
  return new Promise((resolve) => {
    const imap = new Imap({
      user,
      password: pass,
      host: 'imap.gmail.com',
      port: 993,
      tls: true,
      connTimeout: 30000,
      authTimeout: 30000,
      tlsOptions: { rejectUnauthorized: false }
    });
    let resolved = false;
    const done = (value) => {
      if (!resolved) {
        resolved = true;
        try { imap.end(); } catch (_) {}
        resolve(value);
      }
    };
    imap.once('ready', () => {
      imap.openBox('INBOX', true, (err) => {
        if (err) { console.error('[IMAP] Errore openBox:', err); return done(null); }
        imap.search(['ALL'], (err, results) => {
          if (err) { console.error('[IMAP] Errore search:', err); return done(null); }
          if (!results || !results.length) { console.log('[IMAP] Nessuna email trovata.'); return done(null); }
          const latestIds = results.slice(-10);
          const fetch = imap.fetch(latestIds, { bodies: '' });
          const emails = [];
          fetch.on('message', (msg) => {
            let rawBuffer = '';
            msg.on('body', (stream) => { stream.on('data', (chunk) => { rawBuffer += chunk.toString('utf8'); }); });
            msg.once('attributes', (attrs) => { emails.push({ raw: () => rawBuffer, date: attrs.date || new Date(0) }); });
          });
          fetch.once('error', (err) => { console.error('[IMAP] Errore fetch:', err); done(null); });
          fetch.once('end', async () => {
            try {
              emails.sort((a, b) => new Date(b.date) - new Date(a.date));
              for (const item of emails) {
                const mail = await simpleParser(item.raw());
                const subject = mail.subject || '';
                const text = mail.text || '';
                const html = typeof mail.html === 'string' ? mail.html : '';
                const combined = `${subject}\n${text}\n${html}`;
                const lower = combined.toLowerCase();
                const isRelevant =
                  lower.includes('we-wealth') ||
                  lower.includes('wewealth') ||
                  lower.includes('otp') ||
                  lower.includes('codice') ||
                  lower.includes(expectedEmail.toLowerCase());
                if (!isRelevant) continue;
                const otp = extractOtp(combined);
                if (otp) { console.log(`[IMAP] OTP trovata: ${otp}`); return done(otp); }
              }
              console.log('[IMAP] Nessuna OTP trovata nelle ultime email.');
              done(null);
            } catch (e) { console.error('[IMAP] Errore parsing email:', e); done(null); }
          });
        });
      });
    });
    imap.once('error', (err) => { console.error('[IMAP] Errore connessione IMAP:', err); done(null); });
    imap.once('end', () => { if (!resolved) done(null); });
    imap.connect();
  });
}

async function pollOtpFromGmail(expectedEmail, attempts = 12, delayMs = 10000) {
  for (let i = 0; i < attempts; i++) {
    console.log(`[IMAP] Tentativo lettura OTP ${i + 1}/${attempts}...`);
    const otp = await readLatestOtpFromGmailIMAP(expectedEmail);
    if (otp) return otp;
    await wait(delayMs);
  }
  return null;
}

async function waitForWelcomeScreen(page) {
  for (let i = 0; i < 25; i++) {
    const greenCheckVisible = await page.locator('img[src*="green-check"]').first().isVisible().catch(() => false);
    const welcomeVisible =
      greenCheckVisible ||
      await page.locator('text=/ben tornato/i').first().isVisible().catch(() => false) ||
      await page.locator('text=/bentornato/i').first().isVisible().catch(() => false) ||
      await page.locator('text=/welcome back/i').first().isVisible().catch(() => false) ||
      await page.locator('text=/Thank you/i').first().isVisible().catch(() => false) ||
      await page.locator('button:has-text("COMPLETE"), button:has-text("CLOSE")').first().isVisible().catch(() => false);
    if (welcomeVisible) return true;
    await wait(1500);
  }
  return false;
}

async function main() {
  const desktop = devices['Desktop Chrome'];
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    ...desktop,
    viewport: { width: 1440, height: 900 },
    locale: 'it-IT',
    timezoneId: 'Europe/Rome'
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.we-wealth.com', { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
    await wait(8000);
    await saveDebug(page, 'login-01-home');

    await closePossibleOverlays(page);

    const cookieClicked = await jsClick(page, 'a.ww-cookiebanner__brand');
    console.log(cookieClicked ? 'Cookie banner chiuso via JS.' : 'Cookie banner non trovato.');
    await wait(2000);
    await saveDebug(page, 'login-02-after-cookie');

    const accediClicked = await jsClick(page, 'a.btn-accedi.otp-popup-button');
    if (!accediClicked) throw new Error('Non trovato a.btn-accedi.otp-popup-button nel DOM');
    console.log('Link Accedi cliccato via JS.');
    await wait(3000);
    await saveDebug(page, 'login-03-after-accedi');

    const preEmailClicked = await jsClick(page, '#otp-submit-button');
    if (preEmailClicked) {
      console.log('Bottone otp-submit-button cliccato.');
    } else {
      try {
        await page.locator('#otp-submit-button').waitFor({ state: 'visible', timeout: 10000 });
        await jsClick(page, '#otp-submit-button');
        console.log('Bottone otp-submit-button cliccato (dopo attesa).');
      } catch (_) { console.log('otp-submit-button non trovato, procedo.'); }
    }

    await wait(3000);
    await saveDebug(page, 'login-04-before-email');

    const emailInput = page.locator('#otp-email').first();
    await emailInput.waitFor({ state: 'visible', timeout: 20000 });

    const email = 'riccardo.abrami@we-wealth.com';
    console.log(`Email login: ${email}`);
    await emailInput.fill(email);

    const inviaCodiceBtn = page.locator('#otp-start-process').first();
    await inviaCodiceBtn.waitFor({ state: 'visible', timeout: 15000 });
    await inviaCodiceBtn.click();
    console.log('Bottone "Invia codice via email" cliccato.');

    await wait(5000);
    await saveDebug(page, 'login-05-after-send-otp');
    console.log('OTP inviata — attendo via IMAP...');

    const otp = await pollOtpFromGmail(email, 12, 10000);
    if (!otp) throw new Error('OTP non trovata nelle email.');

    console.log(`OTP letta: ${otp}`);
    await page.bringToFront();

    const otpInput = page.locator('#otp-code, input[name="otp"], input[type="tel"]').first();
    await otpInput.waitFor({ state: 'visible', timeout: 20000 });
    await otpInput.fill(otp);
    console.log('OTP inserita nel campo.');
    await wait(1000);

    const confermaBtn = page.locator('#otp-check-button');
    await confermaBtn.waitFor({ state: 'visible', timeout: 20000 });
    await confermaBtn.click();
    console.log('Conferma OTP cliccata.');

    await wait(2000);
    await saveDebug(page, 'login-06-after-otp');

    const ok = await waitForWelcomeScreen(page);
    if (!ok) throw new Error('La schermata di bentornato / check verde non e comparsa.');

    await wait(2000);
    const finalShot = 'login-success.png';
    await page.screenshot({ path: finalShot, fullPage: true });
    console.log(`[SCREENSHOT] Screenshot login salvato: ${finalShot}`);
    await saveDebug(page, 'login-07-welcome-success');

    console.log('Script login completato con successo.');
  } catch (error) {
    console.error('Errore durante esecuzione login:', error);
    await saveDebug(page, 'login-debug-error');
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
}

main();
