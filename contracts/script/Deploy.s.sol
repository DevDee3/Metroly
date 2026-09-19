// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {GroupVault} from "../src/GroupVault.sol";

/// @notice Deploys GroupVault to Monad Testnet (chain id 10143).
/// Usage:
///   forge script script/Deploy.s.sol --rpc-url monad_testnet --broadcast \
///     --account <your-keystore-account> --verify
contract DeployScript is Script {
    function run() external returns (GroupVault vault) {
        uint256 deployerPrivateKey = vm.envOr("PRIVATE_KEY", uint256(0));

        if (deployerPrivateKey != 0) {
            vm.startBroadcast(deployerPrivateKey);
        } else {
            // Falls back to whatever account is wired up via `cast wallet`
            // / `--account` on the CLI when no PRIVATE_KEY env var is set.
            vm.startBroadcast();
        }

        vault = new GroupVault();

        vm.stopBroadcast();

        console.log("GroupVault deployed to:", address(vault));
        console.log("Chain ID expected: 10143 (Monad Testnet)");
    }
}
