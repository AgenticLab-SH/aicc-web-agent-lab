export const GPT_GROUP_NAME = 'GPT';
export const MONITOR_TARGET_SET_ID = 'chatgpt-chrome-tab-group-gpt-7-v5';
export const EXPECTED_GPT_GROUP_TABS = Object.freeze([
  { title: '해커톤 분석 정리', conversationId: '6ab08bff-f2ac-83e8-98e7-6c0a8c8b1669' },
  { title: 'skct 총괄', conversationId: '6ab5201a-9c74-83e8-9b77-b6b626284a9e' },
  { title: '웹쫀쿠 총괄', conversationId: '6ab5619b-ae68-83e9-b167-9a91554d8c15' },
  { title: '개발자산 프로젝트 포폴 관리자', conversationId: '6ab63240-5acc-83e8-963d-2842f7da877e' },
  { title: '자동매매 총괄', conversationId: '6ab55a1d-f2dc-83ee-a791-1a8cfb6262f8' },
  { title: '제미나이 전환 검토', conversationId: '6ab55c56-5600-83ee-a824-5a1f0c8ac584' },
  { title: '채용지원', conversationId: '6ab6a7c2-3e7c-83e9-8690-62f9365e76e8' }
].map(item => Object.freeze(item)));
export const EXPECTED_GPT_GROUP_TAB_COUNT = EXPECTED_GPT_GROUP_TABS.length;

const CONVERSATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const EXPECTED_BY_ID = new Map(EXPECTED_GPT_GROUP_TABS.map(item => [item.conversationId, item]));

export function normalizeGptGroupIdentity(value) {
  if (!value || typeof value !== 'object' || value.groupName !== GPT_GROUP_NAME
    || !Array.isArray(value.groupTabs) || value.groupTabs.length !== EXPECTED_GPT_GROUP_TAB_COUNT
    || typeof value.anchorTabConversationId !== 'string' || !CONVERSATION_ID.test(value.anchorTabConversationId)) {
    throw new Error('the Chrome GPT tab group must show the exact seven designated ChatGPT tabs and an exact anchor');
  }

  const seenIds = new Set();
  value.groupTabs.forEach(tab => {
    const conversationId = tab?.conversationId;
    if (typeof conversationId !== 'string' || !CONVERSATION_ID.test(conversationId)) {
      throw new Error('every GPT group tab must have a ChatGPT conversation URL');
    }
    const normalizedId = conversationId.toLowerCase();
    const expected = EXPECTED_BY_ID.get(normalizedId);
    if (!expected || seenIds.has(normalizedId)) {
      throw new Error('the GPT tab group must contain the exact seven designated conversation IDs once each');
    }
    const visibleTitle = tab?.title;
    const titleMatches = !visibleTitle || visibleTitle === 'ChatGPT' || visibleTitle === expected.title
      || expected.title.startsWith(visibleTitle.replace(/[.…]+$/, ''));
    if (!titleMatches) throw new Error('a GPT group tab title does not match its designated conversation ID');
    seenIds.add(normalizedId);
  });

  const anchorTabConversationId = value.anchorTabConversationId.toLowerCase();
  if (seenIds.size !== EXPECTED_GPT_GROUP_TAB_COUNT || !seenIds.has(anchorTabConversationId)) {
    throw new Error('the seven GPT group tabs or current anchor do not match the designated set');
  }

  return {
    targetSetId: MONITOR_TARGET_SET_ID,
    groupName: GPT_GROUP_NAME,
    anchorTabConversationId,
    tabs: EXPECTED_GPT_GROUP_TABS.map((expected, index) => ({
      tabIndex: index + 1,
      title: expected.title,
      conversationId: expected.conversationId
    }))
  };
}
