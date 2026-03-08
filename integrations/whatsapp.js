const axios = require('axios');

class WhatsAppIntegration {
  constructor(config) {
    this.config = config;
    this.baseURL = `https://graph.facebook.com/v18.0/${config.phone_number_id}`;
    this.headers = {
      'Authorization': `Bearer ${config.access_token}`,
      'Content-Type': 'application/json'
    };
  }

  // Send text message
  async sendMessage(to, message) {
    try {
      const response = await axios.post(`${this.baseURL}/messages`, {
        messaging_product: 'whatsapp',
        to: to,
        type: 'text',
        text: { body: message }
      }, { headers: this.headers });
      console.log(`✓ WhatsApp message sent to ${to}`);
      return response.data;
    } catch (error) {
      console.error(`✗ WhatsApp send error: ${error.message}`);
      throw error;
    }
  }

  // Send appointment confirmation
  async sendAppointmentConfirmation(to, details) {
    const message = `✅ *Appointment Confirmed!*\n\n` +
      `📅 Date: ${details.date}\n` +
      `⏰ Time: ${details.time}\n` +
      `📍 Location: ${details.location || 'Online/TBD'}\n\n` +
      `We'll send you a reminder 24 hours before.\n` +
      `Reply CANCEL to cancel your appointment.`;
    return this.sendMessage(to, message);
  }

  // Send reminder
  async sendReminder(to, details) {
    const message = `⏰ *Reminder!*\n\n` +
      `You have an appointment tomorrow:\n` +
      `📅 ${details.date} at ${details.time}\n\n` +
      `Reply CONFIRM to confirm or CANCEL to cancel.`;
    return this.sendMessage(to, message);
  }

  // Process incoming message
  processIncoming(body) {
    try {
      const entry = body.entry?.[0];
      const changes = entry?.changes?.[0];
      const value = changes?.value;
      const message = value?.messages?.[0];

      if (!message) return null;

      return {
        from: message.from,
        text: message.text?.body || '',
        timestamp: message.timestamp,
        message_id: message.id,
        type: message.type
      };
    } catch (error) {
      console.error('Error processing WhatsApp message:', error);
      return null;
    }
  }

  // Generate smart reply based on message content
  generateReply(message, profile) {
    const text = message.toLowerCase();
    const botName = profile?.bot_name || 'YangkAI';
    const business = profile?.business_name || 'our business';

    if (text.includes('hello') || text.includes('hi') || text.includes('hey')) {
      return `👋 Hello! Welcome to ${business}. I'm ${botName}, your AI assistant.\n\nHow can I help you today?\n\n1️⃣ Book an appointment\n2️⃣ Ask a question\n3️⃣ Check availability`;
    }

    if (text.includes('book') || text.includes('appointment') || text.includes('schedule')) {
      return `📅 I'd love to help you book an appointment!\n\nPlease tell me:\n- Your preferred date\n- Your preferred time\n- Your name\n\nOur working hours are Mon-Fri, 9am-6pm.`;
    }

    if (text.includes('price') || text.includes('cost') || text.includes('how much')) {
      return `💰 I'd be happy to discuss pricing!\n\nCould you tell me more about what service you're interested in? I can give you a tailored quote.`;
    }

    if (text.includes('cancel')) {
      return `❌ I've noted your cancellation request.\n\nCan you please provide:\n- Your name\n- The appointment date you want to cancel\n\nWe'll process this right away.`;
    }

    if (text === '1') {
      return `📅 *Book an Appointment*\n\nPlease send me your preferred:\n- Date (e.g. Monday March 15)\n- Time (e.g. 2pm)\n- Your name and contact`;
    }

    if (text === '2') {
      return `❓ *Ask a Question*\n\nWhat would you like to know? I'm here to help!`;
    }

    if (text === '3') {
      return `🗓️ *Check Availability*\n\nWhat date are you looking at? Send me a date and I'll check our calendar.`;
    }

    return `Thank you for your message! 😊\n\nI've received your inquiry and will get back to you shortly.\n\nFor immediate assistance, reply with:\n1️⃣ Book appointment\n2️⃣ Ask a question\n3️⃣ Check availability`;
  }
}

module.exports = WhatsAppIntegration;
