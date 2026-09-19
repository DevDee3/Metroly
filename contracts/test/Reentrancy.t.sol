// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GroupVault} from "../src/GroupVault.sol";

/// @dev Malicious "member" that tries to drain the vault by calling
///      `withdraw` again from inside its `receive()` — i.e. before the first
///      call has finished zeroing out its `withdrawable` balance in storage.
contract ReentrantAttacker {
    GroupVault public vault;
    uint256 public groupId;
    uint256 public reentryAttempts;

    constructor(GroupVault _vault) {
        vault = _vault;
    }

    function setGroupId(uint256 _groupId) external {
        groupId = _groupId;
    }

    function attack() external {
        vault.withdraw(groupId);
    }

    bool public reentrantCallSucceeded;

    receive() external payable {
        if (reentryAttempts < 3) {
            reentryAttempts++;
            // Attempt to withdraw again mid-transfer, via a low-level call so
            // a revert here does NOT bubble up and fail the legitimate outer
            // withdraw (a real attacker contract would do exactly this).
            // This should fail because (a) ReentrancyGuard blocks re-entry
            // into withdraw, and (b) withdrawable[...] was already zeroed
            // before this call happened (checks-effects-interactions), so
            // even without the guard there'd be nothing left to withdraw.
            (bool success,) = address(vault).call(abi.encodeWithSignature("withdraw(uint256)", groupId));
            if (success) reentrantCallSucceeded = true;
        }
    }
}

contract ReentrancyTest is Test {
    GroupVault internal vault;
    ReentrantAttacker internal attacker;

    address internal alice = makeAddr("alice");

    function setUp() public {
        vault = new GroupVault();
        attacker = new ReentrantAttacker(vault);
        vm.deal(alice, 10 ether);
        vm.deal(address(attacker), 0);
    }

    function test_Withdraw_CannotBeReentered() public {
        address[] memory others = new address[](1);
        others[0] = address(attacker);

        vm.prank(alice);
        uint256 groupId = vault.createGroup("Attack Group", others);
        attacker.setGroupId(groupId);

        // Alice deposits and pays an expense that credits the attacker.
        vm.prank(alice);
        vault.deposit{value: 2 ether}(groupId);

        address[] memory participants = new address[](1);
        participants[0] = alice;
        vm.prank(alice);
        // Alice "pays" 1 ether that only the attacker benefits from, by
        // crediting the attacker directly via a 1-participant expense where
        // the attacker is the payer and alice is the sole participant.
        vm.stopPrank();
        vm.prank(address(attacker));
        vault.addExpense(groupId, "Attacker credit", 1 ether, address(attacker), participants);

        vm.prank(alice);
        vault.settle(groupId);

        assertEq(vault.withdrawable(groupId, address(attacker)), 1 ether);

        uint256 vaultBalBefore = address(vault).balance;

        // The outer withdraw() call succeeds and pays out exactly 1 ether
        // once. The reentrant calls from receive() must revert silently
        // (caught by the try in the attacker) — the guard prevents the
        // attacker from draining more than they're owed.
        attacker.attack();

        assertEq(address(attacker).balance, 1 ether, "attacker must receive exactly their owed amount, once");
        assertEq(address(vault).balance, vaultBalBefore - 1 ether, "vault must lose exactly the owed amount");
        assertEq(vault.withdrawable(groupId, address(attacker)), 0);
        assertGt(attacker.reentryAttempts(), 0, "sanity: the attack must have actually attempted reentry");
        assertFalse(attacker.reentrantCallSucceeded(), "reentrant withdraw() call must never succeed");
    }
}
