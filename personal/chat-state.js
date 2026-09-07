(function (root) {
  'use strict';
  function createChat(request, changed = () => {}) {
    const state = { messages: [], busy: false };
    state.send = async value => {
      const text = String(value || '').trim();
      if (!text || state.busy) return;
      const reply = { role: 'assistant', text: 'Zuzu is thinking…', pending: true };
      state.messages.push({ role: 'user', text }, reply);
      state.busy = true;
      changed();
      try {
        const result = await request(text);
        if (!String(result?.reply || '').trim()) throw Error('No reply was received.');
        reply.text = String(result.reply);
      } catch (error) {
        reply.text = `I couldn’t answer: ${error.message}. Your message is still here. Check saved records before repeating an action.`;
      } finally {
        reply.pending = false;
        state.busy = false;
        changed();
      }
    };
    return state;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = createChat;
  else root.createLifeChat = createChat;
})(typeof globalThis !== 'undefined' ? globalThis : this);
