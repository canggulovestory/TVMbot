const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

// ─── AUTO-INSTANTIATE with config from integrations.json ──────────────────────
function getConfig() {
  const config = JSON.parse(fs.readFileSync(
    path.join(__dirname, '..', 'config', 'integrations.json'), 'utf8'
  ));
  const cal = config.calendar || {};
  const sheets = config.sheets || {};
  return {
    client_id: cal.client_id || sheets.client_id,
    client_secret: cal.client_secret || sheets.client_secret,
    refresh_token: cal.refresh_token || sheets.refresh_token,
    calendar_id: cal.calendar_id || 'primary',
    timezone: cal.timezone || 'Asia/Makassar',
    appointment_duration_minutes: cal.appointment_duration_minutes || 60,
    buffer_minutes: cal.buffer_minutes || 15,
  };
}

class GoogleCalendarIntegration {
  constructor(config) {
    this.config = config;
    this.oauth2Client = new google.auth.OAuth2(
      config.client_id,
      config.client_secret,
      'https://developers.google.com/oauthplayground'
    );
    this.oauth2Client.setCredentials({ refresh_token: config.refresh_token });
    this.calendar = google.calendar({ version: 'v3', auth: this.oauth2Client });
  }

  // ─── getEvents ────────────────────────────────────────────────────────────
  async getEvents(maxResults = 10, timeMin, timeMax) {
    try {
      const now = new Date();
      const params = {
        calendarId: this.config.calendar_id,
        singleEvents: true,
        orderBy: 'startTime',
        maxResults
      };
      if (timeMin) params.timeMin = new Date(timeMin).toISOString();
      else params.timeMin = now.toISOString();
      if (timeMax) params.timeMax = new Date(timeMax).toISOString();

      const response = await this.calendar.events.list(params);
      return (response.data.items || []).map(event => ({
        id: event.id,
        title: event.summary || 'No title',
        description: event.description || '',
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        location: event.location || '',
        attendees: event.attendees?.map(a => a.email) || [],
        htmlLink: event.htmlLink
      }));
    } catch (error) {
      console.error('Error fetching events:', error.message);
      return [];
    }
  }

  // ─── checkAvailability ────────────────────────────────────────────────────
  async checkAvailability(startTime, endTime) {
    try {
      const events = await this.getEvents(50, startTime, endTime);
      return events.length === 0;
    } catch (error) {
      console.error('Error checking availability:', error.message);
      return false;
    }
  }

  // ─── createEvent ──────────────────────────────────────────────────────────
  async createEvent({ title, description, startTime, endTime, location, attendees }) {
    try {
      const event = {
        summary: title,
        description: description || '',
        location: location || '',
        start: { dateTime: new Date(startTime).toISOString(), timeZone: this.config.timezone },
        end: { dateTime: new Date(endTime).toISOString(), timeZone: this.config.timezone },
        attendees: attendees ? attendees.map(e => typeof e === 'string' ? { email: e } : e) : [],
        reminders: {
          useDefault: false,
          overrides: [
            { method: 'email', minutes: 24 * 60 },
            { method: 'popup', minutes: 30 }
          ]
        }
      };

      const response = await this.calendar.events.insert({
        calendarId: this.config.calendar_id,
        requestBody: event,
        sendUpdates: attendees?.length ? 'all' : 'none'
      });

      console.log('Calendar event created:', response.data.id);
      return {
        id: response.data.id,
        htmlLink: response.data.htmlLink,
        start: startTime,
        end: endTime
      };
    } catch (error) {
      console.error('Error creating event:', error.message);
      throw error;
    }
  }

  // ─── deleteEvent — DELETE a calendar event by ID ──────────────────────────
  async deleteEvent(eventId) {
    try {
      await this.calendar.events.delete({
        calendarId: this.config.calendar_id,
        eventId: eventId,
        sendUpdates: 'all'
      });
      console.log('Calendar event deleted:', eventId);
      return { success: true, deletedId: eventId };
    } catch (error) {
      console.error('Error deleting event:', error.message);
      if (error.code === 404) {
        return { success: false, error: 'Event not found. It may have already been deleted.' };
      }
      throw error;
    }
  }

  // ─── updateEvent — UPDATE an existing calendar event ──────────────────────
  async updateEvent(eventId, updates) {
    try {
      const existing = await this.calendar.events.get({
        calendarId: this.config.calendar_id,
        eventId: eventId
      });
      const event = existing.data;
      if (updates.title) event.summary = updates.title;
      if (updates.description !== undefined) event.description = updates.description;
      if (updates.location !== undefined) event.location = updates.location;
      if (updates.startTime) {
        event.start = { dateTime: new Date(updates.startTime).toISOString(), timeZone: this.config.timezone };
      }
      if (updates.endTime) {
        event.end = { dateTime: new Date(updates.endTime).toISOString(), timeZone: this.config.timezone };
      }
      if (updates.attendees) {
        event.attendees = updates.attendees.map(e => typeof e === 'string' ? { email: e } : e);
      }
      const response = await this.calendar.events.update({
        calendarId: this.config.calendar_id,
        eventId: eventId,
        requestBody: event,
        sendUpdates: updates.attendees ? 'all' : 'none'
      });
      console.log('Calendar event updated:', eventId);
      return { id: response.data.id, htmlLink: response.data.htmlLink, updated: Object.keys(updates) };
    } catch (error) {
      console.error('Error updating event:', error.message);
      throw error;
    }
  }

  // ─── findEventByTitle — search events by title ────────────────────────────
  async findEventByTitle(title, daysAhead = 90) {
    try {
      const now = new Date();
      const future = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);
      const events = await this.getEvents(100, now.toISOString(), future.toISOString());
      return events.filter(e => e.title.toLowerCase().includes(title.toLowerCase()));
    } catch (error) {
      console.error('Error finding event:', error.message);
      return [];
    }
  }

  // ─── getUpcomingAppointments ──────────────────────────────────────────────
  async getUpcomingAppointments(days = 7) {
    const now = new Date();
    const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    return this.getEvents(20, now.toISOString(), future.toISOString());
  }

  // ─── getAvailableSlots ────────────────────────────────────────────────────
  async getAvailableSlots(date) {
    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(9, 0, 0, 0);
      const endOfDay = new Date(date);
      endOfDay.setHours(18, 0, 0, 0);

      const events = await this.getEvents(50, startOfDay.toISOString(), endOfDay.toISOString());
      const busySlots = events.map(e => ({
        start: new Date(e.start),
        end: new Date(e.end)
      }));

      const slots = [];
      const current = new Date(startOfDay);
      const duration = this.config.appointment_duration_minutes || 60;
      const buffer = this.config.buffer_minutes || 15;

      while (current < endOfDay) {
        const slotEnd = new Date(current.getTime() + duration * 60000);
        const isAvailable = !busySlots.some(busy =>
          (current >= busy.start && current < busy.end) ||
          (slotEnd > busy.start && slotEnd <= busy.end)
        );
        if (isAvailable && slotEnd <= endOfDay) {
          slots.push({
            time: current.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
            datetime: new Date(current)
          });
        }
        current.setTime(current.getTime() + (duration + buffer) * 60000);
      }
      return slots;
    } catch (error) {
      console.error('Error getting available slots:', error.message);
      return [];
    }
  }
}

// ─── Export singleton instance ────────────────────────────────────────────────
const config = getConfig();
if (config.client_id && config.refresh_token) {
  module.exports = new GoogleCalendarIntegration(config);
} else {
  console.warn('[Calendar] No credentials found - Calendar disabled');
  module.exports = null;
}
