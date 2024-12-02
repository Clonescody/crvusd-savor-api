# Crvusd savor API

API for the crvUSD savor UI

## Informations

Same as the UI, this API has been made by [Clonescody](https://x.com/Clonescody) and is not an official API maintained by the [Curve](https://curve.fi/) team.

The API however uses the official [Curve API](https://docs.curve.fi/curve-api/curve-api/) to fetch data.

Contributions are welcome !
Contact me on Twitter for any question or to report an issue.

## Install & run

- `Redis` is required to run the API, check installation details [here](https://redis.io/docs/latest/operate/oss_and_stack/install/install-redis/).
- Copy/rename the `.env.example` file to `.env` and fill in the missing values, mainly the RPC URLs.

`Bun` is recommended as it is a banger dependency manager. You can still use `npm` or `yarn` if you wish.

```bash
bun install
```

To simulate the serverless environment, you can run the `vercel dev` command, [more informations here](https://vercel.com/docs/cli/dev).
