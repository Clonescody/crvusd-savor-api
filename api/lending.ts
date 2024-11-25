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
import { arbitrum, mainnet } from "viem/chains";

type Event = {
  type: EventType;
  amount: number;
  hash: string;
  blockNumber: number;
};

type LendingData = {
  totalDeposited: number;
  totalRevenues: number;
  events: Event[];
};

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

type ApiVault = {
  address: string;
  assets: {
    borrowed: {
      symbol: string;
    };
    collateral: {
      symbol: string;
    };
  };
  borrowed: {
    total: number;
  };
  rates: {
    lendApyPcent: number;
  };
  blockchainId: string;
};

type Vault = {
  collateral: string;
  borrowed: string;
  address: Address;
  lendApyPcent: number;
  chainId: string;
};

type VaultWithEvents = {
  vault: Address;
  redeemValue: number;
  earnings: number;
  collateral: string;
  borrowed: string;
  chainId: string;
  lendApyPcent: number;
  events: Event[];
};

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

enum SupportedChains {
  Ethereum = "ethereum",
  Arbitrum = "arbitrum",
}

const getLendingVaultStartBlock = (
  chain: SupportedChains,
  vaultAddress: Address
): bigint | undefined => {
  switch (chain) {
    case SupportedChains.Ethereum: {
      switch (vaultAddress) {
        case getAddress("0x8cf1DE26729cfB7137AF1A6B2a665e099EC319b5"):
          return 19422666n;
        case getAddress("0x5AE28c9197a4a6570216fC7e53E7e0221D7A0FEF"):
          return 19422678n;
        case getAddress("0xb2b23C87a4B6d1b03Ba603F7C3EB9A81fDC0AAC9"):
          return 19422684n;
        case getAddress("0xCeA18a8752bb7e7817F9AE7565328FE415C0f2cA"):
          return 19422691n;
        case getAddress("0x4D2f44B0369f3C20c3d670D2C26b048985598450"):
          return 19422706n;
        case getAddress("0x46196C004de85c7a75C8b1bB9d54Afb0f8654A45"):
          return 19468672n;
        case getAddress("0x99Cff9Dc26A44dc2496B4448ebE415b5E894bd30"):
          return 19468701n;
        case getAddress("0x52096539ed1391CB50C6b9e4Fd18aFd2438ED23b"):
          return 19481927n;
        case getAddress("0x7586C58bf6292B3C9DeFC8333fc757d6c5dA0f7E"):
          return 19707458n;
        case getAddress("0xccd37EB6374Ae5b1f0b85ac97eFf14770e0D0063"):
          return 19800634n;
        case getAddress("0xff467c6E827ebbEa64DA1ab0425021E6c89Fbe0d"):
          return 19801071n;
        case getAddress("0x4a7999c55d3a93dAf72EA112985e57c2E3b9e95D"):
          return 19999153n;
        case getAddress("0x8fb1c7AEDcbBc1222325C39dd5c1D2d23420CAe3"):
          return 20034869n;
        case getAddress("0x21CF1c5Dc48C603b89907FE6a7AE83EA5e3709aF"):
          return 20035301n;
        case getAddress("0xc687141c18F20f7Ba405e45328825579fDdD3195"):
          return 20148558n;
        case getAddress("0xd0c183C9339e73D7c9146D48E1111d1FBEe2D6f9"):
          return 20157147n;
        case getAddress("0x839020cf9528f24c303e7789455D94534CbdCbC1"):
          return 20249759n;
        case getAddress("0x14361C243174794E2207296a6AD59bb0Dec1d388"):
          return 20325474n;
        case getAddress("0xECd491fc3D97e3b7be01E4175ECE7F91829AAef8"):
          return 20340672n;
        case getAddress("0xA508Bb33E9EBCd3f505059154Ceb4F9b446b76b3"):
          return 20420349n;
        case getAddress("0x0111646E459e0BBa57daCA438262f3A092ae24C6"):
          return 20420974n;
        case getAddress("0x7F6F1E23F6479477D045e2E61F0169f6Eb561003"):
          return 20629979n;
        case getAddress("0xC6F7E164ed085b68d5DF20d264f70410CB0B7458"):
          return 20899272n;
        case getAddress("0x52036c9046247C3358c987A2389FFDe6Ef8564c9"):
          return 20925172n;
        case getAddress("0x2707FeB6C0F9bf53b7e0c108d50b15fD7B32701f"):
          return 20941819n;
        case getAddress("0x88BDDB9293F3EFa2ceA349E184c656Ae0817aC87"):
          return 21030792n;
        case getAddress("0xc9cCB6E3Cc9D1766965278Bd1e7cc4e58549D1F8"):
          return 21031049n;
        default:
          return 21031049n; // always use the last registered vault block
      }
    }
    case SupportedChains.Arbitrum: {
      switch (vaultAddress) {
        case getAddress("0x49014A8eB1585cBee6A7a9A50C3b81017BF6Cc4d"):
          return 193652607n;
        case getAddress("0x60D38b12d22BF423F28082bf396ff8F28cC506B1"):
          return 193652708n;
        case getAddress("0xB50409Dd4D5B418042ab4DCee6a2FA7D1FE2fcf8"):
          return 195190204n;
        case getAddress("0x7d622A3615B34abf84Ac255b8C8D1685ea3a433F"):
          return 195721892n;
        case getAddress("0xeEaF2ccB73A01deb38Eca2947d963D64CfDe6A32"):
          return 196070126n;
        case getAddress("0x65592b1F12c07D434e95c7BF87F4f2f464e950e4"):
          return 196070155n;
        case getAddress("0xb56369a6519F84C6fD92644D421273618B8d62B0"):
          return 198287645n;
        case getAddress("0xebA51f6472F4cE1C47668c2474ab8f84B32E1ae7"):
          return 198472455n;
        case getAddress("0x2415747A063B55bFeb65e22f9a95a83e0151e4F8"):
          return 199919802n;
        case getAddress("0xd3cA9BEc3e681b0f578FD87f20eBCf2B7e0bb739"):
          return 219516379n;
        case getAddress("0xe07f1151887b8FDC6800f737252f6b91b46b5865"):
          return 219516420n;
        case getAddress("0xa6C2E6A83D594e862cDB349396856f7FFE9a979B"):
          return 219516457n;
        case getAddress("0x9D3F07f173E5ae7b7a789ac870D23669Af218e89"):
          return 219516500n;
        case getAddress("0xC8248953429d707C6A2815653ECa89846Ffaa63b"):
          return 230535746n;
        case getAddress("0xd595E5EFbd887107a6Cc646b76f084f55AfDA2ac"):
          return 244549364n;
        case getAddress("0xe296eE7F83D1d95B3f7827fF1D08Fe1E4cF09d8d"):
          return 244552387n;
        case getAddress("0x2dA79346E3f5d28aAd323096aBe4dA79C5140916"):
          return 255155893n;
        case getAddress("0x0E6Ad128D7E217439bEEa90695FE7ec859c7F98C"):
          return 256880630n;
        case getAddress("0x13E7Bd499447318E3B7a312fD6369d8E562e15E8"):
          return 268471020n;
        case getAddress("0x744DE5297Ab6e4846c55Ba57D99cee1C3408bB80"):
          return 268471535n;
        case getAddress("0x6CFEa3B86ea254C0e4C8c2276aB9e93F58CDB597"):
          return 268473102n;
        default:
          return 268473102n; // always use the last registered vault block
      }
    }
    default:
      return undefined;
  }
};

