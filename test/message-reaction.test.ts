import { expect, it } from 'vitest';
import { messageReaction, withoutMessageReaction } from '../src/shared/message-reaction.js';

it('removes only the leading native reaction envelope, including incremental streaming', () => {
  const token = '\uE200message_reaction\uE202😂\uE201';
  for (let end = 1; end <= token.length; end++) expect(withoutMessageReaction(token.slice(0, end))).toBe('');
  expect(withoutMessageReaction(`${token}\nAn answer.`)).toBe('An answer.');
  expect(withoutMessageReaction(` \n${token}\nAn answer.`)).toBe('An answer.');
  for (const literal of [`Example: ${token}`, `\`${token}\``, `\`\`\`\n${token}\n\`\`\``, '\uE200cite\uE202ref\uE201',
    '\uE200message_reaction\uE202<script>\uE201']) expect(withoutMessageReaction(literal)).toBe(literal);
});

it('accepts bounded emoji sequences and rejects arbitrary content', () => {
  for (const emoji of ['😂', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇩🇪', '1️⃣']) expect(messageReaction(emoji)).toBe(emoji);
  for (const invalid of ['', 'hello', '123', '<img>', '😂❤️', '😂'.repeat(20), '\u202e😂', null, {}]) expect(messageReaction(invalid)).toBeUndefined();
});
