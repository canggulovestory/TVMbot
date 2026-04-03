const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// ─── AUTO-INSTANTIATE with config from integrations.json ──────────────────────
function getConfig() {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'integrations.json'), 'utf8'
  ));
  return config.gmail || {};
}

class GmailIntegration {
  constructor(config) {
    this.config = config;
    this.oauth2Client = new google.auth.OAuth2(
      config.client_id,
      config.client_secret,
      'https://developers.google.com/oauthplayground'
    );
    const creds = {};
    if (config.access_token) creds.access_token = config.access_token;
    if (config.refresh_token) creds.refresh_token = config.refresh_token;
    this.oauth2Client.setCredentials(creds);
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    this.lastChecked = Date.now();
  }

  // ─── getEmails — called by executor as gmail.getEmails(maxResults, query) ───
  async getEmails(maxResults = 10, query = '') {
    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: query || '',
        maxResults: maxResults
      });

      const messages = response.data.messages || [];
      const emails = [];

      for (const msg of messages) {
        const detail = await this.gmail.users.messages.get({
          userId: 'me',
          id: msg.id
        });

        const headers = detail.data.payload.headers;
        const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
        const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
        const date = headers.find(h => h.name === 'Date')?.value || '';
        const labels = detail.data.labelIds || [];

        let body = '';
        if (detail.data.payload.parts) {
          const textPart = detail.data.payload.parts.find(p => p.mimeType === 'text/plain');
          if (textPart?.body?.data) {
            body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
          }
        } else if (detail.data.payload.body?.data) {
          body = Buffer.from(detail.data.payload.body.data, 'base64').toString('utf-8');
        }

        emails.push({
          id: msg.id,
          subject,
          from,
          date,
          body: body.substring(0, 1000),
          snippet: detail.data.snippet,
          threadId: detail.data.threadId,
          isUnread: labels.includes('UNREAD')
        });
      }

      return emails;
    } catch (error) {
      console.error('Error fetching emails:', error.message);
      return [];
    }
  }

  // ─── readEmail — called by executor as gmail.readEmail(messageId) ───────────
  async readEmail(messageId) {
    try {
      const detail = await this.gmail.users.messages.get({
        userId: 'me',
        id: messageId,
        format: 'full'
      });

      const headers = detail.data.payload.headers;
      const subject = headers.find(h => h.name === 'Subject')?.value || 'No Subject';
      const from = headers.find(h => h.name === 'From')?.value || 'Unknown';
      const to = headers.find(h => h.name === 'To')?.value || '';
      const date = headers.find(h => h.name === 'Date')?.value || '';

      let body = '';
      if (detail.data.payload.parts) {
        const textPart = detail.data.payload.parts.find(p => p.mimeType === 'text/plain');
        if (textPart?.body?.data) {
          body = Buffer.from(textPart.body.data, 'base64').toString('utf-8');
        }
      } else if (detail.data.payload.body?.data) {
        body = Buffer.from(detail.data.payload.body.data, 'base64').toString('utf-8');
      }

      return {
        id: messageId,
        subject,
        from,
        to,
        date,
        body,
        snippet: detail.data.snippet,
        threadId: detail.data.threadId,
        labels: detail.data.labelIds || []
      };
    } catch (error) {
      console.error('Error reading email:', error.message);
      throw error;
    }
  }

  // ─── sendEmail — called by executor as gmail.sendEmail(to, subject, body) ───
  async sendEmail(to, subject, body) {
    try {
      const message = [
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/html; charset=utf-8`,
        '',
        body
      ].join('\n');

      const encodedMessage = Buffer.from(message).toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

      const res = await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: { raw: encodedMessage }
      });

      console.log(`✓ Email sent to ${to}: ${subject}`);
      return { id: res.data.id, threadId: res.data.threadId };
    } catch (error) {
      console.error(`✗ Email send error: ${error.message}`);
      throw error;
    }
  }

  // ─── getFlaggedEmails — called by executor ──────────────────────────────────
  async getFlaggedEmails(maxResults = 10) {
    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:starred',
        maxResults
      });

      const messages = response.data.messages || [];
      const emails = [];
      for (const msg of messages) {
        const detail = await this.gmail.users.messages.get({ userId: 'me', id: msg.id });
        const headers = detail.data.payload.headers;
        emails.push({
          id: msg.id,
          subject: headers.find(h => h.name === 'Subject')?.value || 'No Subject',
          from: headers.find(h => h.name === 'From')?.value || 'Unknown',
          date: headers.find(h => h.name === 'Date')?.value || '',
          snippet: detail.data.snippet
        });
      }
      return emails;
    } catch (error) {
      console.error('Error fetching flagged emails:', error.message);
      return [];
    }
  }

  // ─── getUnreadEmails — kept for server.js cron compatibility ────────────────
  async getUnreadEmails(maxResults = 10) {
    return this.getEmails(maxResults, 'is:unread');
  }

  // ─── getEmailSummary — for dashboard ────────────────────────────────────────
  async getEmailSummary() {
    try {
      const unread = await this.gmail.users.messages.list({
        userId: 'me', q: 'is:unread', maxResults: 1
      });
      const today = await this.gmail.users.messages.list({
        userId: 'me', q: `after:${new Date().toISOString().split('T')[0]}`, maxResults: 1
      });
      return {
        unread_count: unread.data.resultSizeEstimate || 0,
        today_count: today.data.resultSizeEstimate || 0
      };
    } catch (error) {
      return { unread_count: 0, today_count: 0 };
    }
  }

  // ─── markAsRead ─────────────────────────────────────────────────────────────
  async markAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me', id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
    } catch (error) {
      console.error('Error marking email as read:', error.message);
    }
  }
}

// ─── Export singleton instance ────────────────────────────────────────────────
const config = getConfig();
if (config.client_id && config.refresh_token) {
  module.exports = new GmailIntegration(config);
} else {
  console.warn('[Gmail] No credentials found — Gmail disabled');
  module.exports = null;
}

