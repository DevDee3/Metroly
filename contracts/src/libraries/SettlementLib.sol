// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

/// @title SettlementLib
/// @notice Pure debt-simplification (min cash flow) algorithm. Given a set of
///         members and their net balances (positive = owed money, negative =
///         owes money), computes the minimal set of direct transfers that
///         zeroes every balance out.
/// @dev Greedy O(n^2) max-creditor / max-debtor matching. This is the classic
///      "min cash flow" approach: it does not always produce the theoretical
///      minimum number of transactions (that's NP-hard in general), but it is
///      deterministic, cheap, and always terminates in at most (n - 1)
///      transfers for n participants — which is what matters for gas bounds
///      onchain.
library SettlementLib {
    using SafeCast for uint256;
    using SafeCast for int256;

    struct Transfer {
        address from;
        address to;
        uint256 amount;
    }

    error UnbalancedLedger(int256 sum);
    error LengthMismatch(uint256 membersLength, uint256 balancesLength);

    /// @notice Computes the minimal transfer set for a group of net balances.
    /// @param members Addresses corresponding 1:1 with `balances`.
    /// @param balances Net balance per member. Must sum to exactly zero.
    /// @return transfers The list of (from, to, amount) transfers required to
    ///         settle every balance to zero.
    function computeTransfers(address[] memory members, int256[] memory balances)
        internal
        pure
        returns (Transfer[] memory transfers)
    {
        uint256 n = members.length;
        if (n != balances.length) revert LengthMismatch(n, balances.length);

        // Work on a copy so callers can reuse their original array afterwards.
        int256[] memory working = new int256[](n);
        int256 sum = 0;
        for (uint256 i = 0; i < n; i++) {
            working[i] = balances[i];
            sum += balances[i];
        }
        if (sum != 0) revert UnbalancedLedger(sum);

        // Upper bound on transfers is n - 1 (one per "settled out" party).
        Transfer[] memory buf = new Transfer[](n == 0 ? 0 : n - 1);
        uint256 count = 0;

        for (uint256 step = 0; step < n; step++) {
            // Find the largest creditor (max positive) and largest debtor
            // (min negative, i.e. largest magnitude debt).
            uint256 maxCreditorIdx = type(uint256).max;
            uint256 maxDebtorIdx = type(uint256).max;
            int256 maxCredit = 0;
            int256 maxDebt = 0; // most negative

            for (uint256 i = 0; i < n; i++) {
                if (working[i] > maxCredit) {
                    maxCredit = working[i];
                    maxCreditorIdx = i;
                }
                if (working[i] < maxDebt) {
                    maxDebt = working[i];
                    maxDebtorIdx = i;
                }
            }

            // Nothing left to settle.
            if (maxCreditorIdx == type(uint256).max || maxDebtorIdx == type(uint256).max) {
                break;
            }
            if (maxCredit == 0 && maxDebt == 0) break;

            // Safe: maxCredit is always >= 0 (only ever assigned from a
            // `working[i] > 0` comparison) and -maxDebt is always >= 0 for the
            // symmetric reason, so the smaller of the two is never negative.
            // forge-lint: disable-next-line(unsafe-typecast)
            uint256 amount = uint256(maxCredit < -maxDebt ? maxCredit : -maxDebt);
            if (amount == 0) break;

            working[maxCreditorIdx] -= amount.toInt256();
            working[maxDebtorIdx] += amount.toInt256();

            buf[count] = Transfer({from: members[maxDebtorIdx], to: members[maxCreditorIdx], amount: amount});
            count++;
        }

        transfers = new Transfer[](count);
        for (uint256 i = 0; i < count; i++) {
            transfers[i] = buf[i];
        }
    }
}
