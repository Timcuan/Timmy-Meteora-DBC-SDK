import {PublicKey, SystemProgram, TransactionInstruction} from "@solana/web3.js";
import {buildInstruction} from "./shared.js";

export interface CreateConfigArgs {
  program: any;
  /** Fresh keypair public key — `config` is `init` + signer, not a PDA. */
  config: PublicKey;
  payer: PublicKey;
  feeClaimer: PublicKey;
  /**
   * Receiver of the leftover base supply on a fixed-supply config.
   * Must not be the default pubkey; the program rejects it.
   */
  leftoverReceiver: PublicKey;
  quoteMint: PublicKey;
  configParameters: any;
  transferHookProgram?: PublicKey;
}

export async function createConfig(a: CreateConfigArgs): Promise<TransactionInstruction> {
  const name = a.transferHookProgram ? "createConfigWithTransferHook" : "createConfig";
  return buildInstruction(a.program, name, [a.configParameters], {
    config: a.config,
    feeClaimer: a.feeClaimer,
    leftoverReceiver: a.leftoverReceiver,
    quoteMint: a.quoteMint,
    ...(a.transferHookProgram ? { transferHookProgram: a.transferHookProgram } : {}),
    payer: a.payer,
    systemProgram: SystemProgram.programId,
  });
}

// ── pool ─────────────────────────────────────────────────────────────────────
