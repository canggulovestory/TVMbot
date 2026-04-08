// email-watcher.js — TVMbot Auto Email → Sheets Logger
// Watches Gmail for Airbnb booking confirmations & bank payment notifications
// Option 2: Gmail Push (Pub/Sub) with fallback polling
// Sends WhatsApp confirmation to MONEY FLOW group after each log

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

// ─── Config ───────────────────────────────────────────────────────────────────
const CONFIG_PATH = path.join(__dirname, '..', 'config', 'integrations.json');
const STATE_FILE = path.join(__dirname, '..', 'data', 'email-watcher-state.json');

// Google Sheets IDs
const STAFF_SHEET_ID = '1oJzztdHyOPR2XD6zS2ma942U-u6i1nsE_G5sccGeFJw';
const EXPENSES_SHEET_ID = '1TeJKaJGt-A0Jo1rNAxtnyTwNnFSCdEwuAy9rNW8ePW4';

// WhatsApp notification group (MONEY FLOW)
const NOTIFICATION_GROUP_JID = '120363183761561180@g.us';

// Pub/Sub config
const PUBSUB_TOPIC = 'projects/yangai/topics/gmail-notifications';

// Event bus — emits domain events when emails are processed
let _eventBus = null;
function setEventBus(bus) { _eventBus = bus; }

class EmailWatcher {
  constructor() {
    this.config = this._loadConfig();
    this.auth = this._buildAuth();
    this.gmail = google.gmail({ version: 'v1', auth: this.auth });
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
    this.state = this._loadState();
    this.whatsapp = null; // injected by server.js
    this.isRunning = false;
    this.watchExpiry = null;

    // Email patterns to match
    this.patterns = {
      airbnb: {
        from: ['automated@airbnb.com', 'express@airbnb.com', 'noreply@airbnb.com', 'airbnb.com'],
        subjects: ['reservation confirmed', 'booking confirmed', 'new reservation', 'reservation request',
                   'payout', 'payout initiated', 'payout sent', 'earning summary', 'you have a new',
                   'reservation update', 'reservation cancelled', 'alteration request'],
        type: 'booking_platform'
      },
      booking_com: {
        from: ['noreply@booking.com', 'customer.service@booking.com', 'booking.com'],
        subjects: ['new booking', 'booking confirmation', 'reservation', 'guest arriving',
                   'payment confirmation', 'payout'],
        type: 'booking_platform'
      },
      bank_bca: {
        from: ['bca.co.id', 'klikbca.com', 'notification@bca.co.id'],
        subjects: ['mutasi', 'transfer masuk', 'incoming transfer', 'credit', 'dana masuk',
                   'notifikasi transaksi', 'transaction notification'],
        type: 'bank_payment'
      },
      bank_mandiri: {
        from: ['mandiri.co.id', 'notification@bankmandiri.co.id'],
        subjects: ['mutasi', 'transfer masuk', 'incoming transfer', 'credit',
                   'notifikasi transaksi'],
        type: 'bank_payment'
      },
      bank_bni: {
        from: ['bni.co.id', 'notification@bni.co.id'],
        subjects: ['mutasi', 'transfer', 'credit', 'notifikasi'],
        type: 'bank_payment'
      },
      wise: {
        from: ['noreply@wise.com', 'wise.com'],
        subjects: ['received', 'payment received', 'money received', 'transfer complete'],
        type: 'bank_payment'
      },
      paypal: {
        from: ['service@paypal.com', 'paypal.com'],
        subjects: ['received a payment', 'money received', 'payment received'],
        type: 'bank_payment'
      }
    };
  }

