"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { formatEther, parseEther } from "viem";
import { useAccount, useBalance, useChainId, usePublicClient, useReadContract, useSwitchChain, useWriteContract } from "wagmi";
import { ConnectButton } from "@/components/ConnectButton";
import { groupVaultContract, GROUP_VAULT_ADDRESS } from "@/lib/contract";
import { useKnownGroups } from "@/lib/useKnownGroups";
import { monadTestnet } from "@/lib/chains";

/// Metro-line palette: each member gets a stable color by position, the way
/// a transit map assigns a line color to a route. Used only as an identity
/// marker next to each member's name — the one deliberately bold visual
/// element in an otherwise quiet, monochrome UI.
const LINE_COLORS = ["#FFC53D", "#4CD9A0", "#FF6B5B", "#5B9CFF", "#C46BFF", "#3DE0D0"];
function lineColorFor(index: number): string {
  return LINE_COLORS[index % LINE_COLORS.length];
}

function parseMonAmount(value: string): bigint {
  const amount = parseEther(value.trim());
  if (amount === 0n) throw new Error("Enter an amount greater than 0 MON.");
  return amount;
}

function formatMon(amount: bigint): string {
  const [whole, fraction] = formatEther(amount).split(".");
  return fraction ? `${whole}.${fraction.slice(0, 4)}` : whole;
}

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message;
  if (/user rejected|rejected the request|denied/i.test(message)) return "Transaction cancelled.";
  if (/insufficient funds|not enough funds/i.test(message)) return "Not enough MON to complete this transaction.";
  if (/network|chain/i.test(message)) return "Check that your wallet is connected to Monad Testnet.";
  return message.length <= 180 ? message : fallback;
}

