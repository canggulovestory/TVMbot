const { google } = require('googleapis');

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

  // Get available slots for a given date
  async getAvailableSlots(date) {
    try {
      const startOfDay = new Date(date);
      startOfDay.setHours(9, 0, 0, 0);

      const endOfDay = new Date(date);
      endOfDay.setHours(18, 0, 0, 0);

      // Get existing events
      const response = await this.calendar.events.list({
        calendarId: this.config.calendar_id,
        timeMin: startOfDay.toISOString(),
        timeMax: endOfDay.toISOString(),
        singleEvents: true,
        orderBy: 'startTime'
      });

      const events = response.data.items || [];
      const busySlots = events.map(e => ({
        start: new Date(e.start.dateTime || e.start.date),
        end: new Date(e.end.dateTime || e.end.date)
      }));

      // Generate available slots (every hour)
      const slots = [];
      const current = new Date(startOfDay);
      const duration = this.config.appointment_duration_minutes || 60;
      const buffer = this.config.buffer_minutes || 15;

      while (current < endOfDay) {
        const slotEnd = new Date(current.getTime() + duration * 60000);

        // Check if slot conflicts with any busy time
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

  // Book an appointment
  async bookAppointment(details) {
    try {
      const { customerName, customerEmail, date, time, service, notes } = details;

      const startDateTime = new Date(`${date} ${time}`);
      const endDateTime = new Date(startDateTime.getTime() + (this.config.appointment_duration_minutes || 60) * 60000);

      const event = {
        summary: `${service || 'Appointment'} - ${customerName}`,
        description: `Customer: ${customerName}\nEmail: ${customerEmail}\nService: ${service || 'General'}\nNotes: ${notes || 'None'}`,
        start: { dateTime: startDateTime.toISOString(), timeZone: this.config.timezone },
        end: { dateTime: endDateTime.toISOString(), timeZone: this.config.timezone },
        attendees: customerEmail ? [{ email: customerEmail }] : [],
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
        sendUpdates: 'all'
      });

      console.log(`✓ Appointment booked: ${response.data.id}`);
      return {
        success: true,
        event_id: response.data.id,
        event_link: response.data.htmlLink,
        start: startDateTime,
        end: endDateTime
      };
    } catch (error) {
      console.error('Error booking appointment:', error.message);
      return { success: false, error: error.message };
    }
  }

  // Get upcoming appointments
  async getUpcomingAppointments(days = 7) {
    try {
      const now = new Date();
      const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

      const response = await this.calendar.events.list({
        calendarId: this.config.calendar_id,
        timeMin: now.toISOString(),
        timeMax: future.toISOString(),
        singleEvents: true,
        orderBy: 'startTime',
        maxResults: 20
      });

      return (response.data.items || []).map(event => ({
        id: event.id,
        title: event.summary,
        start: event.start.dateTime || event.start.date,
        end: event.end.dateTime || event.end.date,
        attendees: event.attendees?.map(a => a.email) || []
      }));
    } catch (error) {
      console.error('Error fetching appointments:', error.message);
      return [];
    }
  }

  // Cancel appointment
  async cancelAppointment(eventId) {
    try {
      await this.calendar.events.delete({
        calendarId: this.config.calendar_id,
        eventId: eventId,
        sendUpdates: 'all'
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: error.message };
    }
  }
}

module.exports = GoogleCalendarIntegration;