const getRpcUrl = (chain: SupportedChains): string => {
  if (chain === SupportedChains.Ethereum) {
    return process.env.ETHEREUM_RPC_URL as string;
  }
  return process.env.ARBITRUM_RPC_URL as string;
};

const getChainObject = (chain: SupportedChains) => {
  if (chain === SupportedChains.Ethereum) {
    return mainnet;
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

const fetchVaultsList = async (chain: string): Promise<Vault[]> => {
  const url = `https://api.curve.fi/v1/getLendingVaults/all/${chain}`;

  const response = await axios.get<{
    data: { lendingVaultData: ApiVault[] };
  }>(url);
  const {
    data: { lendingVaultData: vaults },
  } = response.data;

  return vaults
    .filter((vault) => vault.rates.lendApyPcent > 0)
    .map(
      (vault: ApiVault): Vault => ({
        collateral: vault.assets.collateral.symbol,
        borrowed: vault.assets.borrowed.symbol,
        address: getAddress(vault.address),
        lendApyPcent: vault.rates.lendApyPcent,
        chainId: vault.blockchainId,
      })
    );
};

export default async function POST(req: VercelRequest, res: VercelResponse) {
  if (!process.env.REDIS_URL) {
    return res.status(500).json({
      message: "Redis server URL is not set",
    });
  }
  const userAddress = req.body.user as string;
  if (!isAddress(userAddress)) {
    return res.status(400).json({ message: "Invalid user address" });
  }
  const chain = req.body.chain as string;
  if (!Object.values(SupportedChains).includes(chain as SupportedChains)) {
    return res.status(400).json({ message: `Unsupported chain: ${chain}` });
  }

  const cacheKey = `lending-${chain}-${userAddress}`;
  const lastUserEventBlockKey = `lending-${chain}-${userAddress}-last-event-block`;

  const redisService = new Redis(process.env.REDIS_URL);

  const [cacheEntry, lastUserEventBlock] = await Promise.all([
    getRedisCacheEntry<RedisCacheEntry<LendingData>>(redisService, cacheKey),
    getRedisCacheEntry<number>(redisService, lastUserEventBlockKey),
  ]);

  const lastUserEventBlockNumber = lastUserEventBlock
    ? lastUserEventBlock.data
    : null;

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 60)) {
    return res.status(200).json({ status: "success", data: cacheEntry.data });
  }

  const viemClient = createPublicClient({
    chain: getChainObject(chain as SupportedChains),
    transport: http(getRpcUrl(chain as SupportedChains)),
  });

  const vaults = await fetchVaultsList(chain);
  const allVaultsEvents: VaultWithEvents[] = [];

  for (const vault of vaults) {
    const startBlock = lastUserEventBlockNumber
      ? BigInt(lastUserEventBlockNumber)
      : getLendingVaultStartBlock(chain as SupportedChains, vault.address);

    const [depositFilter, withdrawFilter] = await Promise.all([
      viemClient.createContractEventFilter({
        address: vault.address,
        abi: LLAMA_LEND_VAULT_ABI.abi,
        eventName: "Deposit",
        fromBlock: startBlock,
        args: {
          owner: userAddress,
        },
      }),
      viemClient.createContractEventFilter({
        address: vault.address,
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
      address: vault.address,
      abi: LLAMA_LEND_VAULT_ABI.abi,
      functionName: "balanceOf",
      args: [userAddress],
    });

    const [depositEvents, withdrawEvents, redeemValueRaw] = await Promise.all([
      viemClient.getFilterLogs({
        filter: depositFilter,
      }),
      viemClient.getFilterLogs({
        filter: withdrawFilter,
      }),
      viemClient.readContract({
        address: vault.address,
        abi: LLAMA_LEND_VAULT_ABI.abi,
        functionName: "previewRedeem",
        args: [balanceOfContract],
      }),
    ]);

    const redeemValue = Number(formatUnits(redeemValueRaw, 18));

    let depositedInVault = 0;
    let withdrawFromVault = 0;

    const allLogs = [...depositEvents, ...withdrawEvents];

    allLogs.forEach((log) => {
      if (log.eventName === "Deposit") {
        depositedInVault += Number(formatUnits(log.args.assets ?? 0n, 18));
      } else {
        withdrawFromVault += Number(formatUnits(log.args.assets ?? 0n, 18));
      }
    });

    const events = [
      ...depositEvents.map((event) => ({
        type: EventType.Deposit,
        amount: event.args.assets
          ? Number(formatUnits(event.args.assets, 18))
          : 0,
        hash: event.transactionHash,
        blockNumber: Number(event.blockNumber),
      })),
      ...withdrawEvents.map((event) => ({
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

    const earnings = redeemValue - totalDeposited;

    allVaultsEvents.push({
      vault: vault.address,
      redeemValue,
      earnings,
      collateral: vault.collateral,
      borrowed: vault.borrowed,
      chainId: vault.chainId,
      lendApyPcent: vault.lendApyPcent,
      events: [
        ...depositEvents.map((event) => ({
          type: EventType.Deposit,
          amount: event.args.assets
            ? Number(formatUnits(event.args.assets, 18))
            : 0,
          hash: event.transactionHash,
          blockNumber: Number(event.blockNumber),
        })),
        ...withdrawEvents.map((event) => ({
          type: EventType.Withdraw,
          amount: event.args.assets
            ? Number(formatUnits(event.args.assets, 18))
            : 0,
          hash: event.transactionHash,
          blockNumber: Number(event.blockNumber),
        })),
      ],
    });
  }

  const lastBlock = Math.max(
    ...allVaultsEvents.map((vault) =>
      Math.max(...vault.events.map((event) => event.blockNumber))
    )
  );

  await Promise.all([
    setRedisCacheEntry(redisService, lastUserEventBlockKey, lastBlock),
    setRedisCacheEntry(redisService, cacheKey, allVaultsEvents),
  ]);

  res.status(200).json({
    status: "success",
    allVaultsEvents,
  });
}
