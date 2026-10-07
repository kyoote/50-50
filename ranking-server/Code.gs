const SHEET_ID = '1Mmop5mm1pxdFpSx8bR3AVGXYoW1lxcn8mKmjcV2iER0';
function doGet(e) {
  const page = HtmlService.createTemplateFromFile('Bridge');
  page.channel = /^[0-9a-f-]{36}$/.test(e.parameter.channel || '') ? e.parameter.channel : '';
  return page.evaluate().setXFrameOptionsMode(HtmlService.XFrameOptionsMode.ALLOWALL);
}
function ranking(action, data) {
  if (!data || !['japan', 'world', 'random'].includes(data.mode)) throw new Error('モードが不正です');
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    const book = SpreadsheetApp.openById(SHEET_ID);
    let sheet = book.getSheetByName('Ranking');
    if (!sheet) {
      sheet = book.insertSheet('Ranking');
      sheet.appendRow(['Player hash', 'Mode', 'Name', 'Score', 'Updated']);
    }
    const rows = sheet.getLastRow() > 1 ? sheet.getRange(2, 1, sheet.getLastRow() - 1, 5).getValues() : [];
    if (action === 'save') {
      if (typeof data.name !== 'string' || !data.name.trim() || data.name.length > 20 || /[\x00-\x1f]/.test(data.name)) throw new Error('名前は1〜20文字で入力してください');
      if (!Number.isInteger(data.score) || data.score < 0 || data.score > 5000) throw new Error('スコアが不正です');
      if (typeof data.token !== 'string' || !/^[0-9a-f-]{36}$/.test(data.token)) throw new Error('プレイヤー情報が不正です');
      const hash = Utilities.base64Encode(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, data.token));
      const index = rows.findIndex(row => row[0] === hash && row[1] === data.mode);
      if (index < 0 || data.score > Number(rows[index][3])) {
        const row = [hash, data.mode, JSON.stringify(data.name.trim()), data.score, new Date().toISOString()];
        sheet.getRange(index < 0 ? sheet.getLastRow() + 1 : index + 2, 1, 1, 5).setValues([row]);
      }
      return {ok: true};
    }
    if (action !== 'list') throw new Error('操作が不正です');
    return rows.filter(row => row[1] === data.mode).sort((a, b) => Number(b[3]) - Number(a[3]) || String(a[4]).localeCompare(String(b[4]))).slice(0, 10).map(row => ({name: JSON.parse(row[2]), score: Number(row[3])}));
  } finally {lock.releaseLock();}
}
