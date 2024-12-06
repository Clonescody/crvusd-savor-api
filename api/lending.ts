import { VercelRequest, VercelResponse } from "@vercel/node";
import axios from "axios";

import Redis from "ioredis";
import {
  http,
  createPublicClient,
  isAddress,
  getAddress,
  formatUnits,
  Address,
} from "viem";
import { arbitrum, fraxtal, mainnet } from "viem/chains";

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

type CurveApiChains = {
  data: string[];
};

type CurveApiVaultEvent = {
  user: string;
  event_type: string;
  block_number: number;
  dt: string;
  transaction_hash: string;
  log_index: number;
  assets: string;
  shares: string;
  sender: string;
  receiver: string;
};

type CurveApiVaultEventsResponse = {
  user: string;
  total_deposited: string;
  events: CurveApiVaultEvent[];
};

type CurveApiVault = {
  id: string;
  name: string;
  address: Address;
  controllerAddress: Address;
  ammAddress: Address;
  monetaryPolicyAddress: Address;
  rates: {
    borrowApr: number;
    borrowApy: number;
    borrowApyPcent: number;
    lendApr: number;
    lendApy: number;
    lendApyPcent: number;
  };
  gaugeAddress: Address;
  gaugeRewards: [
    {
      gaugeAddress: Address;
      tokenPrice: number;
      name: string;
      symbol: string;
      decimals: number;
      apy: number;
      metaData: {
        rate: string;
        periodFinish: number;
      };
      tokenAddress: Address;
    }
  ];
  assets: {
    borrowed: {
      symbol: string;
      decimals: number;
      address: Address;
      blockchainId: string;
      usdPrice: number;
    };
    collateral: {
      symbol: string;
      decimals: number;
      address: Address;
      blockchainId: string;
      usdPrice: number;
    };
  };
  vaultShares: {
    pricePerShare: number;
    totalShares: number;
  };
  totalSupplied: {
    total: number;
    usdTotal: number;
  };
  borrowed: {
    total: number;
    usdTotal: number;
  };
  availableToBorrow: {
    total: number;
    usdTotal: number;
  };
  lendingVaultUrls: {
    deposit: string;
    withdraw: string;
  };
  usdTotal: number;
  ammBalances: {
    ammBalanceBorrowed: number;
    ammBalanceBorrowedUsd: number;
    ammBalanceCollateral: number;
    ammBalanceCollateralUsd: number;
  };
  blockchainId: string;
  registryId: string;
};

enum EventType {
  Deposit = "deposit",
  Withdraw = "withdraw",
}

enum SupportedChains {
  Ethereum = "ethereum",
  Arbitrum = "arbitrum",
  Fraxtal = "fraxtal",
}

type Event = {
  type: EventType;
  amount: number;
  hash: string;
  timestamp: number;
  chain: string;
};

type Vault = {
  collateral: string;
  borrowed: string;
  address: Address;
  lendApyPcent: number;
  chainId: string;
  depositUrl: string;
  withdrawUrl: string;
  collateralTvlUsd: number;
  borrowedTvl: number;
  availableToBorrow: number;
};

type VaultWithEvents = Vault & {
  deposited: number;
  redeemValue: number;
  earnings: number;
  events: Event[];
};

