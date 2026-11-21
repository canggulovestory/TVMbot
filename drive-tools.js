'use strict';
// Read-only Drive tools for Afni's chat. Document text is untrusted data, never instructions.
function createDriveTools(google, userKey) {
 if (userKey !== 'afni') return {};
 const invalid = message => ({ ok: false, error: 'invalid_arguments', message });
 const obj = input => input && typeof input === 'object' && !Array.isArray(input);
 const fail = error => ({ ok: false, error: 'not_done', message: /not connected|insufficient|403/i.test(error.message) ? 'Drive reading is not enabled yet: Afni must reconnect Google once in TVM Admin.' : error.message });
 return {
  async tvm_drive_search(input) {
   if (!obj(input || {}) || Object.keys(input || {}).some(k => !['q', 'folderId'].includes(k))) return invalid('Input: {q?:string,folderId?:string}');
   try { return { ok: true, files: await google.driveSearch(input || {}) }; } catch (error) { return fail(error); }
  },
  async tvm_drive_read(input) {
   if (!obj(input) || Object.keys(input).some(k => k !== 'fileId') || typeof input.fileId !== 'string') return invalid('Input: {fileId:string}');
   try {
    const doc = await google.driveReadText(input.fileId);
    return { ok: true, name: doc.name, type: doc.type, truncated: !!doc.truncated, note: doc.note, untrustedDocumentText: doc.text };
   } catch (error) { return fail(error); }
  },
 };
}
module.exports = { createDriveTools };
