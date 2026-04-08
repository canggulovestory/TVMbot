// voice-handler.js — Voice Note Transcription + Auto-Action for TVMbot
// Handles voice messages from WhatsApp and Telegram
// Strategy: Use OpenAI Whisper API for transcription, then route to AI

const https = require('https');
const fs = require('fs');
const path = require('path');
const { formatDatetimeInjection } = require('./datetime-context');

const TEMP_DIR = path.join(__dirname, 'data', 'voice-tmp');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

let _aiHandler = null;
let _memory = null;

/**
 * Initialize the voice handler
 */
function init(options = {}) {
  _aiHandler = options.aiHandler || null;
  _memory = options.memory || null;
  console.log('[Voice] Handler initialized');
}

/**
 * Transcribe audio using OpenAI Whisper API
 * Falls back to a description prompt if no API key
 */
async function transcribeAudio(audioBuffer, options = {}) {
  const openaiKey = process.env.OPENAI_API_KEY;
  
  if (openaiKey) {
    // Use OpenAI Whisper API
    return await whisperTranscribe(audioBuffer, openaiKey, options);
  }
  
  // No Whisper key — use Claude to describe what to do with voice note info
  return { 
    text: null, 
    method: 'none',
    note: 'Voice transcription requires OPENAI_API_KEY for Whisper API. Add it to .env to enable.'
  };
}

/**
 * OpenAI Whisper transcription
 */
function whisperTranscribe(audioBuffer, apiKey, options = {}) {
  return new Promise((resolve, reject) => {
    const boundary = '----FormBoundary' + Math.random().toString(36).slice(2);
    
    // Build multipart form data
    const fileField = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="audio.ogg"\r\nContent-Type: audio/ogg\r\n\r\n`),
      audioBuffer,
      Buffer.from('\r\n')
    ]);
    
    const modelField = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="model"\r\n\r\nwhisper-1\r\n`
    );
    
    // Auto-detect language or use hint
    let langField = Buffer.alloc(0);
    if (options.languageHint) {
      langField = Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="language"\r\n\r\n${options.languageHint}\r\n`
      );
    }
    
    const endBoundary = Buffer.from(`--${boundary}--\r\n`);
    const body = Buffer.concat([fileField, modelField, langField, endBoundary]);
    
    const req = https.request({
      hostname: 'api.openai.com',
      port: 443,
      path: '/v1/audio/transcriptions',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': body.length
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.text) {
            resolve({ text: parsed.text, method: 'whisper', language: options.languageHint || 'auto' });
          } else {
            reject(new Error(parsed.error?.message || 'Whisper transcription failed'));
          }
        } catch(e) { reject(e); }
      });
    });
    
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

/**
 * Process a voice message end-to-end:
 *   1. Transcribe audio
 *   2. Route transcribed text through AI handler
 *   3. Return AI response
 */
async function processVoiceMessage(voiceData) {
  const { buffer, userId, chatId, userName, isGroup, channel, caption, duration } = voiceData;
  
  console.log(`[Voice] Processing ${duration}s voice note from ${userName} (${channel})`);
  
  // Step 1: Transcribe
  const transcription = await transcribeAudio(buffer, {
    languageHint: null // auto-detect (supports Indonesian + English)
  });
  
  if (!transcription.text) {
    // No transcription available — inform user
    if (transcription.note) {
      return `🎤 I received your voice message (${duration}s) but voice transcription is not yet configured.\n\n_${transcription.note}_\n\nPlease type your message instead, or ask the admin to add an OpenAI API key.`;
    }
    return '🎤 Sorry, I could not transcribe that voice message. Please try again or type your message.';
  }
  
  const transcribedText = transcription.text;
  console.log(`[Voice] Transcribed (${transcription.method}): "${transcribedText.slice(0, 100)}..."`);
  
  // Step 2: Route through AI with voice context prefix
  if (_aiHandler) {
    const voicePrefix = `[🎤 Voice message transcription (${duration}s, ${transcription.method})]: `;
    const contextNote = caption ? `\n[Voice caption: ${caption}]` : '';
    
    const result = await _aiHandler({
      text: voicePrefix + transcribedText + contextNote,
      senderPhone: userId,
      senderName: userName,
      isGroup,
      groupJid: isGroup ? chatId : null,
      replyJid: chatId,
      quotedText: null,
      channel
    });
    
    // Prepend transcription to response so user knows what was heard
    const transcriptPreview = transcribedText.length > 150 
      ? transcribedText.slice(0, 150) + '...' 
      : transcribedText;
    
    return `🎤 _"${transcriptPreview}"_\n\n${result}`;
  }
  
  return `🎤 Transcribed: "${transcribedText}"\n\n(AI handler not configured)`;
}

/**
 * Download media from WhatsApp via Baileys
 */
async function downloadWhatsAppMedia(message, sock) {
  try {
    const { downloadMediaMessage } = require('@whiskeysockets/baileys');
    const buffer = await downloadMediaMessage(message, 'buffer', {});
    return buffer;
  } catch(e) {
    console.error('[Voice] WA media download error:', e.message);
    return null;
  }
}

module.exports = { init, processVoiceMessage, transcribeAudio, downloadWhatsAppMedia };
