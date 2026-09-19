// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {GroupVault} from "../src/GroupVault.sol";
import {SettlementLib} from "../src/libraries/SettlementLib.sol";

contract GroupVaultTest is Test {
    GroupVault internal vault;

    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal stranger = makeAddr("stranger");

    function setUp() public {
        vault = new GroupVault();
        vm.deal(alice, 100 ether);
        vm.deal(bob, 100 ether);
        vm.deal(carol, 100 ether);
        vm.deal(stranger, 100 ether);
    }

    function _createTripGroup() internal returns (uint256 groupId) {
        address[] memory others = new address[](2);
        others[0] = bob;
        others[1] = carol;
        vm.prank(alice);
        groupId = vault.createGroup("Lisbon Trip", others);
    }

    // -------------------------------------------------------------------
    // createGroup
    // -------------------------------------------------------------------

    function test_CreateGroup_AddsCreatorAutomatically() public {
        uint256 groupId = _createTripGroup();
        (string memory name, address creator, address[] memory members,) = vault.getGroup(groupId);

        assertEq(name, "Lisbon Trip");
        assertEq(creator, alice);
        assertEq(members.length, 3);
        assertTrue(vault.isMember(groupId, alice));
        assertTrue(vault.isMember(groupId, bob));
        assertTrue(vault.isMember(groupId, carol));
        assertFalse(vault.isMember(groupId, stranger));
    }

    function test_CreateGroup_RevertsOnEmptyName() public {
        address[] memory others = new address[](0);
        vm.expectRevert(GroupVault.EmptyGroupName.selector);
        vault.createGroup("", others);
    }

    function test_CreateGroup_RevertsOnDuplicateMember() public {
        address[] memory others = new address[](2);
        others[0] = bob;
        others[1] = bob;
        vm.expectRevert(abi.encodeWithSelector(GroupVault.DuplicateMember.selector, bob));
        vault.createGroup("Dup", others);
    }

    function test_CreateGroup_RevertsOnZeroAddressMember() public {
        address[] memory others = new address[](1);
        others[0] = address(0);
        vm.expectRevert(GroupVault.ZeroAddressMember.selector);
        vault.createGroup("Zero", others);
    }

    function test_CreateGroup_RevertsOnTooManyMembers() public {
        address[] memory others = new address[](vault.MAX_MEMBERS());
        for (uint256 i = 0; i < others.length; i++) {
            others[i] = address(uint160(0x9000 + i));
        }
        vm.expectRevert(GroupVault.InvalidMemberCount.selector);
        vault.createGroup("TooBig", others);
    }

    // -------------------------------------------------------------------
    // deposit
    // -------------------------------------------------------------------

    function test_Deposit_IncreasesVaultBalance() public {
        uint256 groupId = _createTripGroup();

        vm.prank(alice);
        vault.deposit{value: 1 ether}(groupId);

        assertEq(vault.vaultBalance(groupId, alice), 1 ether);
        assertEq(address(vault).balance, 1 ether);
    }

    function test_Deposit_RevertsForNonMember() public {
        uint256 groupId = _createTripGroup();
        vm.prank(stranger);
        vm.expectRevert(abi.encodeWithSelector(GroupVault.NotAMember.selector, groupId, stranger));
        vault.deposit{value: 1 ether}(groupId);
    }

    function test_Deposit_RevertsOnZeroValue() public {
        uint256 groupId = _createTripGroup();
        vm.prank(alice);
        vm.expectRevert(GroupVault.ZeroAmount.selector);
        vault.deposit{value: 0}(groupId);
    }

    // -------------------------------------------------------------------
    // addExpense
    // -------------------------------------------------------------------

    function test_AddExpense_EqualSplitAmongThree() public {
        uint256 groupId = _createTripGroup();

        address[] memory participants = new address[](3);
        participants[0] = alice;
        participants[1] = bob;
        participants[2] = carol;

        // Alice paid 90 for dinner, split 3 ways -> 30 each.
        vm.prank(alice);
        vault.addExpense(groupId, "Dinner", 90, alice, participants);

        (, int256[] memory balances) = vault.getNetBalances(groupId);
        // members order is [alice, bob, carol] since alice is creator (index 0).
        assertEq(balances[0], 60); // paid 90, owes 30 -> net +60
        assertEq(balances[1], -30);
        assertEq(balances[2], -30);
    }

    function test_AddExpense_RemainderGoesToFirstParticipantsInOrder() public {
        uint256 groupId = _createTripGroup();

        address[] memory participants = new address[](3);
        participants[0] = bob;
        participants[1] = carol;
        participants[2] = alice;

        // 100 / 3 = 33 remainder 1 -> bob and carol pay nothing extra... wait:
        // remainder 1 means the FIRST participant in the list gets +1 wei debit.
        vm.prank(alice);
        vault.addExpense(groupId, "Snacks", 100, alice, participants);

        (address[] memory members, int256[] memory balances) = vault.getNetBalances(groupId);
        // Find bob/carol/alice indices in `members` (creation order: alice, bob, carol).
        int256 bobBal = balances[_indexOf(members, bob)];
        int256 carolBal = balances[_indexOf(members, carol)];
        int256 aliceBal = balances[_indexOf(members, alice)];

        // bob is participants[0] -> debit 34 (33 + 1 remainder)
        // carol is participants[1] -> debit 33
        // alice is participants[2] -> debit 33, but also credited full 100
        assertEq(bobBal, -34);
        assertEq(carolBal, -33);
        assertEq(aliceBal, 100 - 33);

        // Debits must sum exactly to the expense amount (zero-sum ledger).
        assertEq(bobBal + carolBal + (aliceBal - 100), -100);
    }

    function test_AddExpense_RevertsForNonMemberPayer() public {
        uint256 groupId = _createTripGroup();
        address[] memory participants = new address[](1);
        participants[0] = alice;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GroupVault.NotAMember.selector, groupId, stranger));
        vault.addExpense(groupId, "Bad", 10, stranger, participants);
    }

    function test_AddExpense_RevertsOnDuplicateParticipant() public {
        uint256 groupId = _createTripGroup();
        address[] memory participants = new address[](2);
        participants[0] = alice;
        participants[1] = alice;

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GroupVault.DuplicateMember.selector, alice));
        vault.addExpense(groupId, "Dup", 10, alice, participants);
    }

    function test_AddExpense_RevertsOnZeroAmount() public {
        uint256 groupId = _createTripGroup();
        address[] memory participants = new address[](1);
        participants[0] = alice;

        vm.prank(alice);
        vm.expectRevert(GroupVault.ZeroAmount.selector);
        vault.addExpense(groupId, "Free", 0, alice, participants);
    }

    // -------------------------------------------------------------------
    // settle + withdraw (end-to-end)
    // -------------------------------------------------------------------

    function test_FullLifecycle_DepositExpenseSettleWithdraw() public {
        uint256 groupId = _createTripGroup();

        // Everyone deposits enough to cover their eventual debts.
        vm.prank(alice);
        vault.deposit{value: 1 ether}(groupId);
        vm.prank(bob);
        vault.deposit{value: 1 ether}(groupId);
        vm.prank(carol);
        vault.deposit{value: 1 ether}(groupId);

        address[] memory participants = new address[](3);
        participants[0] = alice;
        participants[1] = bob;
        participants[2] = carol;

        // Alice paid 0.9 ether for dinner, split evenly -> 0.3 each.
        vm.prank(alice);
        vault.addExpense(groupId, "Dinner", 0.9 ether, alice, participants);

        // Preview should show bob and carol each owing alice 0.3 ether.
        SettlementLib.Transfer[] memory preview = vault.previewSettlement(groupId);
        assertEq(preview.length, 2);

        vm.prank(bob);
        vault.settle(groupId);

        // After settlement, all net balances should be zero.
        (, int256[] memory balances) = vault.getNetBalances(groupId);
        for (uint256 i = 0; i < balances.length; i++) {
            assertEq(balances[i], 0);
        }

        // Alice should now be able to withdraw 0.6 ether (owed from bob + carol).
        uint256 aliceBalBefore = alice.balance;
        vm.prank(alice);
        vault.withdraw(groupId);
        assertEq(alice.balance, aliceBalBefore + 0.6 ether);

        // Bob and carol's vault balances should be drawn down by 0.3 ether each.
        assertEq(vault.vaultBalance(groupId, bob), 1 ether - 0.3 ether);
        assertEq(vault.vaultBalance(groupId, carol), 1 ether - 0.3 ether);
    }

    function test_Settle_RevertsWithNamedDebtor_WhenUnderfunded() public {
        uint256 groupId = _createTripGroup();

        // Nobody deposits anything.
        address[] memory participants = new address[](2);
        participants[0] = alice;
        participants[1] = bob;

        vm.prank(alice);
        vault.addExpense(groupId, "Coffee", 10 ether, alice, participants);

        // Bob owes alice 5 ether but has deposited nothing.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GroupVault.InsufficientVaultBalance.selector, groupId, bob, 5 ether, 0));
        vault.settle(groupId);
    }

    function test_Settle_RevertsWhenNothingToSettle() public {
        uint256 groupId = _createTripGroup();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(GroupVault.NothingToSettle.selector, groupId));
        vault.settle(groupId);
    }

    function test_Withdraw_RevertsWithNothingToWithdraw() public {
        uint256 groupId = _createTripGroup();
        vm.prank(alice);
        vm.expectRevert(GroupVault.NothingToWithdraw.selector);
        vault.withdraw(groupId);
    }

    function test_Withdraw_CannotDoubleWithdraw() public {
        uint256 groupId = _createTripGroup();
        vm.prank(bob);
        vault.deposit{value: 1 ether}(groupId);

        address[] memory participants = new address[](1);
        participants[0] = bob;
        vm.prank(alice);
        vault.addExpense(groupId, "Solo debt", 0.5 ether, alice, participants);

        vm.prank(alice);
        vault.settle(groupId);

        vm.prank(alice);
        vault.withdraw(groupId);

        vm.prank(alice);
        vm.expectRevert(GroupVault.NothingToWithdraw.selector);
        vault.withdraw(groupId);
    }

    // -------------------------------------------------------------------
    // withdrawSurplus
    // -------------------------------------------------------------------

    function test_WithdrawSurplus_AllowsFullWithdrawalWhenNoDebt() public {
        uint256 groupId = _createTripGroup();
        vm.prank(alice);
        vault.deposit{value: 1 ether}(groupId);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        vault.withdrawSurplus(groupId, 1 ether);
        assertEq(alice.balance, balBefore + 1 ether);
        assertEq(vault.vaultBalance(groupId, alice), 0);
    }

    function test_WithdrawSurplus_RevertsIfWouldDropBelowOutstandingDebt() public {
        uint256 groupId = _createTripGroup();
        vm.prank(bob);
        vault.deposit{value: 1 ether}(groupId);

        address[] memory participants = new address[](1);
        participants[0] = bob;
        vm.prank(alice);
        vault.addExpense(groupId, "Debt", 0.5 ether, alice, participants);

        // Bob owes 0.5 ether but has 1 ether deposited -> can only pull the 0.5 ether surplus.
        vm.prank(bob);
        vm.expectRevert(
            abi.encodeWithSelector(GroupVault.InsufficientVaultBalance.selector, groupId, bob, 0.6 ether, 0.5 ether)
        );
        vault.withdrawSurplus(groupId, 0.6 ether);

        // But withdrawing exactly the surplus succeeds.
        vm.prank(bob);
        vault.withdrawSurplus(groupId, 0.5 ether);
        assertEq(vault.vaultBalance(groupId, bob), 0.5 ether);
    }

    // -------------------------------------------------------------------
    // helpers
    // -------------------------------------------------------------------

    function _indexOf(address[] memory arr, address target) internal pure returns (uint256) {
        for (uint256 i = 0; i < arr.length; i++) {
            if (arr[i] == target) return i;
        }
        revert("not found");
    }
}
