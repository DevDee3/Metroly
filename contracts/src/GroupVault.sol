// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {SettlementLib} from "./libraries/SettlementLib.sol";

/// @title GroupVault
/// @notice A shared pot for a group of people (a trip, an apartment, a night
///         out). Members deposit native currency (MON on Monad) into their
///         own balance inside the vault, log shared expenses against the
///         group, and settle up with the minimum number of onchain transfers
///         — no intermediary, no manual IOU tracking.
/// @dev Deliberately single-contract / multi-group (mapping-keyed) rather than
///      a factory-per-group pattern, to keep per-group creation cheap (no new
///      contract deployment) which matters for a consumer product where the
///      user never sees gas costs.
contract GroupVault is ReentrancyGuard {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 public constant MAX_MEMBERS = 20;

    struct Group {
        string name;
        address creator;
        address[] members;
        uint256 expenseCount;
        bool exists;
    }

    struct ExpenseRecord {
        address payer;
        uint256 amount;
        string description;
        uint256 timestamp;
    }

    uint256 private _nextGroupId = 1;

    mapping(uint256 => Group) private _groups;
    mapping(uint256 => mapping(address => bool)) private _isMember;
    /// @dev Funds a member has deposited into a given group's shared pot,
    ///      available to be pulled during settlement.
    mapping(uint256 => mapping(address => uint256)) public vaultBalance;
    /// @dev Running net position per member: positive = the group owes them,
    ///      negative = they owe the group. Denominated in wei.
    mapping(uint256 => mapping(address => int256)) public netBalance;
    /// @dev Amount a member has been credited by settlement and can withdraw.
    mapping(uint256 => mapping(address => uint256)) public withdrawable;
    mapping(uint256 => ExpenseRecord[]) private _expenses;

    event GroupCreated(uint256 indexed groupId, string name, address indexed creator, address[] members);
    event Deposited(uint256 indexed groupId, address indexed member, uint256 amount, uint256 newVaultBalance);
    event ExpenseAdded(
        uint256 indexed groupId,
        uint256 indexed expenseIndex,
        address indexed payer,
        uint256 amount,
        address[] participants,
        string description
    );
    event Settled(uint256 indexed groupId, uint256 transferCount);
    event Withdrawn(uint256 indexed groupId, address indexed member, uint256 amount);
    event SurplusWithdrawn(uint256 indexed groupId, address indexed member, uint256 amount);

    error GroupDoesNotExist(uint256 groupId);
    error NotAMember(uint256 groupId, address account);
    error EmptyGroupName();
    error InvalidMemberCount();
    error DuplicateMember(address member);
    error ZeroAddressMember();
    error EmptyParticipantList();
    error ZeroAmount();
    error NothingToSettle(uint256 groupId);
    error InsufficientVaultBalance(uint256 groupId, address member, uint256 required, uint256 available);
    error NothingToWithdraw();
    error TransferFailed();

    modifier onlyMember(uint256 groupId) {
        if (!_isMember[groupId][msg.sender]) revert NotAMember(groupId, msg.sender);
        _;
    }

    modifier groupExists(uint256 groupId) {
        if (!_groups[groupId].exists) revert GroupDoesNotExist(groupId);
        _;
    }

    /// @notice Creates a new group. The caller is automatically included as a
    ///         member even if not explicitly listed.
    /// @param name Human-readable group name (e.g. "Lisbon Trip").
    /// @param otherMembers Every other member's address (caller is added automatically).
    function createGroup(string calldata name, address[] calldata otherMembers)
        external
        returns (uint256 groupId)
    {
        if (bytes(name).length == 0) revert EmptyGroupName();
        uint256 otherCount = otherMembers.length;
        if (otherCount + 1 > MAX_MEMBERS) revert InvalidMemberCount();

        groupId = _nextGroupId++;
        Group storage g = _groups[groupId];
        g.name = name;
        g.creator = msg.sender;
        g.exists = true;

        g.members.push(msg.sender);
        _isMember[groupId][msg.sender] = true;

        for (uint256 i = 0; i < otherCount; i++) {
            address m = otherMembers[i];
            if (m == address(0)) revert ZeroAddressMember();
            if (_isMember[groupId][m]) revert DuplicateMember(m);
            _isMember[groupId][m] = true;
            g.members.push(m);
        }

        emit GroupCreated(groupId, name, msg.sender, g.members);
    }

    /// @notice Deposits native currency into the caller's balance within a group's vault.
    function deposit(uint256 groupId) external payable groupExists(groupId) onlyMember(groupId) {
        if (msg.value == 0) revert ZeroAmount();
        vaultBalance[groupId][msg.sender] += msg.value;
        emit Deposited(groupId, msg.sender, msg.value, vaultBalance[groupId][msg.sender]);
    }

    /// @notice Logs a shared expense. `payer` is credited the full amount;
    ///         each address in `participants` (including the payer, if
    ///         listed) is debited an equal share. Any wei remainder from an
    ///         uneven split is assigned to the first `remainder` participants
    ///         in list order, so debits always sum exactly to `amount`.
    /// @dev This does not move any funds — it only updates the internal
    ///      ledger. Funds move only during `settle` + `withdraw`.
    function addExpense(
        uint256 groupId,
        string calldata description,
        uint256 amount,
        address payer,
        address[] calldata participants
    ) external groupExists(groupId) onlyMember(groupId) {
        if (amount == 0) revert ZeroAmount();
        if (!_isMember[groupId][payer]) revert NotAMember(groupId, payer);

        uint256 pCount = participants.length;
        if (pCount == 0) revert EmptyParticipantList();

        // Validate membership + no duplicates (O(n^2), bounded by MAX_MEMBERS).
        for (uint256 i = 0; i < pCount; i++) {
            address p = participants[i];
            if (!_isMember[groupId][p]) revert NotAMember(groupId, p);
            for (uint256 j = i + 1; j < pCount; j++) {
                if (participants[j] == p) revert DuplicateMember(p);
            }
        }

        uint256 share = amount / pCount;
        uint256 remainder = amount % pCount;

        netBalance[groupId][payer] += amount.toInt256();

        for (uint256 i = 0; i < pCount; i++) {
            uint256 debit = share;
            if (i < remainder) debit += 1;
            netBalance[groupId][participants[i]] -= debit.toInt256();
        }

        _expenses[groupId].push(
            ExpenseRecord({payer: payer, amount: amount, description: description, timestamp: block.timestamp})
        );

        emit ExpenseAdded(groupId, _expenses[groupId].length - 1, payer, amount, participants, description);
    }

    /// @notice Computes (without executing) the minimal transfer set that
    ///         would settle the group's current balances. Lets the frontend
    ///         show "who pays whom" before the user confirms.
    function previewSettlement(uint256 groupId)
        external
        view
        groupExists(groupId)
        returns (SettlementLib.Transfer[] memory transfers)
    {
        (address[] memory members, int256[] memory balances) = getNetBalances(groupId);
        transfers = SettlementLib.computeTransfers(members, balances);
    }

    /// @notice Executes settlement: computes the minimal transfer set from
    ///         current net balances and moves funds internally from each
    ///         debtor's vault balance into each creditor's withdrawable
    ///         balance. Reverts naming the first underfunded debtor so the
    ///         frontend can prompt them to deposit more before retrying.
    function settle(uint256 groupId) external nonReentrant groupExists(groupId) onlyMember(groupId) {
        (address[] memory members, int256[] memory balances) = getNetBalances(groupId);
        SettlementLib.Transfer[] memory transfers = SettlementLib.computeTransfers(members, balances);

        if (transfers.length == 0) revert NothingToSettle(groupId);

        for (uint256 i = 0; i < transfers.length; i++) {
            SettlementLib.Transfer memory t = transfers[i];
            uint256 available = vaultBalance[groupId][t.from];
            if (available < t.amount) {
                revert InsufficientVaultBalance(groupId, t.from, t.amount, available);
            }
            vaultBalance[groupId][t.from] = available - t.amount;
            withdrawable[groupId][t.to] += t.amount;
            netBalance[groupId][t.from] += t.amount.toInt256();
            netBalance[groupId][t.to] -= t.amount.toInt256();
        }

        emit Settled(groupId, transfers.length);
    }

    /// @notice Withdraws funds credited to the caller by a settlement.
    function withdraw(uint256 groupId) external nonReentrant groupExists(groupId) {
        uint256 amount = withdrawable[groupId][msg.sender];
        if (amount == 0) revert NothingToWithdraw();

        withdrawable[groupId][msg.sender] = 0;
        emit Withdrawn(groupId, msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /// @notice Withdraws any leftover, never-owed deposit (e.g. a member
    ///         deposited more than their share of expenses ever required).
    ///         Safe to call any time — it only ever returns the caller's own
    ///         un-obligated deposit, never another member's funds, because it
    ///         is capped at vaultBalance minus any outstanding debt the
    ///         caller still owes the group.
    function withdrawSurplus(uint256 groupId, uint256 amount)
        external
        nonReentrant
        groupExists(groupId)
        onlyMember(groupId)
    {
        if (amount == 0) revert ZeroAmount();
        uint256 balance = vaultBalance[groupId][msg.sender];
        if (balance < amount) revert InsufficientVaultBalance(groupId, msg.sender, amount, balance);

        int256 owed = netBalance[groupId][msg.sender];
        // If the member currently owes the group money (negative net
        // balance), they must keep at least that much deposited so future
        // settlement can still be paid out of their vault balance.
        // casting to 'uint256' is safe because owed < 0 is checked on the left
        // of the ternary, and Solidity 0.8's checked arithmetic reverts on the
        // single unrepresentable edge case (owed == type(int256).min) rather
        // than silently wrapping.
        // forge-lint: disable-next-line(unsafe-typecast)
        uint256 mustKeep = owed < 0 ? uint256(-owed) : 0;
        if (balance - amount < mustKeep) {
            revert InsufficientVaultBalance(groupId, msg.sender, amount, balance - mustKeep);
        }

        vaultBalance[groupId][msg.sender] = balance - amount;
        emit SurplusWithdrawn(groupId, msg.sender, amount);

        (bool ok,) = payable(msg.sender).call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    // ---------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------

    function getGroup(uint256 groupId)
        external
        view
        groupExists(groupId)
        returns (string memory name, address creator, address[] memory members, uint256 expenseCount)
    {
        Group storage g = _groups[groupId];
        return (g.name, g.creator, g.members, g.expenseCount == 0 ? _expenses[groupId].length : g.expenseCount);
    }

    function getNetBalances(uint256 groupId)
        public
        view
        groupExists(groupId)
        returns (address[] memory members, int256[] memory balances)
    {
        members = _groups[groupId].members;
        balances = new int256[](members.length);
        for (uint256 i = 0; i < members.length; i++) {
            balances[i] = netBalance[groupId][members[i]];
        }
    }

    function getExpenses(uint256 groupId) external view groupExists(groupId) returns (ExpenseRecord[] memory) {
        return _expenses[groupId];
    }

    function isMember(uint256 groupId, address account) external view returns (bool) {
        return _isMember[groupId][account];
    }
}