  // ─── Auth & Config ──────────────────────────────────────────────────────────
  _loadConfig() {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    } catch (e) {
      console.error('[EmailWatcher] Config load error:', e.message);
      return {};
    }
  }

  _buildAuth() {
    const cfg = this.config.gmail || {};
    const auth = new google.auth.OAuth2(
      cfg.client_id,
      cfg.client_secret,
      'https://developers.google.com/oauthplayground'
    );
    const creds = {};
    if (cfg.access_token) creds.access_token = cfg.access_token;
    if (cfg.refresh_token) creds.refresh_token = cfg.refresh_token;
    auth.setCredentials(creds);

    // Auto-refresh token and save
    auth.on('tokens', (tokens) => {
      try {
        const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        if (tokens.access_token) {
          for (const svc of ['sheets', 'gmail', 'docs', 'drive', 'google_calendar']) {
            if (config[svc]) config[svc].access_token = tokens.access_token;
          }
          config.gmail.token_updated_at = new Date().toISOString();
        }
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2));
        console.log('[EmailWatcher] Token auto-refreshed');
      } catch (e) { console.error('[EmailWatcher] Token save error:', e.message); }
    });

    return auth;
  }

  // ─── State Management (track processed emails) ──────────────────────────────
  _loadState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      if (fs.existsSync(STATE_FILE)) {
        return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      }
    } catch (e) { /* fresh state */ }
    return {
      processedIds: [],
      lastHistoryId: null,
      lastPollTime: null,
      stats: { total_processed: 0, airbnb: 0, bank: 0, errors: 0 }
    };
  }

  _saveState() {
    try {
      const dir = path.dirname(STATE_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      // Keep only last 500 processed IDs to prevent file bloat
      if (this.state.processedIds.length > 500) {
        this.state.processedIds = this.state.processedIds.slice(-500);
      }
      fs.writeFileSync(STATE_FILE, JSON.stringify(this.state, null, 2));
    } catch (e) {
      console.error('[EmailWatcher] State save error:', e.message);
    }
  }

  isProcessed(messageId) {
    return this.state.processedIds.includes(messageId);
  }

  markProcessed(messageId) {
    if (!this.state.processedIds.includes(messageId)) {
      this.state.processedIds.push(messageId);
    }
    this._saveState();
  }

  // ─── Gmail Push Notification (Pub/Sub) ──────────────────────────────────────

  // Start watching Gmail for push notifications
  async startWatch(topicName) {
    try {
      const res = await this.gmail.users.watch({
        userId: 'me',
        requestBody: {
          topicName: topicName || PUBSUB_TOPIC,
          labelIds: ['INBOX']
        }
      });

      this.watchExpiry = parseInt(res.data.expiration);
      this.state.lastHistoryId = res.data.historyId;
      this._saveState();

      const expiryDate = new Date(this.watchExpiry);
      console.log(`[EmailWatcher] Gmail watch started. Expires: ${expiryDate.toISOString()}`);
      console.log(`[EmailWatcher] History ID: ${res.data.historyId}`);

      return res.data;
    } catch (err) {
      if (!global._ewWatchWarned) { console.error("[EmailWatcher] Gmail watch setup failed (polling mode active):", err.message); global._ewWatchWarned = true; }
      throw err;
    }
  }

  // Stop watching
  async stopWatch() {
    try {
      await this.gmail.users.stop({ userId: 'me' });
      this.watchExpiry = null;
      console.log('[EmailWatcher] Gmail watch stopped');
    } catch (err) {
      console.error('[EmailWatcher] Watch stop error:', err.message);
    }
  }

  // Handle incoming Pub/Sub push notification
  async handlePushNotification(data) {
    try {
      // Decode the Pub/Sub message
      const decoded = JSON.parse(Buffer.from(data, 'base64').toString('utf-8'));
      const historyId = decoded.historyId;
      const emailAddress = decoded.emailAddress;

      console.log(`[EmailWatcher] Push notification: email=${emailAddress}, historyId=${historyId}`);

      if (!this.state.lastHistoryId) {
        console.log('[EmailWatcher] No previous history ID — running full poll instead');
        return await this.pollForNewEmails();
      }

      // Fetch history since last known ID
      const history = await this.gmail.users.history.list({
        userId: 'me',
        startHistoryId: this.state.lastHistoryId,
        historyTypes: ['messageAdded']
      });

      // Update history ID
      this.state.lastHistoryId = historyId;
      this._saveState();

      if (!history.data.history) {
        console.log('[EmailWatcher] No new messages in history');
        return { processed: 0 };
      }

      // Extract new message IDs
      const newMessageIds = [];
      for (const record of history.data.history) {
        if (record.messagesAdded) {
          for (const added of record.messagesAdded) {
            const id = added.message.id;
            if (!this.isProcessed(id)) {
              newMessageIds.push(id);
            }
          }
        }
      }

      console.log(`[EmailWatcher] ${newMessageIds.length} new messages to check`);

      let processed = 0;
      for (const msgId of newMessageIds) {
        const result = await this._processEmail(msgId);
        if (result) processed++;
      }

      return { processed, total_checked: newMessageIds.length };
    } catch (err) {
      console.error('[EmailWatcher] Push handler error:', err.message);
      this.state.stats.errors++;
      this._saveState();
      return { error: err.message };
    }
  }

  // ─── Fallback Polling ───────────────────────────────────────────────────────

  async pollForNewEmails() {
    if (this.isRunning) {
      console.log('[EmailWatcher] Poll already running — skipping');
      return { skipped: true };
    }

    this.isRunning = true;
    console.log('[EmailWatcher] Starting poll scan...');

    try {
      let processed = 0;

      // Build Gmail search query for all patterns
      const queries = [];

      // Airbnb emails
      queries.push('from:airbnb.com newer_than:1d');
      // Booking.com emails
      queries.push('from:booking.com newer_than:1d');
      // Bank notifications (Indonesian + international)
      queries.push('(from:bca.co.id OR from:mandiri.co.id OR from:bni.co.id) newer_than:1d');
      // International payment services
      queries.push('(from:wise.com OR from:paypal.com) subject:(received OR payment) newer_than:1d');

      const fullQuery = `(${queries.join(' OR ')}) is:inbox`;

      const res = await this.gmail.users.messages.list({
        userId: 'me',
        q: fullQuery,
        maxResults: 20
      });

      const messages = res.data.messages || [];
      console.log(`[EmailWatcher] Found ${messages.length} matching emails`);

      for (const msg of messages) {
        if (this.isProcessed(msg.id)) continue;
        const result = await this._processEmail(msg.id);
        if (result) processed++;
      }

      this.state.lastPollTime = new Date().toISOString();
      this._saveState();

      console.log(`[EmailWatcher] Poll complete. Processed: ${processed}/${messages.length}`);
      return { processed, total_found: messages.length };
    } catch (err) {
      console.error('[EmailWatcher] Poll error:', err.message);
      this.state.stats.errors++;
      this._saveState();
      return { error: err.message };
    } finally {
      this.isRunning = false;
    }
  }

  // ─── Email Processing Pipeline ──────────────────────────────────────────────

  async _processEmail(messageId) {
    try {
      // Fetch full email
      const detail = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });

      const headers = detail.data.payload.headers;
      const from = (headers.find(h => h.name === 'From')?.value || '').toLowerCase();
      const subject = (headers.find(h => h.name === 'Subject')?.value || '').toLowerCase();
      const date = headers.find(h => h.name === 'Date')?.value || '';

      // Get email body
      let body = '';
      if (detail.data.payload.parts) {
        const textPart = detail.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        } else {
          // Try HTML part
          const htmlPart = detail.data.payload.parts.find(p => p.mimeType === 'text/html');
          if (htmlPart?.body?.data) {
            body = Buffer.from(htmlPart.body.data, 'base64').toString('utf-8')
              .replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
        }
      } else if (detail.data.payload.body?.data) {
        body = Buffer.from(detail.data.payload.body.data, 'base64').toString('utf-8');
      }

      // Classify the email
      const classification = this._classifyEmail(from, subject, body);

      if (!classification) {
        // Not a matching email — skip but mark processed
        this.markProcessed(messageId);
        return null;
      }

      console.log(`[EmailWatcher] Matched: ${classification.source} / ${classification.type}`);

      // Parse based on type
      let parsed;
      switch (classification.source) {
        case 'airbnb':
          parsed = this._parseAirbnbEmail(subject, body, date);
          break;
        case 'booking_com':
          parsed = this._parseBookingComEmail(subject, body, date);
          break;
        default:
          parsed = this._parseBankEmail(classification.source, subject, body, date);
          break;
      }

      if (!parsed || !parsed.amount) {
        console.log(`[EmailWatcher] Could not parse meaningful data from ${classification.source} email`);
        this.markProcessed(messageId);
        return null;
      }

      // Write to Google Sheets
      const logResult = await this._logToSheets(parsed, classification);

      // Send WhatsApp notification
      await this._sendNotification(parsed, classification);

      // Mark as processed
      this.markProcessed(messageId);

      // Update stats
      this.state.stats.total_processed++;
      if (classification.type === 'booking_platform') {
        // Sync to memory.db for dashboard metrics
        const bookingData = {
          guest_name: parsed.guest_name || '',
          guest_email: parsed.guest_email || '',
          villa_name: parsed.property || '',
          check_in: parsed.check_in || '',
          check_out: parsed.check_out || '',
          price: parsed.amount || parsed.payout || parsed.price || 0,
          amount: parsed.amount || parsed.payout || parsed.price || 0,
          source: 'airbnb_email'
        };
        await this._syncToMemoryDb('booking', bookingData).catch(() => {});
        if (_eventBus) _eventBus.emitBooking(bookingData, parsed.source || 'airbnb_email');
        this.state.stats.airbnb++;
      }
      if (classification.type === 'bank_payment') {
        const paymentData = {
          amount: parsed.amount || 0,
          currency: parsed.currency || 'IDR',
          villa_name: parsed.property || '',
          guest_name: parsed.guest_name || '',
          description: `${parsed.source} payment`,
          source: parsed.source,
          date: parsed.date,
          booking_ref: parsed.booking_ref || '',
          reference: parsed.booking_ref || ''
        };
        await this._syncToMemoryDb('payment', paymentData).catch(() => {});
        if (_eventBus) _eventBus.emitPayment(paymentData, parsed.source || 'bank_email');
        this.state.stats.bank++;
      }
      this._saveState();

      // Label the email as processed (add a label)
      await this._labelEmail(messageId, 'TVMbot-Processed');

      return { parsed, classification, logResult };
    } catch (err) {
      console.error(`[EmailWatcher] Error processing email ${messageId}:`, err.message);
      this.state.stats.errors++;
      this._saveState();
      return null;
    }
  }

  // ─── Email Classification ───────────────────────────────────────────────────

  _classifyEmail(from, subject, body) {
    for (const [source, pattern] of Object.entries(this.patterns)) {
      // Check sender
      const fromMatch = pattern.from.some(f => from.includes(f));
      if (!fromMatch) continue;

      // Check subject (at least one keyword)
      const subjectMatch = pattern.subjects.some(s => subject.includes(s));
      // Also check body for keywords if subject doesn't match
      const bodyMatch = pattern.subjects.some(s => (body || '').toLowerCase().includes(s));

      if (fromMatch && (subjectMatch || bodyMatch)) {
        return { source, type: pattern.type };
      }
    }
    return null;
  }

  // ─── Airbnb Email Parser ────────────────────────────────────────────────────

  _parseAirbnbEmail(subject, body, date) {
    const result = {
      source: 'Airbnb',
      date: this._parseDate(date),
      guest_name: null,
      property: null,
      check_in: null,
      check_out: null,
      nights: null,
      amount: null,
      currency: 'IDR',
      booking_ref: null,
      type: 'income',
      category: 'Airbnb Booking'
    };

    const text = body || '';

    // Guest name patterns
    const guestPatterns = [
      /(?:guest|tamu|from|dari)[:\s]+([A-Z][a-z]+ [A-Z][a-z]+)/i,
      /reservation (?:from|by) ([A-Z][a-z]+ [A-Z][a-z]+)/i,
      /([A-Z][a-z]+ [A-Z][a-z]+) (?:has|is|booked|reserved)/i,
      /([A-Z][a-z]+ [A-Z][a-zA-Z-]+) arrives/i
    ];
    for (const p of guestPatterns) {
      const m = text.match(p);
      if (m) { result.guest_name = m[1].trim(); break; }
    }

    // Property/listing name
    const propPatterns = [
      /(?:listing|property|villa|accommodation)[:\s]+([^\n,]+)/i,
      /(?:at|for)\s+(Villa [A-Za-z]+)/i,
      /(?:at|for)\s+([A-Z][a-z]+ [A-Z][a-z]+ Villa)/i
    ];
    for (const p of propPatterns) {
      const m = text.match(p);
      if (m) { result.property = m[1].trim(); break; }
    }

    // Check-in / Check-out dates
    const datePatterns = [
      /check[- ]?in[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
      /check[- ]?in[:\s]+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i,
      /arrival[:\s]+(\w+ \d{1,2},?\s*\d{4})/i,
      /(\d{1,2}\s+\w+\s+\d{4})\s*[-–]\s*(\d{1,2}\s+\w+\s+\d{4})/i
    ];
    for (const p of datePatterns) {
      const m = text.match(p);
      if (m) {
        result.check_in = m[1]?.trim();
        if (m[2]) result.check_out = m[2].trim();
        break;
      }
    }

    // Check-out if not captured above
    if (!result.check_out) {
      const co = text.match(/check[- ]?out[:\s]+(\w+ \d{1,2},?\s*\d{4}|\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i);
      if (co) result.check_out = co[1].trim();
    }

    // Nights
    const nightsMatch = text.match(/(\d+)\s*(?:night|malam)/i);
    if (nightsMatch) result.nights = parseInt(nightsMatch[1]);

    // Amount (IDR or USD)
    const amountPatterns = [
      /(?:payout|earning|total|amount|harga|jumlah)[:\s]*(?:IDR|Rp\.?\s*)([0-9.,]+)/i,
      /(?:IDR|Rp\.?\s*)([0-9.,]+)/i,
      /(?:payout|earning|total)[:\s]*\$?\s*([0-9.,]+)/i,
      /(?:USD|US\$)\s*([0-9.,]+)/i
    ];
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) {
        result.amount = parseFloat(m[1].replace(/[,\.]/g, (match, offset, str) => {
          // Handle both 15,000,000 and 15.000.000 formats
          const remaining = str.slice(offset + 1);
          return remaining.includes(match) ? '' : '.';
        }));
        if (text.match(/USD|US\$|\$/i) && !text.match(/IDR|Rp/i)) {
          result.currency = 'USD';
        }
        break;
      }
    }

    // Booking reference
    const refMatch = text.match(/(?:confirmation|booking|reservation)\s*(?:code|number|#|ID)[:\s]*([A-Z0-9]+)/i);
    if (refMatch) result.booking_ref = refMatch[1];

    // Detect if this is a payout vs new booking
    if (subject.includes('payout') || body.toLowerCase().includes('payout')) {
      result.category = 'Airbnb Payout';
    }
    if (subject.includes('cancel') || body.toLowerCase().includes('cancelled')) {
      result.category = 'Airbnb Cancellation';
      result.type = 'info';
    }

    return result;
  }

  // ─── Booking.com Email Parser ───────────────────────────────────────────────

  _parseBookingComEmail(subject, body, date) {
    const result = {
      source: 'Booking.com',
      date: this._parseDate(date),
      guest_name: null,
      property: null,
      check_in: null,
      check_out: null,
      nights: null,
      amount: null,
      currency: 'IDR',
      booking_ref: null,
      type: 'income',
      category: 'Booking.com Booking'
    };

    const text = body || '';

    // Guest name
    const guestMatch = text.match(/(?:guest|booked by|name)[:\s]+([A-Z][a-z]+ [A-Z][a-zA-Z-]+)/i);
    if (guestMatch) result.guest_name = guestMatch[1].trim();

    // Property
    const propMatch = text.match(/(?:property|accommodation|listing|villa)[:\s]+([^\n,]+)/i);
    if (propMatch) result.property = propMatch[1].trim();

    // Dates
    const dateMatch = text.match(/(\d{1,2}\s+\w+\s+\d{4})\s*[-–]\s*(\d{1,2}\s+\w+\s+\d{4})/i);
    if (dateMatch) {
      result.check_in = dateMatch[1].trim();
      result.check_out = dateMatch[2].trim();
    }

    // Amount
    const amountMatch = text.match(/(?:total|amount|price)[:\s]*(?:IDR|Rp\.?\s*)([0-9.,]+)/i);
    if (amountMatch) {
      result.amount = this._parseAmount(amountMatch[1]);
    }

    // Booking ref
    const refMatch = text.match(/(?:booking|confirmation)\s*(?:number|#|ID)[:\s]*(\d+)/i);
    if (refMatch) result.booking_ref = refMatch[1];

    // Nights
    const nightsMatch = text.match(/(\d+)\s*(?:night|malam)/i);
    if (nightsMatch) result.nights = parseInt(nightsMatch[1]);

    return result;
  }

  // ─── Bank Email Parser ──────────────────────────────────────────────────────

  _parseBankEmail(source, subject, body, date) {
    const bankNames = {
      bank_bca: 'BCA',
      bank_mandiri: 'Mandiri',
      bank_bni: 'BNI',
      wise: 'Wise',
      paypal: 'PayPal'
    };

    const result = {
      source: bankNames[source] || source,
      date: this._parseDate(date),
      guest_name: null, // sender name from transfer
      property: null,
      amount: null,
      currency: 'IDR',
      booking_ref: null,
      type: 'income',
      category: `Bank Transfer (${bankNames[source] || source})`
    };

    const text = body || '';

    // Amount patterns for Indonesian banks
    const amountPatterns = [
      /(?:sebesar|amount|jumlah|nominal)[:\s]*(?:IDR|Rp\.?\s*)([0-9.,]+)/i,
      /(?:kredit|credit|masuk|received|incoming)[:\s]*(?:IDR|Rp\.?\s*)([0-9.,]+)/i,
      /(?:IDR|Rp\.?\s*)([0-9.,]+)\s*(?:telah|has been|credited|masuk)/i,
      /(?:amount|jumlah)[:\s]*(?:USD|\$)\s*([0-9.,]+)/i,
      /(?:IDR|Rp)\s*([0-9,.]+)/i
    ];
    for (const p of amountPatterns) {
      const m = text.match(p);
      if (m) {
        result.amount = this._parseAmount(m[1]);
        if (source === 'wise' || source === 'paypal') {
          // Check for USD
          if (text.match(/USD|\$/i)) result.currency = 'USD';
        }
        break;
      }
    }

    // Sender name from bank transfer
    const senderPatterns = [
      /(?:dari|from|pengirim|sender|paid by)[:\s]+([A-Za-z ]+?)(?:\n|$|,|\s{2})/i,
      /(?:transfer dari|transferred from)[:\s]+([A-Za-z ]+)/i,
      /(?:atas nama|account name)[:\s]+([A-Za-z ]+)/i
    ];
    for (const p of senderPatterns) {
      const m = text.match(p);
      if (m) { result.guest_name = m[1].trim(); break; }
    }

    // Reference number
    const refPatterns = [
      /(?:ref|reference|no\.?\s*ref|referensi)[:\s]*([A-Z0-9]+)/i,
      /(?:transaction|transaksi)\s*(?:ID|no\.?)[:\s]*([A-Z0-9]+)/i
    ];
    for (const p of refPatterns) {
      const m = text.match(p);
      if (m) { result.booking_ref = m[1]; break; }
    }

    // Try to match villa name in transfer description
    const villaNames = ['ann', 'diane', 'luna', 'lourinka', 'alysaa', 'nissa', 'lysa', 'lian', 'lyma', 'ocean drive', 'kala'];
    const lowerText = text.toLowerCase();
    for (const v of villaNames) {
      if (lowerText.includes(v) || lowerText.includes(`villa ${v}`)) {
        result.property = `Villa ${v.charAt(0).toUpperCase() + v.slice(1)}`;
        break;
      }
    }

    return result;
  }

  // ─── Write to Google Sheets ─────────────────────────────────────────────────

  async _logToSheets(parsed, classification) {
    try {
      const now = new Date();
      const dateStr = `${now.getDate().toString().padStart(2,'0')}/${(now.getMonth()+1).toString().padStart(2,'0')}/${now.getFullYear()}`;

      if (classification.type === 'booking_platform') {
        // Write to Staff Sheet > Income tab (headers at row 7, data from row 8)
        // Columns: B:CANCELLED | C:CATEGORY | D:DATE | E:GUEST NAME | F:NUM GUESTS |
        //          G:PROPERTY | H:CHECK-IN | I:CHECK-OUT | J:NIGHTS | K:RENTAL INCOME |
        //          L:OTHER FEES | M:TOTAL | N:NOTES
        const row = [
          '',                                // B: CANCELLED (empty = not cancelled)
          parsed.category || 'Booking',      // C: CATEGORY
          dateStr,                            // D: DATE
          parsed.guest_name || 'Unknown',     // E: GUEST NAME
          '',                                 // F: NUM GUESTS
          parsed.property || '',              // G: PROPERTY
          parsed.check_in || '',              // H: CHECK-IN
          parsed.check_out || '',             // I: CHECK-OUT
          parsed.nights || '',                // J: NIGHTS
          parsed.amount || '',                // K: RENTAL INCOME
          '',                                 // L: OTHER FEES
          parsed.amount || '',                // M: TOTAL
          `Auto-logged by TVMbot from ${parsed.source} email. Ref: ${parsed.booking_ref || 'N/A'}` // N: NOTES
        ];

        await this.sheets.spreadsheets.values.append({
          spreadsheetId: STAFF_SHEET_ID,
          range: 'Income!B:N',
          valueInputOption: 'USER_ENTERED',
          requestBody: { values: [row] }
        });

        console.log(`[EmailWatcher] Logged ${parsed.source} booking to Staff Sheet: ${parsed.guest_name} / ${parsed.property}`);

      } else if (classification.type === 'bank_payment') {
        // Write to Expenses Sheet > LOG tab or create a simple payment log
        // For bank payments, we log to a PAYMENTS_RECEIVED tracking
        // Use BILLS_DB or a custom "PAYMENTS RECEIVED" tab
        const row = [
          dateStr,                               // Date
          parsed.source,                         // Source (BCA, Mandiri, Wise, etc.)
          parsed.guest_name || 'Unknown Sender',  // From
          parsed.property || 'Unmatched',         // Villa (if detected)
          parsed.amount || 0,                     // Amount
          parsed.currency || 'IDR',               // Currency
          parsed.booking_ref || '',               // Reference
          `Auto-logged by TVMbot from ${parsed.source} email notification` // Notes
        ];

        // Try to append to a PAYMENTS_RECEIVED tab, fall back to Sheet1
        try {
          await this.sheets.spreadsheets.values.append({
            spreadsheetId: EXPENSES_SHEET_ID,
            range: 'PAYMENTS_RECEIVED!A:H',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
          });
        } catch (sheetErr) {
          // Tab might not exist — create it or log to EXPENSES
          console.log(`[EmailWatcher] PAYMENTS_RECEIVED tab not found, logging to notes`);
          // As fallback, we still have the WhatsApp notification
        }

        console.log(`[EmailWatcher] Logged ${parsed.source} payment: ${parsed.currency} ${parsed.amount} from ${parsed.guest_name}`);
      }

      return { success: true };
    } catch (err) {
      console.error('[EmailWatcher] Sheets write error:', err.message);
      return { success: false, error: err.message };
    }
  }

  // ─── WhatsApp Notification ──────────────────────────────────────────────────

  async _sendNotification(parsed, classification) {
    if (!this.whatsapp) {
      console.log('[EmailWatcher] WhatsApp not available — skipping notification');
      return;
    }

    try {
      const status = this.whatsapp.getStatus();
      if (!status.connected) {
        console.log('[EmailWatcher] WhatsApp not connected — skipping notification');
        return;
      }

      let message = '';
      const amountFormatted = parsed.amount
        ? `${parsed.currency} ${Number(parsed.amount).toLocaleString('id-ID')}`
        : 'amount unknown';

      if (classification.type === 'booking_platform') {
        // Booking notification
        message = `📋 *New Booking Logged*\n\n`;
        message += `Source: ${parsed.source}\n`;
        message += `Guest: ${parsed.guest_name || 'Unknown'}\n`;
        if (parsed.property) message += `Property: ${parsed.property}\n`;
        if (parsed.check_in) message += `Check-in: ${parsed.check_in}\n`;
        if (parsed.check_out) message += `Check-out: ${parsed.check_out}\n`;
        if (parsed.nights) message += `Nights: ${parsed.nights}\n`;
        message += `Amount: ${amountFormatted}\n`;
        if (parsed.booking_ref) message += `Ref: ${parsed.booking_ref}\n`;
        message += `\n_Auto-logged from email by TVMbot_`;

      } else if (classification.type === 'bank_payment') {
        // Payment notification
        message = `💰 *Payment Received*\n\n`;
        message += `Logged ${amountFormatted}`;
        if (parsed.guest_name) message += ` from ${parsed.guest_name}`;
        if (parsed.property) message += ` for ${parsed.property}`;
        message += `\n`;
        message += `Bank: ${parsed.source}\n`;
        if (parsed.booking_ref) message += `Ref: ${parsed.booking_ref}\n`;
        message += `Date: ${parsed.date}\n`;
        message += `\n_Auto-logged from email by TVMbot_`;
      }

      if (message) {
        await this.whatsapp.sendMessage(NOTIFICATION_GROUP_JID, message);
        console.log(`[EmailWatcher] WhatsApp notification sent to MONEY FLOW group`);
      }
    } catch (err) {
      console.error('[EmailWatcher] WhatsApp notification error:', err.message);
    }
  }

  // ─── Label Email as Processed ───────────────────────────────────────────────

  async _labelEmail(messageId, labelName) {
    try {
      // Find or create the label
      let labelId = null;
      const labels = await this.gmail.users.labels.list({ userId: 'me' });
      const existing = labels.data.labels.find(l => l.name === labelName);

      if (existing) {
        labelId = existing.id;
      } else {
        // Create the label
        const created = await this.gmail.users.labels.create({
          userId: 'me',
          requestBody: {
            name: labelName,
            labelListVisibility: 'labelShow',
            messageListVisibility: 'show'
          }
        });
        labelId = created.data.id;
      }

      // Apply label to the email
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { addLabelIds: [labelId] }
      });
    } catch (err) {
      // Non-critical — just log
      console.log(`[EmailWatcher] Could not label email: ${err.message}`);
    }
  }


  // ── Sync confirmed booking to memory.db ──────────────────────────────────
  async _syncToMemoryDb(type, data) {
    try {
      const memory = require('../memory');
      if (type === 'booking' && data.guest_name && data.villa_name) {
        // Check if booking already exists to avoid duplicates
        const existing = memory.getBookings({ guest_email: data.guest_email || '' });
        const isDuplicate = existing.some(b =>
          b.guest_name === data.guest_name &&
          b.check_in === data.check_in &&
          b.villa_name === data.villa_name
        );
        if (!isDuplicate) {
          memory.saveBooking({
            guest_name: data.guest_name || 'Unknown',
            guest_email: data.guest_email || '',
            villa_name: data.villa_name || '',
            check_in: data.check_in || data.checkin || '',
            check_out: data.check_out || data.checkout || '',
            price: parseFloat(data.price || data.payout || 0),
            status: 'confirmed',
            notes: `Auto-logged from email: ${data.source || 'unknown'} on ${new Date().toISOString().slice(0,10)}`
          });
          console.log('[EmailWatcher] Synced booking to memory.db:', data.guest_name, data.villa_name);
        }
      } else if (type === 'payment' && data.amount) {
        memory.logTransaction({
          type: 'income',
          category: 'booking',
          description: data.description || `Payment from ${data.source || 'unknown'}`,
          amount: parseFloat(data.amount || 0),
          currency: data.currency || 'IDR',
          villa_name: data.villa_name || '',
          guest_name: data.guest_name || '',
          date: data.date || new Date().toISOString().slice(0, 10),
          status: 'paid',
          reference: data.reference || ''
        });
        console.log('[EmailWatcher] Synced payment to memory.db:', data.amount, data.currency);
      }
    } catch(e) {
      console.warn('[EmailWatcher] memory.db sync failed (non-critical):', e.message);
    }
  }

  // ─── Utility Methods ────────────────────────────────────────────────────────

  _parseDate(dateStr) {
    try {
      const d = new Date(dateStr);
      return `${d.getDate().toString().padStart(2,'0')}/${(d.getMonth()+1).toString().padStart(2,'0')}/${d.getFullYear()}`;
    } catch (e) {
      return new Date().toISOString().slice(0, 10);
    }
  }

  _parseAmount(amountStr) {
    if (!amountStr) return null;
    // Remove thousands separators and normalize
    // Handle both 15,000,000 (en) and 15.000.000 (id) formats
    const cleaned = amountStr.replace(/[^\d.,]/g, '');

    // If there are multiple dots or commas, they're likely thousands separators
    const dots = (cleaned.match(/\./g) || []).length;
    const commas = (cleaned.match(/,/g) || []).length;

    let normalized;
    if (dots > 1) {
      // 15.000.000 format — dots are thousands separators
      normalized = cleaned.replace(/\./g, '');
    } else if (commas > 1) {
      // 15,000,000 format — commas are thousands separators
      normalized = cleaned.replace(/,/g, '');
    } else if (dots === 1 && commas === 1) {
      // Could be 15,000.50 or 15.000,50
      const dotPos = cleaned.indexOf('.');
      const commaPos = cleaned.indexOf(',');
      if (dotPos > commaPos) {
        // 15,000.50 — comma is thousands, dot is decimal
        normalized = cleaned.replace(/,/g, '');
      } else {
        // 15.000,50 — dot is thousands, comma is decimal
        normalized = cleaned.replace(/\./g, '').replace(',', '.');
      }
    } else if (commas === 1) {
      // Single comma — could be decimal or thousands
      const afterComma = cleaned.split(',')[1];
      if (afterComma.length === 3) {
        // Likely thousands separator: 15,000
        normalized = cleaned.replace(',', '');
      } else {
        // Likely decimal: 15,50
        normalized = cleaned.replace(',', '.');
      }
    } else {
      normalized = cleaned;
    }

    return parseFloat(normalized) || null;
  }

  // ─── Status & Stats ─────────────────────────────────────────────────────────

  getStats() {
    return {
      ...this.state.stats,
      lastPollTime: this.state.lastPollTime,
      watchActive: this.watchExpiry ? Date.now() < this.watchExpiry : false,
      watchExpiry: this.watchExpiry ? new Date(this.watchExpiry).toISOString() : null,
      processedCount: this.state.processedIds.length,
      isRunning: this.isRunning
    };
  }

  // Inject WhatsApp module reference
  setWhatsApp(wa) {
    this.whatsapp = wa;
  }
}

module.exports = EmailWatcher;
module.exports.setEventBus = setEventBus;
