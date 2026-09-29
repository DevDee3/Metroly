import { GROUP_VAULT_ABI } from "./groupVaultAbi";

/// Filled in after running `forge script script/Deploy.s.sol --broadcast`
/// against Monad Testnet. Left as a placeholder until that deploy happens —
/// intentionally not deployed automatically for you, since that step needs
/// your own funded testnet wallet and private key, which no sandbox should
/// ever hold.
export const GROUP_VAULT_ADDRESS = (process.env.NEXT_PUBLIC_GROUP_VAULT_ADDRESS ??
  "0x0000000000000000000000000000000000000000") as `0x${string}`;

export const groupVaultContract = {
  address: GROUP_VAULT_ADDRESS,
  abi: GROUP_VAULT_ABI,
} as const;
