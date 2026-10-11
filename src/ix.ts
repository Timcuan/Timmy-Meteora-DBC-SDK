/**
 * Instruction layer — barrel.
 *
 * The builders live in `./instructions/*` by domain (config, pool, swap,
 * migration, graduation, fees, operator, partner); shared plumbing in
 * `./instructions/shared.ts`. Import paths are unchanged: everything is still
 * exported from `../ix.js`.
 */
export * from "./instructions/shared.js";
export * from "./instructions/config.js";
export * from "./instructions/pool.js";
export * from "./instructions/swap.js";
export * from "./instructions/migration.js";
export * from "./instructions/graduation.js";
export * from "./instructions/fees.js";
export * from "./instructions/operator.js";
export * from "./instructions/partner.js";
