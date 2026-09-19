/**
 * How SOL amounts read to a person.
 *
 * The regression here is worth stating: with a fixed two decimals, half of a
 * 0.05 SOL stake rendered as "0.03", so a slash read "0.03 SOL back, 0.03 SOL
 * forfeited" — six hundredths out of a five-hundredth stake, on the brain
 * screen, in front of judges. Nothing was wrong with the arithmetic; only
 * what it said.
 */
import { solText, LAMPORTS_PER_SOL } from '../src/money';
import { splitSlash } from '../src/agent/guards';
import { section, eq, done } from './harness';

section('the amounts that actually appear');
{
  eq('the default stake', solText(50_000_000), '0.05 SOL');
  eq('half of it — the regression', solText(25_000_000), '0.025 SOL');
  eq('a named 0.1 stake', solText(100_000_000), '0.1 SOL');
  eq('half of that', solText(50_000_000), '0.05 SOL');
  eq('the 1 SOL ceiling', solText(LAMPORTS_PER_SOL), '1 SOL');
  eq('the 0.001 floor', solText(1_000_000), '0.001 SOL');
  eq('nothing', solText(0), '0 SOL');
}

section('a slash always reads as adding up');
{
  // Whatever was staked, the two halves as displayed must still look like
  // the whole. This is the property the fixed-two-decimals version broke.
  const problems: string[] = [];
  const amounts = [1_000_000, 5_000_000, 50_000_000, 100_000_000, 250_000_000, LAMPORTS_PER_SOL];
  for (let odd = 1_000_001; odd < LAMPORTS_PER_SOL; odd = odd * 7 + 3) amounts.push(odd);
  for (const staked of amounts) {
    const { refunded, forfeited } = splitSlash(staked);
    const shown = Number(solText(refunded).replace(' SOL', '')) + Number(solText(forfeited).replace(' SOL', ''));
    const whole = Number(solText(staked).replace(' SOL', ''));
    if (Math.abs(shown - whole) > 1e-9) {
      problems.push(`${solText(staked)}: halves display as ${solText(refunded)} + ${solText(forfeited)}`);
    }
  }
  eq('displayed halves sum to the displayed stake', problems, []);
}

done('money');
