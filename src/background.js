/* background：仅做安装初始化与消息转发，不参与页面操作 */
'use strict';

importScripts('core.js');

const C = self.BossCore;

const DEFAULT_PROFILE_NOTE = [
  '打开「设置与画像」填写你的求职方向、目标城市、薪资下限，',
  '再回到 BOSS 岗位列表页扫描，打分才有意义。'
].join('');

chrome.runtime.onInstalled.addListener(async (details) => {
  const v = await chrome.storage.local.get(['config', 'profile']);
  const patch = {};
  if (!v.config) patch.config = C.DEFAULTS;
  if (!v.profile) patch.profile = C.PROFILE_TEMPLATE;
  if (!v.records) patch.records = {};
  if (!v.stats) patch.stats = { date: '', applied: 0 };
  if (Object.keys(patch).length) await chrome.storage.local.set(patch);

  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage();
    console.info('[boss-scout] 首次安装。', DEFAULT_PROFILE_NOTE);
  }
});

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || !msg.type) return;

  if (msg.type === 'openOptions') {
    chrome.runtime.openOptionsPage();
    reply({ ok: true });
    return;
  }

  if (msg.type === 'resetStats') {
    chrome.storage.local.set({ stats: { date: '', applied: 0 }, records: {} }, () => reply({ ok: true }));
    return true;
  }
});
