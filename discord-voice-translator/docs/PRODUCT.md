# VocaLink as a product

> Paid plans are built but switched off. VocaLink is free for everyone, and the website shows no prices. The sections below describe how to turn plans on later.

VocaLink comes in two forms that share one website and one look:

| | VocaLink Lite (website) | VocaLink for Discord (bot) |
|---|---|---|
| Where | [vocalinktest.vercel.app](https://vocalinktest.vercel.app) | Any Discord server it is added to |
| Who it is for | One person following a call or a room | A whole voice channel |
| Speech recognition | Deepgram, with the visitor's own key | Soniox, paid by VocaLink |
| Translation | Google Translate (free) or Claude with the visitor's key | Soniox |
| Voice | The visitor's browser | Each listener's device on Free and Plus; ElevenLabs on Pro |
| Cost to VocaLink | Nothing | Soniox, ElevenLabs on Pro, and Railway |
| Payment | Free | Free (optional paid plans via Discord's app shop, off by default) |

## How someone pays

```
website "For Discord" panel
   │  Free  → Discord's add-app screen (bot invite)
   │  Plus / Pro → the plan's page in Discord's app shop (until the shop is set up: the invite)
   ▼
Discord adds VocaLink to the server
   │  the bot posts a welcome with the steps and Discord's own purchase buttons
   ▼
purchase inside Discord (Discord charges, handles tax, refunds and cancelling)
   │  Discord sends the bot an entitlement for that server
   ▼
the plan unlocks at once; /plan shows it, with hours used and left
```

VocaLink never handles card details or keeps its own accounts. Discord tells the bot which servers own which plan:

- when the bot starts, it fetches every active purchase;
- the gateway reports new, changed and cancelled purchases as they happen;
- every slash command carries the server's current purchases.

## Plans

Plans are per server and reset at the start of each calendar month (UTC).

| Plan | Price (set in Discord) | Hours a month | Voices |
|---|---|---|---|
| Free | $0 | 3 | each listener's device reads translations aloud |
| Plus | $9.99 | 30 | same as Free |
| Pro | $29.99 | 60 | natural ElevenLabs voices, and a speaker's own cloned voice with consent |

The hours count speech the bot actually sends for translation, not time spent in the channel. When a server runs out, the bot stops translating, explains why and shows the upgrade buttons. It warns once when 10 minutes are left.

Rough cost per hour of speech, two server languages:

| Plan | Cost per hour | Worst case if every hour is used |
|---|---|---|
| Free | about $0.24 (Soniox) | about $0.72 a month |
| Plus | about $0.24 | about $7.20 against $8.50 after Discord's 15% cut |
| Pro | about $0.24 plus ElevenLabs | depends on the ElevenLabs plan; at about $3.50 an hour, 60 full hours would cost more than the price |

Most groups use far fewer hours than they are allowed, but Pro is the plan to watch. Its hours can be lowered with `PLAN_PRO_HOURS`, or its price raised in Discord, without changing code.

Until the shop SKUs are configured, plans are off and every server is unlimited, which is how the bot worked before.

## Setting up the Discord shop (owner's steps)

These steps happen in the Discord Developer Portal and need the account that owns the app.

1. **Team.** Move the app to a team (Developer Portal → Teams); Discord's shop works with team-owned apps.
2. **Verification.** Complete App Verification if the Monetization page asks for it.
3. **Legal links.** Under General Information, set:
   - Terms of Service URL: `https://vocalinktest.vercel.app/terms/`
   - Privacy Policy URL: `https://vocalinktest.vercel.app/privacy/`
4. **Payouts.** Open Monetization, accept the terms and set up payouts. If your country is not eligible yet, Discord says so here, and the rest of the product keeps working on Free.
5. **SKUs.** Create two server subscription SKUs, "VocaLink Plus" and "VocaLink Pro", with the prices above, and publish them.
6. **Bot.** Copy the two SKU ids into Railway as `SKU_PLUS` and `SKU_PRO`.
7. **Website.** Put the same ids in `VL.sku` at the bottom of `index.html` in the website repository, so the Plus and Pro buttons open the shop pages.
8. **Test.** Members of the app's team can buy the SKUs in test mode without being charged. Do that in a test server, then run `/plan` there.

## Settings

| Variable | Default | What it does |
|---|---|---|
| `SKU_PLUS`, `SKU_PRO` | empty | Discord shop SKU ids; plans are enforced only once one is set |
| `PLAN_FREE_HOURS`, `PLAN_PLUS_HOURS`, `PLAN_PRO_HOURS` | 3, 30, 60 | monthly hours per plan |
| `PRIVACY_URL`, `TERMS_URL` | empty | linked from the notice the bot posts when translation starts |

## Code map

| Part | Where |
|---|---|
| Plans, purchases and usage | `edge/src/billing/Billing.ts` |
| Purchase events, `/plan`, limits, welcome message, upgrade buttons | `edge/src/discord/bot.ts` |
| Usage metering and skipping AI voices on cheaper plans | `edge/src/worker/CloudWorker.ts` (`onAudio`, `aiVoice`) |
| Device voices in the personal translator | `edge/src/web/static/listen.html` (`deviceSpeak`) |
| Website, Lite translator, Discord panel, terms and privacy | the `VocaLink_test` repository |
