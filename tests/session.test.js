import { describe, it, expect, vi } from 'vitest';
import { respondWithFallback } from '../chat-session.js';
const success = reply => ({ startChat: vi.fn(() => ({ sendMessage: async () => ({ response: { text: () => reply } }) })) });
describe('Conversation fallback', () => {
  it('preserves history and reuses the working model on the next request', async () => {
    const bad = { startChat: vi.fn(() => ({ sendMessage: async () => { throw Error('quota'); } })) };
    const good = success('answer');
    const history = [{ role: 'user', parts: [{ text: 'earlier' }] }, { role: 'model', parts: [{ text: 'previous' }] }];
    const session = { history, modelIndex: 0 };
    await respondWithFallback([bad, good], session, 'follow-up');
    expect(good.startChat).toHaveBeenCalledWith({ history });
    expect(session.modelIndex).toBe(1);
    await respondWithFallback([bad, good], session, 'another');
    expect(bad.startChat).toHaveBeenCalledTimes(1);
    expect(session.history).toHaveLength(6);
  });
  it('does not save a failed turn', async () => {
    const session = { history: [], modelIndex: 0 };
    await expect(respondWithFallback([{ startChat() { throw Error('down'); } }], session, 'hello')).rejects.toThrow('down');
    expect(session.history).toEqual([]);
  });
});
