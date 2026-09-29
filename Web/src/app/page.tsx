"use client";

export const dynamic = "force-dynamic";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { usePrivy } from "@privy-io/react-auth";
import { useAccount, useChainId, usePublicClient, useSwitchChain, useWriteContract } from "wagmi";
import { decodeEventLog, encodeFunctionData, parseAbiItem, type Hex } from "viem";
import { useSendTransaction, useWallets } from "@privy-io/react-auth";
import { ConnectButton } from "@/components/ConnectButton";
import { groupVaultContract, GROUP_VAULT_ADDRESS } from "@/lib/contract";
import { GROUP_VAULT_ABI } from "@/lib/groupVaultAbi";
import { useKnownGroups } from "@/lib/useKnownGroups";
import { monadTestnet } from "@/lib/chains";

const GROUP_CREATED_EVENT = parseAbiItem(
  "event GroupCreated(uint256 indexed groupId, string name, address indexed creator, address[] members)"
);
const sponsorTransactions = process.env.NEXT_PUBLIC_PRIVY_SPONSOR_TRANSACTIONS === "true";

function friendlyError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  const message = error.message;
  if (/user rejected|rejected the request|denied/i.test(message)) return "Transaction cancelled.";
  if (/insufficient funds|not enough funds/i.test(message)) return "Not enough MON to complete this transaction.";
  if (/network|chain/i.test(message)) return "Check that your wallet is connected to Monad Testnet.";
  return message.length <= 180 ? message : fallback;
}

