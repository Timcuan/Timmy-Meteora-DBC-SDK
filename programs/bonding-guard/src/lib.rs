//! bonding-guard — a Token-2022 transfer hook for Meteora DBC launches.
//!
//! While a launch is trading on the bonding curve, the base token is one-way:
//! anyone may buy from the vault, but only the treasury wallet may move tokens
//! off-curve (sell or transfer). DBC revokes the hook automatically on
//! graduation, after which the token is a normal, freely transferable asset.

use solana_program::{
    account_info::AccountInfo, entrypoint, entrypoint::ProgramResult, msg,
    program_error::ProgramError, pubkey::Pubkey,
};

/// DBC `pool_authority` — the PDA that owns the base/quote vaults and signs
/// the flash-rent borrow. Identical for every config on the DBC program.
pub const POOL_AUTHORITY: Pubkey =
    solana_program::pubkey!("FhVo3mqL8PW5pH5U2CN4XE33DokiyZnUwuGpH2hmHLuM");

// The wallet allowed to sell the base token while the curve is live.
// Baked at compile time (build.rs) from the TREASURY_WALLET env var:
//   TREASURY_WALLET=<pubkey> ./build.sh
include!(concat!(env!("OUT_DIR"), "/treasury_gen.rs"));

// Token-2022 invokes a transfer hook with accounts in this fixed order:
//   [0] source token account, [1] mint, [2] destination token account,
//   [3] authority/owner delegate, then any extra metas.
const SOURCE: usize = 0;

entrypoint!(process_instruction);

fn process_instruction(
    _program_id: &Pubkey,
    accounts: &[AccountInfo],
    _instruction_data: &[u8],
) -> ProgramResult {
    if accounts.len() < 4 {
        return Err(ProgramError::NotEnoughAccountKeys.into());
    }

    // Read the token account's `owner` (transfer authority) field at offset 32 —
    // `AccountInfo.owner` is the owning *program* (always Token-2022), useless here.
    let token_owner = |ai: &AccountInfo| -> Result<Pubkey, ProgramError> {
        let data = ai.try_borrow_data().map_err(|_| ProgramError::AccountBorrowFailed)?;
        if data.len() < 64 {
            return Err(ProgramError::InvalidAccountData.into());
        }
        Ok(Pubkey::new_from_array(data[32..64].try_into().unwrap()))
    };

    let source_owner = token_owner(&accounts[SOURCE])?;

    // Buy from the vault: always allowed (the curve only ever absorbs quote).
    if source_owner == POOL_AUTHORITY {
        return Ok(());
    }
    // Treasury: may sell into the vault or move its own tokens freely.
    if source_owner == TREASURY {
        return Ok(());
    }
    // Everyone else: no sell, no transfer — locked until graduation revokes the hook.
    msg!("bonding-guard: transfer is locked while the curve is live");
    Err(ProgramError::Custom(1).into())
}