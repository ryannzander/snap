/**
 * Devnet wallets and plain SOL transfers.
 *
 * This is DESIGN.md's fallback path — "a backend-held wallet doing plain
 * transfers" — built first on purpose. The Anchor program (BACKEND_TASKS step
 * 6, Codex's) can replace the three move* calls behind this same surface, but
 * until it exists the demo still shows real devnet transactions.
 *
 * Custodial, and we say so to the Solana judges: the backend holds every key.
 */

import {
  appendTransactionMessageInstruction,
  createKeyPairFromPrivateKeyBytes,
  createSignerFromKeyPair,
  createSolanaRpc,
  createTransactionMessage,
  getAddressFromPublicKey,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  lamports,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
} from '@solana/kit';
import { getTransferSolInstruction } from '@solana-program/system';

/** A Solana signature is only useful to a judge as an explorer link. */
export function explorerUrl(signature: string): string {
  return `https://explorer.solana.com/tx/${signature}?cluster=devnet`;
}

/**
 * All that is persisted per user: 32 bytes. The keypair is derived on demand,
 * so nothing extractable sits in storage beyond the seed itself.
 */
export function newSeed(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(32)));
}

export async function walletFromSeed(seedBase64: string) {
  const bytes = fromBase64(seedBase64);
  if (bytes.length !== 32) throw new Error('wallet seed must be 32 bytes');
  const keyPair = await createKeyPairFromPrivateKeyBytes(bytes, true);
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  const signer = await createSignerFromKeyPair(keyPair);
  return { address, signer };
}

export type Rpc = ReturnType<typeof createSolanaRpc>;

export function rpcFor(url: string): Rpc {
  return createSolanaRpc(url);
}

export async function getBalanceLamports(rpc: Rpc, address: Address): Promise<number> {
  const { value } = await rpc.getBalance(address).send();
  return Number(value);
}

/**
 * Signs and sends a transfer, then polls for confirmation.
 *
 * Deliberately not sendAndConfirmTransactionFactory: that confirms over a
 * websocket subscription, and a short-lived HTTP poll is far less to go wrong
 * inside a Worker than holding a socket open.
 */
export async function transferSol(
  rpc: Rpc,
  from: { signer: Awaited<ReturnType<typeof walletFromSeed>>['signer'] },
  to: Address,
  amountLamports: number,
): Promise<string> {
  const { value: blockhash } = await rpc.getLatestBlockhash({ commitment: 'confirmed' }).send();

  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(from.signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
    (m) =>
      appendTransactionMessageInstruction(
        getTransferSolInstruction({
          source: from.signer,
          destination: to,
          amount: lamports(BigInt(amountLamports)),
        }),
        m,
      ),
  );

  const signed = await signTransactionMessageWithSigners(message);
  const signature = getSignatureFromTransaction(signed);

  await rpc
    .sendTransaction(getBase64EncodedWireTransaction(signed), {
      encoding: 'base64',
      preflightCommitment: 'confirmed',
    })
    .send();

  await confirm(rpc, signature);
  return signature;
}

/** Polls until the cluster has confirmed it, or gives up. */
async function confirm(rpc: Rpc, signature: string, attempts = 30): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const { value } = await rpc
      .getSignatureStatuses([signature as Parameters<typeof rpc.getSignatureStatuses>[0][number]])
      .send();
    const status = value[0];
    if (status?.err) throw new Error(`transaction failed: ${JSON.stringify(status.err)}`);
    if (status?.confirmationStatus === 'confirmed' || status?.confirmationStatus === 'finalized') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  // Not fatal: it may still land. The caller keeps the signature either way.
  throw new Error('transaction not confirmed in time');
}

// --- base64 for a Uint8Array, which Workers has no helper for ---------------

export function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
