import axios from "axios";
import Redis from "ioredis";
import { VercelRequest, VercelResponse } from "@vercel/node";
import { isAddress, formatUnits } from "viem";

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

enum EventType {
  Deposit = "deposit",
  Withdraw = "withdraw",
}

type Event = {
  type: EventType;
  amount: number;
  hash: string;
  timestamp: number;
};

type SavingsData = {
  tvl: number;
  apr: number;
  totalDeposited: number;
  currentBalance: number;
  totalRevenues: number;
  events: Event[];
};

type CurveApiSavingsStats = {
  last_updated: string;
  last_updated_block: number;
  proj_apr: number;
  supply: number;
};

type CurveApiUserSavingStats = {
  total_deposited: string;
  total_received: string;
  total_withdrawn: string;
  current_balance: string;
};

type CurveApiSavingsEvent = {
  action_type: string;
  sender: string;
  owner: string;
  receiver: string;
  assets: string;
  shares: string;
  block_number: number;
  timestamp: string;
  transaction_hash: string;
};

type CurveApiUserSavingsEvents = {
  count: number;
  events: CurveApiSavingsEvent[];
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

const fetchSavingsData = async (
  userAddress: string
): Promise<CurveApiUserSavingStats> => {
  const statsResponse = await axios.get<CurveApiUserSavingStats>(
    `https://prices.curve.fi/v1/crvusd/savings/${userAddress}/stats`
  );

  return statsResponse.data;
};

const fetchSavingsEvents = async (
  userAddress: string,
  page: number
): Promise<CurveApiUserSavingsEvents> => {
  const eventsResponse = await axios.get<CurveApiUserSavingsEvents>(
    `https://prices.curve.fi/v1/crvusd/savings/${userAddress}/events?page=${page}&per_page=10`
  );

  return eventsResponse.data;
};

const fetchSavingsStats = async (): Promise<CurveApiSavingsStats> => {
  const statsResponse = await axios.get<CurveApiSavingsStats>(
    `https://prices.curve.fi/v1/crvusd/savings/statistics`
  );

  return statsResponse.data;
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

  const cacheKey = `savings-${userAddress}`;

  const redisService = new Redis(process.env.REDIS_URL);

  const cacheEntry = await getRedisCacheEntry<RedisCacheEntry<SavingsData>>(
    redisService,
    cacheKey
  );

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 60)) {
    return res.status(200).json({ ...cacheEntry.data });
  }

  let eventsPage = 1;

  const [savingsData, eventsData, statsData] = await Promise.all([
    fetchSavingsData(userAddress),
    fetchSavingsEvents(userAddress, eventsPage),
    fetchSavingsStats(),
  ]);

  const { count, events } = eventsData;
  const { total_deposited, current_balance } = savingsData;
  const { proj_apr, supply } = statsData;

  const allEvents: CurveApiSavingsEvent[] = events;

  while (count % 10 === 0) {
    eventsPage++;
    const newEventsData = await fetchSavingsEvents(userAddress, eventsPage);
    allEvents.push(...newEventsData.events);
  }

  const totalDeposited = Number(formatUnits(BigInt(total_deposited), 18));
  const currentBalance = Number(formatUnits(BigInt(current_balance), 18));

  const totalRevenues = currentBalance - totalDeposited;

  const formattedEvents: Event[] = allEvents.map((event) => ({
    type:
      event.action_type === "deposit" ? EventType.Deposit : EventType.Withdraw,
    amount: Number(formatUnits(BigInt(event.assets), 18)),
    hash: event.transaction_hash,
    timestamp: new Date(event.timestamp).getTime(),
  }));

  const response: SavingsData = {
    totalDeposited,
    totalRevenues,
    currentBalance,
    events: formattedEvents,
    tvl: supply,
    apr: proj_apr,
  };

  await setRedisCacheEntry(redisService, cacheKey, response);

  res.status(200).json({
    ...response,
  });
}