export default function GroupPage() {
  const params = useParams<{ id: string }>();
  const parsedGroupId = /^\d+$/.test(params.id) ? BigInt(params.id) : null;
  const groupId = parsedGroupId ?? 0n;
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { switchChain } = useSwitchChain();
  const walletBalance = useBalance({ address, chainId: monadTestnet.id, query: { enabled: !!address } });
  const { remember } = useKnownGroups();
  const { writeContractAsync } = useWriteContract();

  const notDeployed = GROUP_VAULT_ADDRESS === "0x0000000000000000000000000000000000000000";
  const wrongNetwork = !!address && chainId !== monadTestnet.id;
  const membership = useReadContract({
    ...groupVaultContract,
    functionName: "isMember",
    args: [groupId, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address && parsedGroupId !== null && !notDeployed },
  });
  const canTransact = !!address && membership.data === true && !!publicClient && !notDeployed && !wrongNetwork && parsedGroupId !== null;

  useEffect(() => {
    if (parsedGroupId !== null) remember(Number(parsedGroupId));
  }, [parsedGroupId, remember]);

  const group = useReadContract({ ...groupVaultContract, functionName: "getGroup", args: [groupId], query: { enabled: parsedGroupId !== null && !notDeployed } });
  const balances = useReadContract({ ...groupVaultContract, functionName: "getNetBalances", args: [groupId], query: { enabled: parsedGroupId !== null && !notDeployed } });
  const expenses = useReadContract({ ...groupVaultContract, functionName: "getExpenses", args: [groupId], query: { enabled: parsedGroupId !== null && !notDeployed } });
  const settlementPreview = useReadContract({
    ...groupVaultContract,
    functionName: "previewSettlement",
    args: [groupId],
    query: { enabled: parsedGroupId !== null && !notDeployed },
  });
  const myVaultBalance = useReadContract({
    ...groupVaultContract,
    functionName: "vaultBalance",
    args: [groupId, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address && parsedGroupId !== null && !notDeployed },
  });
  const myWithdrawable = useReadContract({
    ...groupVaultContract,
    functionName: "withdrawable",
    args: [groupId, address ?? "0x0000000000000000000000000000000000000000"],
    query: { enabled: !!address && parsedGroupId !== null && !notDeployed },
  });

  const members = group.data?.[2] ?? [];
  const [depositAmount, setDepositAmount] = useState("");
  const [expenseDesc, setExpenseDesc] = useState("");
  const [expenseAmount, setExpenseAmount] = useState("");
  const [payer, setPayer] = useState<string>("");
  const [participants, setParticipants] = useState<Set<string>>(new Set());
  const [surplusAmount, setSurplusAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shareMessage, setShareMessage] = useState<string | null>(null);
  const [transactionStatus, setTransactionStatus] = useState<string | null>(null);

  async function refetchAll() {
    await Promise.all([
      group.refetch(), balances.refetch(), expenses.refetch(), settlementPreview.refetch(),
      membership.refetch(), myVaultBalance.refetch(), myWithdrawable.refetch(),
    ]);
  }

  async function shareGroup() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setShareMessage("Group link copied");
    } catch {
      setShareMessage("Copy failed — share the page URL manually");
    }
    window.setTimeout(() => setShareMessage(null), 2500);
  }

  async function run(label: string, fn: () => Promise<`0x${string}`>) {
    if (!canTransact || !publicClient) {
      setError(notDeployed ? "The contract is not configured yet." : wrongNetwork ? "Switch to Monad Testnet first." : "Connect a wallet first.");
      return;
    }
    if (["settle", "withdraw", "surplus"].includes(label) && !window.confirm("Confirm this fund transfer in your wallet?")) {
      return;
    }
    setBusy(label);
    setError(null);
    setTransactionStatus("Waiting for wallet approval…");
    try {
      const hash = await fn();
      setTransactionStatus("Transaction submitted. Waiting for confirmation…");
      await publicClient.waitForTransactionReceipt({ hash });
      await refetchAll();
      setTransactionStatus("Transaction confirmed.");
      if (label === "deposit") setDepositAmount("");
      if (label === "expense") {
        setExpenseDesc("");
        setExpenseAmount("");
        setPayer("");
        setParticipants(new Set());
      }
      if (label === "surplus") setSurplusAmount("");
    } catch (err) {
      setError(friendlyError(err, "Transaction failed."));
      setTransactionStatus(null);
    } finally {
      setBusy(null);
      window.setTimeout(() => setTransactionStatus(null), 3000);
    }
  }

  function toggleParticipant(addr: string) {
    setParticipants((prev) => {
      const next = new Set(prev);
      if (next.has(addr)) next.delete(addr);
      else next.add(addr);
      return next;
    });
  }

  return (
    <main className="min-h-screen max-w-2xl mx-auto px-6 py-12">
      <header className="flex items-baseline justify-between border-b border-night-line pb-4 mb-8">
        <Link href="/" className="font-display text-2xl font-semibold tracking-tight">
          Metroly
        </Link>
        <ConnectButton />
      </header>

      <div className="mb-6 flex flex-wrap items-center justify-between gap-2 text-xs font-mono text-platform-soft">
        <span className="border border-signal/40 px-2 py-1 text-signal">MONAD TESTNET</span>
        {address && <span>Wallet: {walletBalance.data ? `${formatMon(walletBalance.data.value)} MON` : "loading…"}</span>}
      </div>

      {notDeployed ? (
        <p className="text-debit">This app has not been connected to a deployed vault contract yet.</p>
      ) : parsedGroupId === null ? (
        <p className="text-debit">That group link is invalid.</p>
      ) : wrongNetwork ? (
        <p className="text-debit">
          Switch your wallet to Monad Testnet to interact with this group.{" "}
          <button type="button" className="underline" onClick={() => switchChain({ chainId: monadTestnet.id })}>
            Switch network
          </button>
        </p>
      ) : address && membership.data === false ? (
        <p className="text-debit">You can view this group, but your connected wallet is not a member.</p>
      ) : group.error ? (
        <div className="text-debit">
          <p>Could not load this group from Monad Testnet.</p>
          <button type="button" onClick={() => group.refetch()} className="underline mt-2">
            Try again
          </button>
        </div>
      ) : group.isLoading ? (
        <p className="text-platform-soft">Loading ledger…</p>
      ) : !group.data ? (
        <p className="text-debit">This group doesn&apos;t exist onchain.</p>
      ) : (
        <>
          <div className="flex items-start justify-between gap-4 mb-8">
            <div>
              <h1 className="font-display text-xl font-semibold mb-1">{group.data[0]}</h1>
              <p className="text-sm text-platform-soft">{members.length} members</p>
            </div>
            <div className="text-right">
              <button type="button" onClick={shareGroup} className="border border-platform px-3 py-1.5 text-sm hover:bg-platform hover:text-night">
                Share group link
              </button>
              {shareMessage && <p className="text-xs text-credit mt-1">{shareMessage}</p>}
            </div>
          </div>

          {/* Balances */}
          <section className="mb-10">
            <h2 className="font-display text-lg font-semibold mb-3">Balances</h2>
            <table className="w-full font-mono text-sm">
              <tbody>
                {members.map((m, i) => {
                  const bal = balances.data?.[1]?.[i] ?? 0n;
                  const isYou = m.toLowerCase() === address?.toLowerCase();
                  return (
                    <tr key={m} className="border-b border-night-line">
                      <td className="py-2 pr-3">
                        <span className="inline-flex items-center gap-2">
                          <span
                            className="inline-block h-2.5 w-2.5 rounded-full"
                            style={{ backgroundColor: lineColorFor(i) }}
                            aria-hidden
                          />
                          {m.slice(0, 8)}…{isYou ? " (you)" : ""}
                        </span>
                      </td>
                      <td className={`py-2 text-right ${bal < 0n ? "text-debit" : bal > 0n ? "text-credit" : ""}`}>
                        {bal === 0n ? "settled" : `${bal > 0n ? "owed" : "owes"} ${formatEther(bal < 0n ? -bal : bal)} MON`}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>

          {/* Expense log */}
          <section className="mb-10">
            <h2 className="font-display text-lg font-semibold mb-3">Ledger</h2>
            {!expenses.data || expenses.data.length === 0 ? (
              <p className="text-sm text-platform-soft">No expenses logged yet.</p>
            ) : (
              <ul className="divide-y divide-night-line border-t border-night-line">
                {expenses.data.map((e, i) => (
                  <li key={i} className="flex justify-between py-2">
                    <span className="font-display">
                      {e.description} <span className="text-xs text-platform-soft">— paid by {e.payer.slice(0, 8)}…</span>
                    </span>
                    <span className="font-mono text-sm">{formatEther(e.amount)} MON</span>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {/* Your position */}
          <section className="mb-10 grid gap-4 font-mono text-sm sm:grid-cols-3">
            <div className="border border-night-line p-3">
              <p className="text-platform-soft mb-1">wallet balance</p>
              <p className="text-lg whitespace-nowrap">{walletBalance.data ? formatMon(walletBalance.data.value) : "—"} MON</p>
            </div>
            <div className="border border-night-line p-3">
              <p className="text-platform-soft mb-1">your vault balance</p>
              <p className="text-lg whitespace-nowrap">{myVaultBalance.data !== undefined ? formatMon(myVaultBalance.data) : "—"} MON</p>
            </div>
            <div className="border border-night-line p-3">
              <p className="text-platform-soft mb-1">withdrawable</p>
              <p className="text-lg whitespace-nowrap">{myWithdrawable.data !== undefined ? formatMon(myWithdrawable.data) : "—"} MON</p>
            </div>
          </section>

          <section className="mb-10 border border-night-line p-4">
            <h2 className="font-display text-lg font-semibold mb-3">Next settlement</h2>
            {settlementPreview.isLoading ? (
              <p className="text-sm text-platform-soft">Calculating transfers…</p>
            ) : settlementPreview.data && settlementPreview.data.length > 0 ? (
              <ul className="space-y-2 font-mono text-sm">
                {settlementPreview.data.map((transfer, index) => (
                  <li key={`${transfer.from}-${transfer.to}-${index}`} className="flex justify-between gap-3">
                    <span>{transfer.from.slice(0, 8)}… → {transfer.to.slice(0, 8)}…</span>
                    <span>{formatEther(transfer.amount)} MON</span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-platform-soft">Nothing to settle yet.</p>
            )}
          </section>

          {error && <p className="text-sm text-debit mb-4">{error}</p>}
          {transactionStatus && <p className="text-sm text-platform mb-4">{transactionStatus}</p>}

          {/* Deposit */}
          <section className="mb-10">
            <h2 className="font-display text-lg font-semibold mb-3">Deposit</h2>
            <div className="flex gap-2">
              <input
                value={depositAmount}
                onChange={(e) => setDepositAmount(e.target.value)}
                placeholder="0.1"
                inputMode="decimal"
                className="flex-1 border border-night-line bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:border-platform"
              />
              <button
                disabled={!canTransact || busy !== null || !depositAmount}
                onClick={() =>
                  run("deposit", () =>
                    writeContractAsync({
                      ...groupVaultContract,
                      functionName: "deposit",
                      args: [groupId],
                      value: parseMonAmount(depositAmount),
                    })
                  )
                }
                className="bg-signal text-signal-ink px-4 py-2 text-sm font-medium hover:brightness-95 disabled:opacity-50"
              >
                {busy === "deposit" ? "Depositing…" : "Deposit MON"}
              </button>
            </div>
          </section>

          {/* Add expense */}
          <section className="mb-10">
            <h2 className="font-display text-lg font-semibold mb-3">Log an expense</h2>
            <div className="space-y-3">
              <input
                value={expenseDesc}
                onChange={(e) => setExpenseDesc(e.target.value)}
                placeholder="Dinner"
                className="w-full border border-night-line bg-transparent px-3 py-2 font-display focus:outline-none focus:border-platform"
              />
              <input
                value={expenseAmount}
                onChange={(e) => setExpenseAmount(e.target.value)}
                placeholder="Amount in MON"
                inputMode="decimal"
                className="w-full border border-night-line bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:border-platform"
              />
              <div>
                <p className="text-sm text-platform-soft mb-1">Who paid?</p>
                <select
                  value={payer}
                  onChange={(e) => setPayer(e.target.value)}
                  className="w-full border border-night-line bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:border-platform"
                >
                  <option value="">select…</option>
                  {members.map((m) => (
                    <option key={m} value={m}>
                      {m}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <p className="text-sm text-platform-soft mb-1">Split among</p>
                <div className="flex flex-wrap gap-2">
                  {members.map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => toggleParticipant(m)}
                      className={`border px-2 py-1 text-xs font-mono ${
                        participants.has(m) ? "border-platform bg-platform text-night" : "border-night-line"
                      }`}
                    >
                      {m.slice(0, 8)}…
                    </button>
                  ))}
                </div>
              </div>
              <button
                disabled={!canTransact || busy !== null || !expenseDesc.trim() || !expenseAmount || !payer || participants.size === 0}
                onClick={() =>
                  run("expense", () =>
                    writeContractAsync({
                      ...groupVaultContract,
                      functionName: "addExpense",
                      args: [
                        groupId,
                        expenseDesc,
                        parseMonAmount(expenseAmount),
                        payer as `0x${string}`,
                        Array.from(participants) as `0x${string}`[],
                      ],
                    })
                  )
                }
                className="bg-signal text-signal-ink px-4 py-2 text-sm font-medium hover:brightness-95 disabled:opacity-50"
              >
                {busy === "expense" ? "Logging…" : "Log expense"}
              </button>
            </div>
          </section>

          {/* Settle + withdraw */}
          <section className="flex gap-3">
            <button
              disabled={!canTransact || busy !== null || !settlementPreview.data?.length}
              onClick={() => run("settle", () => writeContractAsync({ ...groupVaultContract, functionName: "settle", args: [groupId] }))}
              className="border border-platform px-4 py-2 text-sm font-medium hover:bg-platform hover:text-night disabled:opacity-50"
            >
              {busy === "settle" ? "Settling…" : "Settle up"}
            </button>
            <button
              disabled={!canTransact || busy !== null || !myWithdrawable.data}
              onClick={() => run("withdraw", () => writeContractAsync({ ...groupVaultContract, functionName: "withdraw", args: [groupId] }))}
              className="border border-platform px-4 py-2 text-sm font-medium hover:bg-platform hover:text-night disabled:opacity-50"
            >
              {busy === "withdraw" ? "Withdrawing…" : "Withdraw"}
            </button>
          </section>

          <section className="mt-8 border-t border-night-line pt-6">
            <h2 className="font-display text-lg font-semibold mb-3">Withdraw unused deposit</h2>
            <p className="text-sm text-platform-soft mb-3">
              Withdraw funds that are not needed for your outstanding share of the ledger.
            </p>
            <div className="flex gap-2">
              <input
                value={surplusAmount}
                onChange={(e) => setSurplusAmount(e.target.value)}
                placeholder="0.1"
                aria-label="Unused deposit amount in MON"
                inputMode="decimal"
                className="flex-1 border border-night-line bg-transparent px-3 py-2 font-mono text-sm focus:outline-none focus:border-platform"
              />
              <button
                disabled={!canTransact || busy !== null || !surplusAmount}
                onClick={() =>
                  run("surplus", () =>
                    writeContractAsync({
                      ...groupVaultContract,
                      functionName: "withdrawSurplus",
                      args: [groupId, parseMonAmount(surplusAmount)],
                    })
                  )
                }
                className="border border-platform px-4 py-2 text-sm font-medium hover:bg-platform hover:text-night disabled:opacity-50"
              >
                {busy === "surplus" ? "Withdrawing…" : "Withdraw surplus"}
              </button>
            </div>
          </section>
        </>
      )}
    </main>
  );
}
