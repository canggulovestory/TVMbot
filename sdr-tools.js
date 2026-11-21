'use strict';
// AI SDR tools for the isolated chat. Owner (Afni) only; the model cannot choose the user.
function createSdrTools(sdr, userKey, createEmailDraft) {
 if (userKey !== 'afni') return {};
 const invalid = message => ({ ok: false, error: 'invalid_arguments', message });
 const obj = input => input && typeof input === 'object' && !Array.isArray(input);
 const only = (input, keys) => obj(input) && Object.keys(input).every(k => keys.includes(k));
 // Tools are created per incoming message: a draft saved in this message cannot be approved in it,
 // so Afni always sees the full draft before approving it in her next message.
 const draftedNow = new Set(), packetedNow = new Set();
 const run = async work => { try { return { ok: true, ...(await work()) }; } catch (error) { return { ok: false, error: 'not_done', message: error.message }; } };
 return {
  async sdr_add_lead(input, { beforeWrite = async () => {} } = {}) {
   if (!only(input, ['type', 'name', 'email', 'phone', 'area', 'villa', 'source', 'sourceUrl', 'notes'])) return invalid('Input: {type:owner|renter,name,source,email?,phone?,area?,villa?,sourceUrl?,notes?}');
   await beforeWrite();
   return run(() => sdr.addLead(input));
  },
  async sdr_list_leads(input) {
   if (!only(input || {}, ['stage', 'type', 'due', 'limit'])) return invalid('Input: {stage?,type?,due?:boolean,limit?}');
   return run(() => sdr.listLeads(input || {}));
  },
  async sdr_lead_packet(input) {
   if (!only(input, ['id']) || typeof input.id !== 'string') return invalid('Input: {id:string}');
   packetedNow.add(input.id);
   return run(async () => ({ packet: await sdr.packet(input.id) }));
  },
  async sdr_save_draft(input, { beforeWrite = async () => {} } = {}) {
   if (!only(input, ['id', 'channel', 'subject', 'body']) || typeof input.id !== 'string' || typeof input.body !== 'string') return invalid('Input: {id,channel:email|whatsapp,subject?,body}');
   if (!packetedNow.has(input.id)) return { ok: false, error: 'not_done', message: 'Call sdr_lead_packet for this lead first in this message.' };
   await beforeWrite();
   draftedNow.add(input.id);
   return run(async () => ({ lead: await sdr.saveDraft(input.id, input), next: 'Show Afni the full draft (subject + body) and its ref code, and ask: approve, edit, skip or do-not-contact.' }));
  },
  async sdr_approve_draft(input, { beforeWrite = async () => {} } = {}) {
   if (!only(input, ['id', 'ref']) || typeof input.id !== 'string' || typeof input.ref !== 'string') return invalid('Input: {id:string,ref:string (the ref code shown with the draft)}');
   if (draftedNow.has(input.id)) return { ok: false, error: 'not_done', message: 'Show Afni the draft first; she approves it in her next message.' };
   await beforeWrite();
   return run(() => sdr.approveDraft(input.id, input.ref, createEmailDraft));
  },
  async sdr_mark_lead(input, { beforeWrite = async () => {} } = {}) {
   if (!only(input, ['id', 'status', 'note']) || typeof input.id !== 'string' || typeof input.status !== 'string') return invalid('Input: {id,status:sent|replied|meeting|won|lost|dnc,note?}');
   await beforeWrite();
   return run(async () => ({ lead: await sdr.markLead(input.id, input.status, input.note) }));
  },
 };
}
module.exports = { createSdrTools };
