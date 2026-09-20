/**
 * How SOL amounts read to a person.
 *
 * The regression is worth stating even though the feature that exposed it was
 * dropped: with a fixed two decimals, half of a 0.05 SOL stake rendered as
 * "0.03", so dividing a stake displayed as six hundredths out of five. The
 * arithmetic was right; only what it said was wrong.
 */
import { solText, LAMPORTS_PER_SOL } from '../src/money';
import { section, eq, done } from './harness';

section('the amounts that actually appear');
{
  eq('the default stake', solText(50_000_000), '0.05 SOL');
  eq('half of it — the regression', solText(25_000_000), '0.025 SOL');
  eq('and half of the minimum stake', solText(500_000), '0.0005 SOL');
  eq('a named 0.1 stake', solText(100_000_000), '0.1 SOL');
  eq('half of that', solText(50_000_000), '0.05 SOL');
  eq('the 1 SOL ceiling', solText(LAMPORTS_PER_SOL), '1 SOL');
  eq('the 0.001 floor', solText(1_000_000), '0.001 SOL');
  eq('nothing', solText(0), '0 SOL');
}

section('halves and thirds still read as adding up');
{
  // Kept from a mechanic that was proposed and then dropped, because the bug
  // it exposed has nothing to do with that mechanic: any amount Snap divides
  // and shows must still look like the whole. Two decimals rendered half of
  // a 0.05 stake as 0.03; three decimals moved the identical bug down to the
  // 0.001 minimum, whose halves both round back up to 0.001.
  const value = (text: string) => Number(text.replace(' SOL', ''));
  const problems: string[] = [];
  const amounts = [1_000_000, 5_000_000, 50_000_000, 100_000_000, 250_000_000, LAMPORTS_PER_SOL];
  for (let odd = 1_000_001; odd < LAMPORTS_PER_SOL; odd = odd * 7 + 3) amounts.push(odd);

  for (const whole of amounts) {
    const half = Math.floor(whole / 2);
    if (Math.abs(value(solText(half)) + value(solText(whole - half)) - value(solText(whole))) > 1e-9) {
      problems.push(`${solText(whole)}: halves display as ${solText(half)} + ${solText(whole - half)}`);
    }
  }
  eq('displayed parts sum to the displayed whole', problems, []);
}

done('money');
