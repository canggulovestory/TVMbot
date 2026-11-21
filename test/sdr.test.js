'use strict';
const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const sdr = require('../sdr');
const { createSdrTools } = require('../sdr-tools');

function fresh(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sdr-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); sdr.init(dir); }
const DRAFT = { channel: 'email', subject: 'Your villa in Canggu', body: 'Hi Budi, we market Bali villas for monthly and long stays.' };

test('leads need a type, a source and a contact, and are deduplicated', async t => {
 fresh(t);
 await assert.rejects(sdr.addLead({ type: 'buyer', name: 'X', source: 's', email: 'a@b.co' }), /owner or renter/);
 await assert.rejects(sdr.addLead({ type: 'owner', name: 'X', email: 'a@b.co' }), /source/);
 await assert.rejects(sdr.addLead({ type: 'owner', name: 'X', source: 'referral' }), /email or a phone/);
 const first = await sdr.addLead({ type: 'owner', name: 'Budi', source: 'referral', email: 'Budi@Example.com' });
 assert.equal(first.duplicate, false); assert.equal(first.lead.stage, 'New');
 assert.equal((await sdr.addLead({ type: 'owner', name: 'Budi 2', source: 'x', email: 'budi@example.com' })).duplicate, true);
});

test('draft -> approve creates a Gmail draft only, then sent schedules a follow-up and stops after three touches', async t => {
 fresh(t);
 const { lead } = await sdr.addLead({ type: 'owner', name: 'Budi', source: 'referral', email: 'budi@example.com' });
 const drafts = [];
 const gmail = async d => { drafts.push(d); return { id: 'g' + drafts.length }; };
 for (let touch = 1; touch <= sdr.MAX_TOUCHES; touch++) {
  const saved = await sdr.saveDraft(lead.id, DRAFT);
  assert.ok(saved.draft.body.endsWith(sdr.PROFILE.optOut));
  await assert.rejects(sdr.markLead(lead.id, 'sent'), /approved draft/);
  await assert.rejects(sdr.approveDraft(lead.id, 'wrong', gmail), /ref is wrong/);
  const approved = await sdr.approveDraft(lead.id, saved.draft.ref, gmail);
  assert.equal(approved.lead.stage, 'Ready to send'); assert.match(approved.next, /Press Send/);
  const sent = await sdr.markLead(lead.id, 'sent');
  assert.equal(sent.touches, touch);
  assert.equal(sent.stage, touch < sdr.MAX_TOUCHES ? 'Sent' : 'No reply');
 }
 assert.equal(drafts.length, 3); assert.equal(drafts[0].to, 'budi@example.com');
 await assert.rejects(sdr.saveDraft(lead.id, DRAFT), /maximum/);
});

test('do-not-contact and replies stop all outreach', async t => {
 fresh(t);
 const a = (await sdr.addLead({ type: 'renter', name: 'Ann', source: 'website', phone: '+62 812 3456 7890' })).lead;
 await sdr.markLead(a.id, 'dnc');
 await assert.rejects(sdr.packet(a.id), /not to be contacted/);
 await assert.rejects(sdr.saveDraft(a.id, { ...DRAFT, channel: 'whatsapp' }), /Do not contact/);
 const b = (await sdr.addLead({ type: 'renter', name: 'Bo', source: 'website', phone: '+62 812 1111 2222' })).lead;
 await sdr.markLead(b.id, 'replied');
 await assert.rejects(sdr.saveDraft(b.id, { ...DRAFT, channel: 'whatsapp' }), /Replied/);
});

test('whatsapp approval returns copy-ready text and never calls Gmail', async t => {
 fresh(t);
 const { lead } = await sdr.addLead({ type: 'renter', name: 'Citra', source: 'Instagram DM', phone: '+62 811 222 333 44' });
 const saved = await sdr.saveDraft(lead.id, { channel: 'whatsapp', body: 'Hi Citra, we have long-stay villas in Bali for you.' });
 const result = await sdr.approveDraft(lead.id, saved.draft.ref, async () => { throw new Error('gmail must not be called'); });
 assert.match(result.next, /WhatsApp/); assert.match(result.next, /Hi Citra/);
});

test('tools: owner only, and a draft cannot be approved in the same message it was written', async t => {
 fresh(t);
 assert.deepEqual(createSdrTools(sdr, 'syifa', async () => {}), {});
 const gmail = async () => ({ id: 'g1' });
 const turn1 = createSdrTools(sdr, 'afni', gmail);
 const added = await turn1.sdr_add_lead({ type: 'owner', name: 'Dewi', source: 'network', email: 'dewi@example.com' });
 assert.equal(added.ok, true);
 const id = added.lead.id;
 assert.equal((await turn1.sdr_save_draft({ id, ...DRAFT })).ok, false); // packet first
 assert.equal((await turn1.sdr_lead_packet({ id })).packet.untrustedLeadData.name, 'Dewi');
 const saved = await turn1.sdr_save_draft({ id, ...DRAFT });
 assert.equal(saved.ok, true);
 const same = await turn1.sdr_approve_draft({ id, ref: saved.lead.draft.ref });
 assert.equal(same.ok, false); assert.match(same.message, /next message/);
 const turn2 = createSdrTools(sdr, 'afni', gmail);
 assert.equal((await turn2.sdr_approve_draft({ id, ref: 'stale' })).ok, false);
 assert.equal((await turn2.sdr_approve_draft({ id, ref: saved.lead.draft.ref })).ok, true);
 assert.equal((await turn2.sdr_add_lead({ type: 'owner', name: 'E', source: 's', email: 'e@x.co', owner: 'syifa' })).ok, false);
 assert.match(await sdr.digest(), /waiting for you to send/);
});

test('a failed Gmail call releases the approval and a pending approval blocks a duplicate', async t => {
 fresh(t);
 const { lead } = await sdr.addLead({ type: 'owner', name: 'Fajar', source: 'network', email: 'fajar@example.com' });
 const saved = await sdr.saveDraft(lead.id, DRAFT);
 await assert.rejects(sdr.approveDraft(lead.id, saved.draft.ref, async () => { throw new Error('gmail down'); }), /gmail down/);
 let release; const slow = new Promise(r => { release = r; });
 const first = sdr.approveDraft(lead.id, saved.draft.ref, async () => { await slow; return { id: 'g1' }; });
 await new Promise(r => setTimeout(r, 20));
 await assert.rejects(sdr.approveDraft(lead.id, saved.draft.ref, async () => ({ id: 'g2' })), /already in progress/);
 release(); assert.equal((await first).lead.stage, 'Ready to send');
});
