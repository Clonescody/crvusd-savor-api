import { VercelRequest, VercelResponse } from "@vercel/node";

import Redis from "ioredis";
import {
  http,
  createPublicClient,
  isAddress,
  getAddress,
  formatUnits,
} from "viem";
import { arbitrum, mainnet } from "viem/chains";

type Event = {
  type: EventType;
  amount: number;
  hash: string;
  blockNumber: number;
};

type SavingsData = {
  totalDeposited: number;
  totalRevenues: number;
  events: Event[];
};

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

enum SupportedChains {
  Ethereum = "ethereum",
  Arbitrum = "arbitrum",
}

const LLAMA_LEND_VAULT_ABI = {
  abi: [
    {
      name: "Deposit",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "owner", type: "address", indexed: true },
        { name: "assets", type: "uint256", indexed: false },
        { name: "shares", type: "uint256", indexed: false },
      ],
      anonymous: false,
      type: "event",
    },
    {
      name: "Withdraw",
      inputs: [
        { name: "sender", type: "address", indexed: true },
        { name: "receiver", type: "address", indexed: true },
        { name: "owner", type: "address", indexed: true },
        { name: "assets", type: "uint256", indexed: false },
        { name: "shares", type: "uint256", indexed: false },
      ],
      anonymous: false,
      type: "event",
    },
    {
      stateMutability: "view",
      type: "function",
      name: "balanceOf",
      inputs: [{ name: "arg0", type: "address" }],
      outputs: [{ name: "", type: "uint256" }],
    },
    {
      stateMutability: "view",
      type: "function",
      name: "previewRedeem",
      inputs: [{ name: "shares", type: "uint256" }],
      outputs: [{ name: "", type: "uint256" }],
    },
  ],
} as const;

enum EventType {
  Deposit = "deposit",
  Withdraw = "withdraw",
}

export default async function GET(req: VercelRequest, res: VercelResponse) {
  if (!process.env.REDIS_SERVER_URL) {
    return res.status(500).json({ message: "Redis server URL is not set" });
  }
  const userAddress = req.query.user as string;
  if (!isAddress(userAddress)) {
    return res.status(400).json({ message: "Invalid user address" });
  }
  const chain = req.query.chain as string;
  if (!Object.values(SupportedChains).includes(chain as SupportedChains)) {
    return res.status(400).json({ message: "Invalid chain" });
  }

  const cacheKey = `savings-${chain}-${userAddress}`;

  const isCacheEntryUpdateNeeded = (
    updateTimestamp: number,
    minutesCacheInterval: number
  ): boolean => {
    const then = new Date(updateTimestamp);
    const now = new Date();
    const msBetweenDates = Math.abs(then.getTime() - now.getTime());
    const minutesBetweenDates = msBetweenDates / (60 * 1000);
    return minutesBetweenDates > minutesCacheInterval;
  };

  const redisService = new Redis(process.env.REDIS_SERVER_URL);

  const setRedisCacheEntry = async (
    cacheKey: string,
    data: any,
    updateTimestamp?: number
  ) => {
    await redisService.set(
      cacheKey,
      JSON.stringify({
        updateTimestamp: updateTimestamp || new Date().getTime(),
        data,
      })
    );
  };

  const getRedisCacheEntry = async <T>(cacheKey: string): Promise<T | null> => {
    const cacheEntry = await redisService.get(cacheKey);
    return cacheEntry ? JSON.parse(cacheEntry) : null;
  };

  const cacheEntry = await getRedisCacheEntry<RedisCacheEntry<SavingsData>>(
    cacheKey
  );

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 60)) {
    return res.status(200).json({ status: "success", data: cacheEntry.data });
  }

  const getViemChain = (chain: SupportedChains) => {
    if (chain === SupportedChains.Ethereum) {
      return mainnet;
    }
    return arbitrum;
  };
  const getRpcUrl = (chain: SupportedChains) => {
    if (chain === SupportedChains.Ethereum) {
      return process.env.ETHEREUM_RPC_URL;
    }
    return process.env.ARBITRUM_RPC_URL;
  };

  const viemClient = createPublicClient({
    chain: getViemChain(chain as SupportedChains),
    transport: http(getRpcUrl(chain as SupportedChains)),
  });

  const vault = getAddress("0x0655977feb2f289a4ab78af67bab0d17aab84367");
  const startBlock = 21087889n;

  const [depositFilter, withdrawFilter] = await Promise.all([
    viemClient.createContractEventFilter({
      address: vault,
      abi: LLAMA_LEND_VAULT_ABI.abi,
      eventName: "Deposit",
      fromBlock: startBlock,
      args: {
        owner: userAddress,
      },
      strict: true,
    }),
    viemClient.createContractEventFilter({
      address: vault,
      abi: LLAMA_LEND_VAULT_ABI.abi,
      eventName: "Withdraw",
      fromBlock: startBlock,
      args: {
        owner: userAddress,
      },
      strict: true,
    }),
  ]);

  const balanceOfContract = await viemClient.readContract({
    address: vault,
    abi: LLAMA_LEND_VAULT_ABI.abi,
    functionName: "balanceOf",
    args: [userAddress],
  });

  const [depositLogs, withdrawLogs, redeemValueRaw] = await Promise.all([
    viemClient.getFilterLogs({
      filter: depositFilter,
    }),
    viemClient.getFilterLogs({
      filter: withdrawFilter,
    }),
    viemClient.readContract({
      address: vault,
      abi: LLAMA_LEND_VAULT_ABI.abi,
      functionName: "previewRedeem",
      args: [balanceOfContract],
    }),
  ]);

  const allLogs = [...depositLogs, ...withdrawLogs];

  if (allLogs.length === 0) {
    return res.status(200).json({
      status: "empty",
      totalDeposited: 0,
      totalRevenues: 0,
      events: [],
    });
  }

  const redeemValue = Number(formatUnits(redeemValueRaw, 18));
  let depositedInVault = 0;
  let withdrawFromVault = 0;

  allLogs.forEach((log) => {
    if (log.eventName === "Deposit") {
      depositedInVault += Number(formatUnits(log.args.assets, 18));
    } else {
      withdrawFromVault += Number(formatUnits(log.args.assets, 18));
    }
  });

  const events = [
    ...depositLogs.map((event) => ({
      type: EventType.Deposit,
      amount: event.args.assets
        ? Number(formatUnits(event.args.assets, 18))
        : 0,
      hash: event.transactionHash,
      blockNumber: Number(event.blockNumber),
    })),
    ...withdrawLogs.map((event) => ({
      type: EventType.Withdraw,
      amount: event.args.assets
        ? Number(formatUnits(event.args.assets, 18))
        : 0,
      hash: event.transactionHash,
      blockNumber: Number(event.blockNumber),
    })),
  ].sort((a, b) => b.blockNumber - a.blockNumber);

  let totalDeposited = 0;

  if (redeemValue > 0 && events.length > 0) {
    totalDeposited = events.reduce(
      (acc, event) =>
        event.type === EventType.Deposit
          ? acc + event.amount
          : acc - event.amount,
      0
    );
  }

  const totalRevenues = redeemValue - totalDeposited;

  await setRedisCacheEntry(cacheKey, {
    totalDeposited,
    totalRevenues,
    events,
  });

  res.status(200).json({
    status: "success",
    totalDeposited,
    totalRevenues,
    events,
  });
}
