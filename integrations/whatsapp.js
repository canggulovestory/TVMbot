// integrations/whatsapp.js — WhatsApp Business API via Twilio
// Handles incoming WhatsApp messages and sends replies through TVMbot PEMS agent

const express = require('express');
const router = express.Router();

// ─── Config ───────────────────────────────────────────────────────────────────
// Set these in .env:
//   TWILIO_ACCOUNT_SID=ACxxxxxxxxxxxxxxxxxxxx
//   TWILIO_AUTH_TOKEN=xxxxxxxxxxxxxxxxxxxxxxxx
//   TWILIO_WHATSAPP_FROM=whatsapp:+14155238886  (Twilio sandbox number)

let twilio;
try {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken  = process.env.TWILIO_AUTH_TOKEN;
  if (accountSid && authToken) {
    twilio = require('twilio')(accountSid, authToken);
    console.log('[WhatsApp] Twilio client initialized');
  } else {
    console.warn('[WhatsApp] Twilio credentials not set — WhatsApp disabled');
  }
} catch(e) {
  console.warn('[WhatsApp] Twilio not installed:', e.message);
}

// ─── Send WhatsApp Message ────────────────────────────────────────────────────
async function sendMessage(to, body) {
  if (!twilio) throw new Error('Twilio not configured');

  // Ensure number is in WhatsApp format
  const toFormatted = to.startsWith('whatsapp:') ? to : `whatsapp:${to}`;
  const fromNumber  = process.env.TWILIO_WHATSAPP_FROM || 'whatsapp:+14155238886';

  const message = await twilio.messages.create({
    from: fromNumber,
    to:   toFormatted,
    body: body
  });

  console.log(`[WhatsApp] Sent to ${to}: ${message.sid}`);
  return { success: true, sid: message.sid };
}

// ─── Receive Webhook (Twilio → TVMbot) ────────────────────────────────────────
// Twilio will POST to /whatsapp/webhook when a message is received
// Add to server.js: app.use('/whatsapp', whatsapp.router);
router.post('/webhook', express.urlencoded({ extended: false }), async (req, res) => {
  const from    = req.body.From;    // e.g. "whatsapp:+6281234567890"
  const body    = req.body.Body;    // message text
  const profile = req.body.ProfileName || 'Guest';

  console.log(`[WhatsApp] Message from ${from} (${profile}): ${body}`);

  // Send to TVMbot PEMS agent
  try {
    const { runPEMSAgent } = require('../server');
    const sessionId = `wa_${from.replace(/\D/g, '')}`;
    const result = await runPEMSAgent(body, sessionId, from);

    // Reply back via WhatsApp
    await sendMessage(from, result.reply);

    // Twilio expects TwiML response (even empty is fine)
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  } catch(err) {
    console.error('[WhatsApp] Webhook error:', err.message);
    await sendMessage(from, 'Sorry, I had trouble processing that. Please try again.');
    res.set('Content-Type', 'text/xml');
    res.send('<Response></Response>');
  }
});

// ─── Status Check ─────────────────────────────────────────────────────────────
function isConfigured() {
  return !!(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
}

module.exports = { sendMessage, router, isConfigured };
