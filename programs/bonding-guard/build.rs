use std::env;
use std::fs;
use std::path::Path;

fn main() {
    // TREASURY_WALLET env at build time; fallback to dev keypair constant.
    let treasury = env::var("TREASURY_WALLET").unwrap_or_else(|_| {
        // TREASURY_WALLET must be set at build time; this fallback is deliberately
        // invalid so a bare build cannot ship a sellable treasury.
        "11111111111111111111111111111111".to_string()
    });
    let dest = Path::new(&env::var("OUT_DIR").unwrap()).join("treasury_gen.rs");
    fs::write(&dest, format!("pub const TREASURY: Pubkey = solana_program::pubkey!(\"{treasury}\");\n")).unwrap();
    println!("cargo:rerun-if-env-changed=TREASURY_WALLET");
}