const LLAMA_LEND_VAULT_ABI = {
  abi: [
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

const getRpcUrl = (chain: SupportedChains): string => {
  if (chain === SupportedChains.Ethereum) {
    return process.env.ETHEREUM_RPC_URL as string;
  }
  if (chain === SupportedChains.Fraxtal) {
    return process.env.FRAXTAL_RPC_URL as string;
  }
  return process.env.ARBITRUM_RPC_URL as string;
};

const getChainObject = (chain: SupportedChains) => {
  if (chain === SupportedChains.Ethereum) {
    return mainnet;
  }
  if (chain === SupportedChains.Fraxtal) {
    return fraxtal;
  }
  return arbitrum;
};

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

const setRedisCacheEntry = async (
  redisService: Redis,
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

const getRedisCacheEntry = async <T>(
  redisService: Redis,
  cacheKey: string
): Promise<{ data: T; updateTimestamp: number } | null> => {
  const cacheEntry = await redisService.get(cacheKey);
  return cacheEntry ? JSON.parse(cacheEntry) : null;
};

const fetchChainsList = async (): Promise<string[]> => {
  const url = `https://prices.curve.fi/v1/lending/chains`;

  const response = await axios.get<CurveApiChains>(url);
  const { data: chains } = response.data;

  return chains;
};

const fetchVaultsList = async (chain: string): Promise<Vault[]> => {
  const url = `https://api.curve.fi/v1/getLendingVaults/all/${chain}`;

  const response = await axios.get<{
    data: { lendingVaultData: CurveApiVault[] };
  }>(url);
  const {
    data: { lendingVaultData: vaults },
  } = response.data;

  return vaults
    .filter((vault) => vault.rates.lendApyPcent > 0)
    .filter(
      (vault) => vault.assets.collateral.symbol.toLowerCase() !== "crvusd"
    )
    .map(
      (vault: CurveApiVault): Vault => ({
        collateral: vault.assets.collateral.symbol,
        borrowed: vault.assets.borrowed.symbol,
        collateralTvlUsd: vault.totalSupplied.usdTotal,
        borrowedTvl: vault.borrowed.total,
        availableToBorrow: vault.availableToBorrow.total,
        address: getAddress(vault.address),
        lendApyPcent: vault.rates.lendApyPcent,
        chainId: vault.blockchainId,
        depositUrl: vault.lendingVaultUrls.deposit,
        withdrawUrl: vault.lendingVaultUrls.withdraw,
      })
    );
};

const fetchVaultEvents = async (
  chain: SupportedChains,
  vaultAddress: Address,
  userAddress: Address
): Promise<Event[]> => {
  const url = `https://prices.curve.fi/v1/lending/vaults/${chain}/${vaultAddress}/${userAddress}`;

  const response = await axios.get<CurveApiVaultEventsResponse>(url);
  const { events } = response.data;

  return events
    .map((event) => ({
      type:
        event.event_type === "Deposit" ? EventType.Deposit : EventType.Withdraw,
      amount: Number(formatUnits(BigInt(event.assets), 18)),
      hash: event.transaction_hash,
      timestamp: new Date(event.dt).getTime(),
      chain,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);
};

const fetchVaultsAndEventsForChain = async (
  chain: SupportedChains,
  userAddress: Address
): Promise<VaultWithEvents[]> => {
  const viemClient = createPublicClient({
    chain: getChainObject(chain),
    transport: http(getRpcUrl(chain)),
  });

  const vaults = await fetchVaultsList(chain);
  const allVaultsEvents: VaultWithEvents[] = [];

  for (const vault of vaults) {
    const events = await fetchVaultEvents(
      chain as SupportedChains,
      vault.address,
      userAddress
    );

    let redeemValue = 0;
    let depositedInVault = 0;
    let withdrawnFromVault = 0;

    if (events.length > 0) {
      const balanceOf = await viemClient.readContract({
        address: vault.address,
        abi: LLAMA_LEND_VAULT_ABI.abi,
        functionName: "balanceOf",
        args: [userAddress],
      });

      const redeemValueRaw = await viemClient.readContract({
        address: vault.address,
        abi: LLAMA_LEND_VAULT_ABI.abi,
        functionName: "previewRedeem",
        args: [balanceOf],
      });

      redeemValue = Number(formatUnits(redeemValueRaw, 18));

      events.forEach((event) => {
        if (event.type === EventType.Deposit) {
          depositedInVault += event.amount;
        } else {
          withdrawnFromVault += event.amount;
        }
      });
    }
    let deposited = depositedInVault - withdrawnFromVault;
    let earnings = redeemValue - deposited;
    if (redeemValue === 0) {
      deposited = 0;
      earnings = withdrawnFromVault - depositedInVault;
    }

    allVaultsEvents.push({
      ...vault,
      deposited,
      redeemValue,
      earnings,
      events,
    });
  }

  return allVaultsEvents;
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Credentials", "false");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    return res.status(200).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ message: "Method not allowed" });
  }
  if (!process.env.REDIS_URL) {
    return res.status(500).json({
      message: "Redis server URL is not set",
    });
  }
  const userAddress = req.body.user as string;
  if (!isAddress(userAddress)) {
    return res
      .status(400)
      .json({ message: `Invalid user address: ${userAddress}` });
  }

  const cacheKey = `lending-${userAddress}`;

  const redisService = new Redis(process.env.REDIS_URL);

  const cacheEntry = await getRedisCacheEntry<
    RedisCacheEntry<VaultWithEvents[]>
  >(redisService, cacheKey);

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 60)) {
    return res.status(200).json({ status: "success", data: cacheEntry.data });
  }

  const chains = await fetchChainsList();

  const allVaultsEvents: VaultWithEvents[] = [];

  for (const chain of chains) {
    const vaultsAndEvents = await fetchVaultsAndEventsForChain(
      chain as SupportedChains,
      userAddress
    );
    allVaultsEvents.push(...vaultsAndEvents);
  }

  await setRedisCacheEntry(redisService, cacheKey, allVaultsEvents);

  res.status(200).json({
    status: "success",
    data: allVaultsEvents,
  });
}
