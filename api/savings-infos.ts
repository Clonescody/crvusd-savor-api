import axios from "axios";
import Redis from "ioredis";
import { VercelRequest, VercelResponse } from "@vercel/node";

type RedisCacheEntry<T> = {
  updateTimestamp: number;
  data: T;
};

type SavingsInfos = {
  tvl: number;
  apr: number;
  url: string;
};

type CurveApiSavingsStats = {
  last_updated: string;
  last_updated_block: number;
  proj_apr: number;
  supply: number;
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

const fetchSavingsStats = async (): Promise<CurveApiSavingsStats> => {
  const statsResponse = await axios.get<CurveApiSavingsStats>(
    `https://prices.curve.fi/v1/crvusd/savings/statistics`
  );

  return statsResponse.data;
};

export default async function GET(req: VercelRequest, res: VercelResponse) {
  res.setHeader("Access-Control-Allow-Credentials", "false");
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");
  if (!process.env.REDIS_URL) {
    return res.status(500).json({
      message: "Redis server URL is not set",
    });
  }

  const cacheKey = `savings-infos`;

  const redisService = new Redis(process.env.REDIS_URL);

  const cacheEntry = await getRedisCacheEntry<RedisCacheEntry<SavingsInfos>>(
    redisService,
    cacheKey
  );

  if (cacheEntry && !isCacheEntryUpdateNeeded(cacheEntry.updateTimestamp, 20)) {
    return res.status(200).json({ ...cacheEntry.data });
  }

  const statsData = await fetchSavingsStats();

  const { proj_apr, supply } = statsData;

  const response: SavingsInfos = {
    tvl: supply,
    apr: proj_apr,
    url: "https://crvusd.curve.fi/#/ethereum/scrvUSD",
  };

  await setRedisCacheEntry(redisService, cacheKey, response);

  res.status(200).json({
    ...response,
  });
}
