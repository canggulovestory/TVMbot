'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { attachmentMeta } = require('../channels/telegram');

test('Telegram attachment metadata selects the best photo and a named document', () => {
  assert.deepEqual(attachmentMeta({ message_id: 4, photo: [{ file_id: 'small' }, { file_id: 'large' }] }), {
    fileId: 'large', fileName: 'telegram-photo-4.jpg', mimeType: 'image/jpeg', isImage: true,
  });
  assert.deepEqual(attachmentMeta({ message_id: 5, document: { file_id: 'doc', file_name: 'payment.xlsx', mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } }), {
    fileId: 'doc', fileName: 'payment.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', isImage: false,
  });
});