export default function Home() {
  const { authenticated, login } = usePrivy();
  const { address } = useAccount();
  const chainId = useChainId();
  const publicClient = usePublicClient();
  const { switchChain } = useSwitchChain();
  const { writeContractAsync } = useWriteContract();
  const { sendTransaction } = useSendTransaction();
  const { wallets } = useWallets();
  const { groupIds, remember } = useKnownGroups();
  const router = useRouter();

  const [name, setName] = useState("");
  const [membersInput, setMembersInput] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [discovering, setDiscovering] = useState(false);
  const notDeployed = GROUP_VAULT_ADDRESS === "0x0000000000000000000000000000000000000000";
  const wrongNetwork = !!address && chainId !== monadTestnet.id;

  useEffect(() => {
    if (!address || !publicClient || notDeployed || wrongNetwork) return;
    const connectedAddress = address;

    let cancelled = false;
    async function discoverGroups() {
      setDiscovering(true);
      try {
        const logs = await publicClient!.getLogs({ address: GROUP_VAULT_ADDRESS, event: GROUP_CREATED_EVENT });
        for (const log of logs) {
          try {
            const decoded = decodeEventLog({ abi: GROUP_VAULT_ABI, ...log });
            if (decoded.eventName !== "GroupCreated") continue;
            const args = decoded.args as { groupId: bigint; creator: string; members: readonly string[] };
            const isMember = args.creator.toLowerCase() === connectedAddress.toLowerCase() ||
              args.members.some((member) => member.toLowerCase() === connectedAddress.toLowerCase());
            if (isMember && !cancelled) remember(Number(args.groupId));
          } catch {
            // Ignore logs emitted by other contracts or unrelated events.
          }
        }
      } catch {
        // Discovery is best-effort; local groups and direct links still work.
      } finally {
        if (!cancelled) setDiscovering(false);
      }
    }
    void discoverGroups();
    return () => { cancelled = true; };
  }, [address, notDeployed, publicClient, remember, wrongNetwork]);

  const canCreate = authenticated && !!address && !notDeployed && !wrongNetwork && !creating;

  async function createGroupTransaction(groupName: string, members: readonly `0x${string}`[]): Promise<Hex> {
    const embeddedWallet = address && wallets.some((wallet) =>
      wallet.address.toLowerCase() === address.toLowerCase() &&
      (wallet.walletClientType === "privy" || wallet.walletClientType === "privy-v2")
    );
    if (sponsorTransactions && embeddedWallet && address) {
      const data = encodeFunctionData({
        abi: groupVaultContract.abi,
        functionName: "createGroup",
        args: [groupName, members],
      });
      const result = await sendTransaction(
        { to: GROUP_VAULT_ADDRESS, chainId: monadTestnet.id, data },
        { sponsor: true, address },
      );
      return result.hash;
    }

    return writeContractAsync({
      ...groupVaultContract,
      functionName: "createGroup",
      args: [groupName, members],
    });
  }

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    const others = membersInput
      .split(",")
      .map((a) => a.trim())
      .filter(Boolean);

    if (!name.trim()) {
      setError("Give the group a name.");
      return;
    }
    if (others.length > 19) {
      setError("A group can have at most 20 members, including you.");
      return;
    }

    const seen = new Set<string>();

    for (const a of others) {
      if (!/^0x[a-fA-F0-9]{40}$/.test(a)) {
        setError(`"${a}" doesn't look like a wallet address.`);
        return;
      }
      const normalized = a.toLowerCase();
      if (normalized === address?.toLowerCase()) {
        setError("You are added automatically—don't include your own address.");
        return;
      }
      if (seen.has(normalized)) {
        setError(`"${a}" was entered more than once.`);
        return;
      }
      seen.add(normalized);
    }

    setCreating(true);
    try {
      if (!address || !publicClient) {
        setError("Connect a wallet on Monad Testnet before creating a group.");
        return;
      }
      const hash = await createGroupTransaction(name.trim(), others as `0x${string}`[]);

      const receipt = await publicClient.waitForTransactionReceipt({ hash });

      let newGroupId: number | null = null;
      for (const log of receipt.logs) {
        try {
          const decoded = decodeEventLog({ abi: GROUP_VAULT_ABI, ...log });
          if (decoded.eventName === "GroupCreated") {
            newGroupId = Number(decoded.args.groupId);
            break;
          }
        } catch {
          // Not a GroupCreated log from this contract — ignore and keep scanning.
        }
      }

      if (newGroupId === null) {
        setError("Group was created, but its ID couldn't be read from the transaction. Check Monadscan.");
        return;
      }

      remember(newGroupId);
      router.push(`/group/${newGroupId}`);
    } catch (err) {
      setError(friendlyError(err, "Something went wrong creating the group."));
    } finally {
      setCreating(false);
    }
  }

  return (
    <main className="min-h-screen max-w-3xl mx-auto px-6 py-8 sm:py-12 lg:py-20">
      <header className="flex items-center justify-between border-b border-night-line pb-5">
        <div className="flex items-center gap-3">
          <h1 className="font-display text-3xl font-semibold tracking-tight">Metroly</h1>
        </div>
        <ConnectButton />
      </header>

      {notDeployed && (
        <p className="mb-8 text-sm text-debit border border-debit/30 bg-debit/5 px-3 py-2">
          Contract address isn&apos;t configured yet — set NEXT_PUBLIC_GROUP_VAULT_ADDRESS in .env.local
          after deploying to Monad Testnet.
        </p>
      )}

      {wrongNetwork && (
        <p className="mb-8 text-sm text-debit border border-debit/30 bg-debit/5 px-3 py-2">
          Switch your wallet to Monad Testnet before creating a group.{" "}
          <button type="button" className="underline" onClick={() => switchChain({ chainId: monadTestnet.id })}>
            Switch network
          </button>
        </p>
      )}

      {!authenticated ? (
        <section className="max-w-2xl pt-20 pb-16 sm:pt-28 sm:pb-24">
          <p className="font-mono text-xs uppercase tracking-[0.24em] text-signal">Shared spending, made simple</p>
          <h2 className="mt-5 font-display text-4xl font-semibold leading-[1.05] tracking-tight sm:text-6xl">
            Split the cost. Keep the group moving.
          </h2>
          <p className="mt-6 max-w-xl text-lg leading-8 text-platform-soft sm:text-xl">
            Metroly gives trips, apartments, and nights out one shared ledger—then settles everyone with the fewest possible transfers.
          </p>
          <button
            type="button"
            onClick={login}
            className="mt-9 bg-signal px-5 py-3 text-sm font-medium text-signal-ink transition-[filter] hover:brightness-95"
          >
            Sign in to start
          </button>
        </section>
      ) : (
        <>
          <section className="max-w-2xl pt-12 pb-16 sm:pt-20 sm:pb-20">
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-signal">New ledger</p>
            <h2 className="mt-4 font-display text-3xl font-semibold tracking-tight sm:text-4xl">Start a group</h2>
            <p className="mt-3 max-w-lg text-base leading-7 text-platform-soft sm:text-lg">
              Set up the group once, add everyone&apos;s wallet, and keep every shared expense in one place.
            </p>
            <form onSubmit={handleCreate} className="mt-9 max-w-xl space-y-5">
              <div>
                <label className="block text-sm text-platform-soft mb-1" htmlFor="name">
                  What&apos;s it for?
                </label>
                <input
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Lisbon trip"
                  required
                  className="w-full border border-night-line bg-transparent px-3 py-3 text-base font-display focus:outline-none focus:border-platform"
                />
              </div>
              <div>
                <label className="block text-sm text-platform-soft mb-1" htmlFor="members">
                  Everyone else&apos;s wallet address, comma-separated
                </label>
                <input
                  id="members"
                  value={membersInput}
                  onChange={(e) => setMembersInput(e.target.value)}
                  placeholder="0xabc..., 0xdef..."
                  className="w-full border border-night-line bg-transparent px-3 py-3 text-base font-mono focus:outline-none focus:border-platform"
                />
                <p className="text-xs text-platform-soft mt-1">You ({address?.slice(0, 8)}…) are added automatically.</p>
              </div>
              {error && <p className="text-sm text-debit">{error}</p>}
              <button
                type="submit"
                disabled={!canCreate}
                className="bg-signal px-5 py-3 text-sm font-medium text-signal-ink hover:brightness-95 transition-[filter] disabled:opacity-50"
              >
                {creating ? "Creating…" : "Create group"}
              </button>
            </form>
          </section>

          <section>
            <h2 className="font-display text-lg font-semibold mb-4">Your groups</h2>
            {discovering && <p className="text-xs text-platform-soft mb-3">Finding your groups onchain…</p>}
            {groupIds.length === 0 ? (
              <p className="text-sm text-platform-soft">No groups yet on this device.</p>
            ) : (
              <ul className="divide-y divide-night-line border-t border-b border-night-line">
                {groupIds.map((id) => (
                  <li key={id}>
                    <Link href={`/group/${id}`} className="flex justify-between py-3 hover:bg-platform/5 px-1 -mx-1">
                      <span className="font-display">Group #{id}</span>
                      <span className="font-mono text-sm text-platform-soft">open</span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}
