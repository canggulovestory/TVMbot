const { google } = require('googleapis');
const nodemailer = require('nodemailer');

class GmailIntegration {
  constructor(config) {
    this.config = config;
    this.oauth2Client = new google.auth.OAuth2(
      config.client_id,
      config.client_secret,
      'https://developers.google.com/oauthplayground'
    );
    this.oauth2Client.setCredentials({ refresh_token: config.refresh_token });
    this.gmail = google.gmail({ version: 'v1', auth: this.oauth2Client });
    this.lastChecked = Date.now();
  }

  // Get unread emails
  async getUnreadEmails(maxResults = 10) {
    try {
      const response = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
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

        // Get email body
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
          threadId: detail.data.threadId
        });
      }

      return emails;
    } catch (error) {
      console.error('Error fetching emails:', error.message);
      return [];
    }
  }

  // Check for keywords in emails
  flagImportantEmails(emails, keywords) {
    return emails.filter(email => {
      const content = (email.subject + ' ' + email.body + ' ' + email.snippet).toLowerCase();
      return keywords.some(keyword => content.includes(keyword.toLowerCase()));
    });
  }

  // Send email reply
  async sendReply(threadId, to, subject, body) {
    try {
      const message = [
        `To: ${to}`,
        `Subject: Re: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        '',
        body
      ].join('\n');

      const encodedMessage = Buffer.from(message).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');

      await this.gmail.users.messages.send({
        userId: 'me',
        requestBody: {
          raw: encodedMessage,
          threadId: threadId
        }
      });

      console.log(`✓ Email reply sent to ${to}`);
      return true;
    } catch (error) {
      console.error(`✗ Email send error: ${error.message}`);
      return false;
    }
  }

  // Auto-reply to appointment requests
  generateAutoReply(email, profile) {
    const businessName = profile?.business_name || 'our business';
    const content = (email.subject + ' ' + email.body).toLowerCase();

    if (content.includes('appointment') || content.includes('schedule') || content.includes('book')) {
      return `Thank you for your interest in booking with ${businessName}!\n\n` +
        `We've received your appointment request and will confirm your booking within 24 hours.\n\n` +
        `You can also book instantly via our WhatsApp: ${profile?.whatsapp_number || '[WhatsApp Number]'}\n\n` +
        `Best regards,\nYangkAI Assistant`;
    }

    if (content.includes('price') || content.includes('quote') || content.includes('cost')) {
      return `Thank you for your pricing inquiry!\n\n` +
        `We'd love to provide you with a customized quote. ` +
        `One of our team members will reach out to you within 24 hours.\n\n` +
        `Best regards,\nYangkAI Assistant`;
    }

    return `Thank you for contacting ${businessName}!\n\n` +
      `We've received your message and will respond within 24 hours.\n\n` +
      `Best regards,\nYangkAI Assistant`;
  }

  // Mark email as read
  async markAsRead(messageId) {
    try {
      await this.gmail.users.messages.modify({
        userId: 'me',
        id: messageId,
        requestBody: { removeLabelIds: ['UNREAD'] }
      });
    } catch (error) {
      console.error('Error marking email as read:', error.message);
    }
  }

  // Get email summary for dashboard
  async getEmailSummary() {
    try {
      const unread = await this.gmail.users.messages.list({
        userId: 'me',
        q: 'is:unread',
        maxResults: 1
      });

      const today = await this.gmail.users.messages.list({
        userId: 'me',
        q: `after:${new Date().toISOString().split('T')[0]}`,
        maxResults: 1
      });

      return {
        unread_count: unread.data.resultSizeEstimate || 0,
        today_count: today.data.resultSizeEstimate || 0
      };
    } catch (error) {
      return { unread_count: 0, today_count: 0 };
    }
  }
}

module.exports = GmailIntegration;
