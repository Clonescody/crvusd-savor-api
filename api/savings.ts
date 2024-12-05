import axios from "axios";
import Redis from "ioredis";
import { VercelRequest, VercelResponse } from "@vercel/node";
import { isAddress, formatUnits } from "viem";

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

type CurveApiUserSavingStats = {
  total_deposited: string;
  total_received: string;
  total_withdrawn: string;
  current_balance: string;
};

type CurveApiUserSavingsEvent = {
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
  events: CurveApiUserSavingsEvent[];
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
  chain: string;
};

type UserSavingsData = {
  totalDeposited: number;
  currentBalance: number;
  totalRevenues: number;
  events: Event[];
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
): Promise<CurveApiUserSavingStats | null> => {
  try {
    const statsResponse = await axios.get<CurveApiUserSavingStats>(
      `https://prices.curve.fi/v1/crvusd/savings/${userAddress}/stats`
    );

    return {
      current_balance: formatUnits(
        BigInt(statsResponse.data.current_balance),
        18
      ),
      total_deposited: formatUnits(
        BigInt(statsResponse.data.total_deposited),
        18
      ),
      total_received: formatUnits(
        BigInt(statsResponse.data.total_received),
        18
      ),
      total_withdrawn: formatUnits(
        BigInt(statsResponse.data.total_withdrawn),
        18
      ),
    };
  } catch (error) {
    console.error("Error fetching savings data", error);
    return null;
  }
};

const fetchSavingsEvents = async (userAddress: string): Promise<Event[]> => {
  try {
    let page = 1;
    const eventsResponse = await axios.get<CurveApiUserSavingsEvents>(
      `https://prices.curve.fi/v1/crvusd/savings/${userAddress}/events?page=${page}&per_page=10`
    );

    const { events, count } = eventsResponse.data;
    const allEvents = events;
    while (count % 10 === 0) {
      page++;
      const newEventsData = await axios.get<CurveApiUserSavingsEvents>(
        `https://prices.curve.fi/v1/crvusd/savings/${userAddress}/events?page=${page}&per_page=10`
      );
      allEvents.push(...newEventsData.data.events);
    }

    return allEvents
      .map((event) => ({
        type:
          event.action_type === "deposit"
            ? EventType.Deposit
            : EventType.Withdraw,
        amount: Number(formatUnits(BigInt(event.assets), 18)),
        hash: event.transaction_hash,
        timestamp: new Date(event.timestamp).getTime(),
        chain: "ethereum",
      }))
      .sort((a, b) => b.timestamp - a.timestamp);
  } catch (error) {
    console.error("Error fetching savings events", error);
    return [];
  }
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
    return res.status(400).json({ message: "Invalid user address" });
  }

  const cacheKey = `savings-${userAddress}`;

  const redisService = new Redis(process.env.REDIS_URL);

  const cacheEntry = await getRedisCacheEntry<RedisCacheEntry<UserSavingsData>>(
    redisService,
    cacheKey
  );

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 60)) {
    return res.status(200).json({ ...cacheEntry.data });
  }

  const savingsData = await fetchSavingsData(userAddress);

  if (savingsData === null) {
    return res.status(200).json({
      totalDeposited: 0,
      currentBalance: 0,
      totalRevenues: 0,
      events: [],
    });
  }

  const { total_deposited, current_balance } = savingsData;

  const events = await fetchSavingsEvents(userAddress);

  const currentBalance = Number(current_balance);
  let totalDeposited = Number(total_deposited);
  let totalRevenues = currentBalance - totalDeposited;

  if (currentBalance === 0) {
    totalDeposited = 0;
    const totalDeposits = events
      .filter((event) => event.type === EventType.Deposit)
      .reduce((acc, event) => acc + event.amount, 0);
    const totalWithdrawals = events
      .filter((event) => event.type === EventType.Withdraw)
      .reduce((acc, event) => acc + event.amount, 0);
    totalRevenues = totalWithdrawals - totalDeposits;
  }

  const response: UserSavingsData = {
    totalDeposited,
    totalRevenues,
    currentBalance,
    events,
  };

  await setRedisCacheEntry(redisService, cacheKey, response);

  res.status(200).json({
    ...response,
  });
}
