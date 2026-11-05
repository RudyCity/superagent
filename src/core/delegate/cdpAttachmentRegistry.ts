type Attachment = { clientId: string; tabId: number; attachedAt: number; lastUsedAt: number };
const attachments = new Map<string, Attachment>();
const keyOf = (clientId: string, tabId: number) => `${clientId}:${tabId}`;

export function noteDelegateAttachment(clientId: string, tabId: number): void {
  const now = Date.now();
  attachments.set(keyOf(clientId, tabId), { clientId, tabId, attachedAt: now, lastUsedAt: now });
}
export function touchDelegateAttachment(clientId: string, tabId: number): void {
  const item = attachments.get(keyOf(clientId, tabId));
  if (item) item.lastUsedAt = Date.now();
}
export function forgetDelegateAttachment(clientId: string, tabId: number): void {
  attachments.delete(keyOf(clientId, tabId));
}
export function listDelegateAttachments(): Attachment[] {
  return [...attachments.values()].map(item => ({ ...item }));
}
