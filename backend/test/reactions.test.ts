/**
 * Tapbacks, in and out.
 *
 * Two things here are load-bearing rather than cosmetic. A 👍 on a standing
 * offer takes the user's money, so what counts as agreement has to be exactly
 * the two reactions that cannot be read any other way — 😂 is not a yes.
 * And a removed tapback carries the same message id as the one that added it,
 * so without a distinct dedupe id every removal looks like a duplicate
 * delivery and is dropped.
 */
import { normalizeInbound } from '../src/channels/linq';
import {
  describeReaction,
  isAffirmative,
  isNegative,
  reactionEmoji,
  toReaction,
} from '../src/reactions';
import { asksHowItWorks, onboardingTexts } from '../src/onboarding';
import { section, eq, isTrue, isFalse, done } from './harness';

section('placing whatever the channel called it');
{
  eq('the emoji itself', toReaction('👍'), 'like');
  eq('a skin-toned thumbs up', toReaction('👍🏽'), 'like');
  eq("linq's name for it", toReaction('liked'), 'like');
  eq('the heart', toReaction('❤️'), 'love');
  eq('a heart with no variation selector', toReaction('❤'), 'love');
  eq('laughing', toReaction('😂'), 'laugh');
  eq('rolling on the floor is still laughing', toReaction('🤣'), 'laugh');
  eq('the double bang', toReaction('‼️'), 'emphasize');
  eq('a question mark', toReaction('❓'), 'question');
  eq('case does not matter', toReaction('LIKE'), 'like');
  eq('something outside the six', toReaction('🍕'), null);
  eq('nothing at all', toReaction(''), null);
  eq('not even a string', toReaction(7), null);
}

section('which tapbacks move money');
{
  isTrue('👍 is a yes', isAffirmative('like'));
  isTrue('❤️ is a yes', isAffirmative('love'));
  // People laugh at an offer and then never train. This is the whole reason
  // the affirmative set is two and not four.
  isFalse('😂 is not a yes', isAffirmative('laugh'));
  isFalse('‼️ is not a yes', isAffirmative('emphasize'));
  isFalse('❓ is not a yes', isAffirmative('question'));
  isFalse('👎 is certainly not a yes', isAffirmative('dislike'));
  isTrue('👎 is a no', isNegative('dislike'));
  isFalse('and a no is not just "anything that is not a yes"', isNegative('question'));
}

section('how a reaction reads in the trace');
{
  eq('on a message we know', describeReaction('👍', 'bro lock in'), '👍 on: bro lock in');
  eq('on one we do not', describeReaction('😂', null), '😂');
  eq('taken back', describeReaction('👍', 'bro lock in', true), '👍 took back on: bro lock in');
  eq('every slot has an emoji', Object.values(
    (['love', 'like', 'dislike', 'laugh', 'emphasize', 'question'] as const).map(reactionEmoji),
  ).filter((emoji) => emoji.length > 0).length, 6);
}

section('pulling a tapback out of a webhook delivery');
{
  const asEvent = normalizeInbound({
    event_type: 'message.reaction',
    event_id: 'evt_r1',
    data: {
      direction: 'inbound',
      id: 'msg_9',
      sender_handle: { handle: '+15555550123' },
      value: 'liked',
      target_message_id: 'msg_8',
    },
  });
  eq('its own event type', asEvent?.reaction, {
    name: 'like',
    emoji: '👍',
    targetMessageId: 'msg_8',
    removed: false,
  });

  const asPart = normalizeInbound({
    event_type: 'message.received',
    event_id: 'evt_r2',
    data: {
      direction: 'inbound',
      id: 'msg_10',
      sender_handle: { handle: '+15555550123' },
      parts: [{ type: 'tapback', value: '😂', message_id: 'msg_8' }],
    },
  });
  eq('or a part inside an ordinary delivery', asPart?.reaction?.name, 'laugh');
  eq('the message id rides along so snap can react back', asPart?.messageId, 'msg_10');

  const unknown = normalizeInbound({
    event_type: 'message.reaction',
    event_id: 'evt_r3',
    data: { direction: 'inbound', sender_handle: { handle: '+1' }, emoji: '🍕' },
  });
  eq('an emoji outside the six still arrives, unnamed', unknown?.reaction, {
    name: null,
    emoji: '🍕',
    targetMessageId: null,
    removed: false,
  });

  const plain = normalizeInbound({
    event_type: 'message.received',
    event_id: 'evt_m1',
    data: { direction: 'inbound', sender_handle: { handle: '+1' }, parts: [{ type: 'text', value: 'gym at 7' }] },
  });
  eq('an ordinary message carries no reaction', plain?.reaction, undefined);

  const removed = normalizeInbound({
    event_type: 'reaction.removed',
    data: { direction: 'inbound', id: 'msg_11', sender_handle: { handle: '+1' }, value: '👍' },
  });
  isTrue('a removal says so', removed?.reaction?.removed === true);
  const added = normalizeInbound({
    event_type: 'message.reaction',
    data: { direction: 'inbound', id: 'msg_11', sender_handle: { handle: '+1' }, value: '👍' },
  });
  isTrue(
    'and dedupes apart from the tapback it removed',
    Boolean(removed?.eventId && added?.eventId && removed.eventId !== added.eventId),
  );

  eq('an outbound reaction is not ours to handle', normalizeInbound({
    event_type: 'message.reaction',
    data: { direction: 'outbound', sender_handle: { handle: '+1' }, value: '👍' },
  }), null);
}

section('the first thing anyone reads');
{
  const texts = onboardingTexts('Ryan', 4);
  const all = texts.join('\n').toLowerCase();
  isTrue('it says his name', all.includes('ryan'));
  isTrue('what to text him', all.includes('gym at 7'));
  isTrue('that the money is theirs', all.includes('your money'));
  isTrue('that they get it back', all.includes('all of it back'));
  isTrue('and that skipping costs', all.includes('gone'));
  // The one mechanic that moves money without a word typed. Never shipping
  // this unexplained is the condition on having it at all.
  isTrue('that 👍 is how you agree', all.includes('👍'));
  isTrue('that the watch is the referee', all.includes('watch'));
  isTrue('and where the wallet is', all.includes('app'));
  isTrue('every text is a text, not a paragraph', texts.every((t) => t.length <= 120));
  isTrue('it ends by asking for a plan', texts.at(-1)!.includes('what are we doing today'));

  const again = onboardingTexts('Ryan', 4, true);
  isFalse('asked for on purpose, it does not greet you again', again.join(' ').includes('yo ryan'));
  isFalse('and does not re-ask the opening question', again.join(' ').includes('what are we doing today'));
  isTrue('but still explains the money', again.join(' ').includes('all of it back'));

  const noName = onboardingTexts(null, null).join(' ');
  isTrue('a missing name does not leave a hole', !noName.includes('undefined') && !noName.includes('null'));
}

section('what counts as asking how it works');
{
  isTrue('help', asksHowItWorks('help'));
  isTrue('HELP with a shout', asksHowItWorks('HELP!'));
  isTrue('how does this work?', asksHowItWorks('how does this work?'));
  isTrue('how do u work', asksHowItWorks('how do u work'));
  isTrue('what do you do', asksHowItWorks('what do you do'));
  // These are real questions for the agent to answer in context. Replaying
  // onboarding at them would be a bot talking over a conversation.
  isFalse('how do i get my money back', asksHowItWorks('how do i get my money back'));
  isFalse('a plan is not a question', asksHowItWorks('gym at 7'));
  isFalse('help me pick a split', asksHowItWorks('help me pick a split'));
}

done('reactions and the explainer');
