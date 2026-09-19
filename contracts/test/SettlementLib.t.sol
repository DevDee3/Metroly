// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {SettlementLib} from "../src/libraries/SettlementLib.sol";

/// @dev `computeTransfers` is `internal pure`, so Solidity inlines calls to it
///      instead of issuing a real CALL. `vm.expectRevert` only intercepts
///      reverts that cross an external call boundary, so revert-path tests
///      have to go through this thin external wrapper instead of calling the
///      library directly.
contract SettlementLibHarness {
    function computeTransfers(address[] memory members, int256[] memory balances)
        external
        pure
        returns (SettlementLib.Transfer[] memory)
    {
        return SettlementLib.computeTransfers(members, balances);
    }
}

contract SettlementLibTest is Test {
    SettlementLibHarness internal harness;

    function setUp() public {
        harness = new SettlementLibHarness();
    }

    function _addrs(uint256 n) internal pure returns (address[] memory a) {
        a = new address[](n);
        for (uint256 i = 0; i < n; i++) {
            a[i] = address(uint160(0x1000 + i));
        }
    }

    function test_TwoParty_SimpleDebt() public pure {
        address[] memory members = _addrs(2);
        int256[] memory balances = new int256[](2);
        balances[0] = 100; // owed 100
        balances[1] = -100; // owes 100

        SettlementLib.Transfer[] memory t = SettlementLib.computeTransfers(members, balances);

        assertEq(t.length, 1);
        assertEq(t[0].from, members[1]);
        assertEq(t[0].to, members[0]);
        assertEq(t[0].amount, 100);
    }

    function test_AllZero_NoTransfers() public pure {
        address[] memory members = _addrs(4);
        int256[] memory balances = new int256[](4); // all zero

        SettlementLib.Transfer[] memory t = SettlementLib.computeTransfers(members, balances);
        assertEq(t.length, 0);
    }

    function test_ThreeParty_ClassicSplit() public pure {
        // A paid 90 for a dinner split 3 ways (30 each). A is owed 60, B and C owe 30 each.
        address[] memory members = _addrs(3);
        int256[] memory balances = new int256[](3);
        balances[0] = 60;
        balances[1] = -30;
        balances[2] = -30;

        SettlementLib.Transfer[] memory t = SettlementLib.computeTransfers(members, balances);

        // Greedy min-cash-flow should produce exactly 2 transfers here (n - 1).
        assertEq(t.length, 2);
        uint256 totalToA = 0;
        for (uint256 i = 0; i < t.length; i++) {
            assertEq(t[i].to, members[0]);
            totalToA += t[i].amount;
        }
        assertEq(totalToA, 60);
    }

    function test_RevertsOnUnbalancedLedger() public {
        address[] memory members = _addrs(2);
        int256[] memory balances = new int256[](2);
        balances[0] = 100;
        balances[1] = -50; // doesn't sum to zero

        vm.expectRevert(abi.encodeWithSelector(SettlementLib.UnbalancedLedger.selector, int256(50)));
        harness.computeTransfers(members, balances);
    }

    function test_RevertsOnLengthMismatch() public {
        address[] memory members = _addrs(2);
        int256[] memory balances = new int256[](3);

        vm.expectRevert(abi.encodeWithSelector(SettlementLib.LengthMismatch.selector, uint256(2), uint256(3)));
        harness.computeTransfers(members, balances);
    }

    /// @dev Fuzz invariant: for any balanced ledger, the resulting transfers,
    ///      when replayed against the original balances, must zero every
    ///      balance out exactly — and never use more than n - 1 transfers.
    function testFuzz_AnyBalancedLedger_SettlesExactlyToZero(int128[10] memory raw) public pure {
        uint256 n = 10;
        address[] memory members = _addrs(n);
        int256[] memory balances = new int256[](n);

        int256 sum = 0;
        for (uint256 i = 0; i < n - 1; i++) {
            // Bound magnitude well below int256 limits to avoid overflow noise.
            int256 b = int256(raw[i]);
            balances[i] = b;
            sum += b;
        }
        // Force the ledger to balance by assigning the last member the exact
        // negation of everyone else's sum.
        balances[n - 1] = -sum;

        SettlementLib.Transfer[] memory transfers = SettlementLib.computeTransfers(members, balances);

        assertLe(transfers.length, n - 1);

        // Replay transfers against a working copy and assert every balance lands at zero.
        int256[] memory working = new int256[](n);
        for (uint256 i = 0; i < n; i++) {
            working[i] = balances[i];
        }

        for (uint256 i = 0; i < transfers.length; i++) {
            SettlementLib.Transfer memory t = transfers[i];
            uint256 fromIdx = _indexOf(members, t.from);
            uint256 toIdx = _indexOf(members, t.to);
            working[fromIdx] += int256(t.amount);
            working[toIdx] -= int256(t.amount);
            // Every individual transfer must move a strictly positive amount.
            assertGt(t.amount, 0);
        }

        for (uint256 i = 0; i < n; i++) {
            assertEq(working[i], 0, "balance did not settle to zero");
        }
    }

    function _indexOf(address[] memory arr, address target) internal pure returns (uint256) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == target) return i;
        }
        revert("not found");
    }
}
