'use strict';
const villaData = require('./villa-data');
const { closeWord } = require('./agent-tools');

// Explicit reference saves only. Never fetch the URL or infer a financial change.
async function tryVillaLink(message, userKey) {
  const text = String(message || '').trim();
  const urls = text.match(/https?:\/\/[^\s<>]+/gi) || [];
  const instruction = text.replace(/https?:\/\/[^\s<>]+/gi, '').trim();
  const save = instruction.match(/^(?:please\s+)?(?:save|remember|simpan|ingat|bewaar|onthoud)\s+(?:(?:this|the|ini|deze|de)\s+)?(?:link|url|tautan)\b\s*(?:(?:ini|this|deze)\s*)?(?:(?:as|for|sebagai|untuk|als|voor)\s*)?(.+)$/i);
  if (!save && (urls.length || !/\b(link|url|tautan)\b/i.test(text))) return null;
  if (save && urls.length !== 1) return 'Please include one link and its villa name, for example: save this link as Sempol financial link https://example.com/';
  const label = save ? save[1].trim() : instruction;
  const words = label.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  try {
    const data = await villaData.getAll();
    const identities = villa => (`${villa.name} ${villa.code || ''}`.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter(word => word !== 'villa');
    let villas = data.villas.filter(villa => identities(villa).some(word => words.includes(word)));
    if (!villas.length) villas = data.villas.filter(villa => identities(villa).some(word => words.some(candidate => closeWord(candidate, word))));
    if (villas.length !== 1) return 'Which villa is this link for? Please include its name with the link.';
    const villa = villas[0];
    if (save) {
      const doc = await villaData.saveReferenceLink({ villaId: villa.id, title: label, url: urls[0], userKey });
      return `Saved in ${villa.name} → Documents: ${doc.title}\n${doc.driveUrl}`;
    }
    const docs = data.documents.filter(doc => doc.villaId === villa.id && /^Saved reference link by /i.test(doc.notes || ''));
    return docs.length ? docs.slice(0, 10).map(doc => `${doc.title}\n${doc.driveUrl}`).join('\n\n') : `${villa.name}: no saved reference links yet.`;
  } catch (error) {
    console.error(`[Zuzu links] ${error.code || 'ERROR'}: ${error.message}`);
    return save ? 'I couldn’t save this link. Please try again; I have no confirmed saved record.' : 'I couldn’t load the saved links. Please try again.';
  }
}

module.exports = { tryVillaLink };
