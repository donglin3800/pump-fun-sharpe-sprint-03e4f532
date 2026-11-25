// Rider + probe paper bot for the Pump.fun Sharpe Sprint.
//
// The ranking metric is the hourly Sharpe ratio, and the prize needs net PnL
// above zero, so the bot needs a few large, high-quality wins and a broad,
// cheap base of round trips. Two halves do those two jobs:
//
//  - RIDER. A coin whose real SOL reserve climbs past 52 SOL is close to the
//    ~85 SOL completion level and has already survived every earlier dump;
//    the run to completion is the steepest part of its curve. The bot scales
//    into such a coin up to 1 SOL across batches (each reply is capped at 1%
//    of real SOL, so the stake is built in adds), then lets it run with a
//    partial take-profit (+30%, half out), a full take-profit (+60%), a hard
//    stop (-20%), and a trailing stop (15%) armed once the trade is up 30%.
//    On the dev window this half earns about +3.2 SOL from 21 coins.
//  - PROBES. The rider alone trades too few coins for the 20-mint guardrail
//    in a 6-hour final window, so a dip-snap sleeve buys 0.02 SOL tickets
//    into shallow pullbacks of young coins that already ran 30% (age under
//    60 slots, dip 2-15% off the young high, buyers still stepping in,
//    creator has not sold), cutting losers at once on -3% of cost, which sits
//    just inside the ~2.9% fee drag of a fresh position. It trades about 118
//    coins on the dev window for about -0.02 SOL: breadth at the price of
//    the fees, which is exactly what the guardrail needs.
//
// Probes never take the last two position slots, so a rider entry always has
// room. Nothing here reads the clock, randomness, or the environment: every
// decision is a pure function of the batches the harness sends, so the two
// graded runs agree byte for byte.
import { runBot } from './vendor/makefun-bot.ts';
import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAM = 1e9;
const CURVE_FEE = 0.0125;
const MAX_POSITIONS = 5;
const MAX_PROBE_POSITIONS = 3;

// --- rider tunables ---------------------------------------------------------
const RIDER_THRESHOLD_SOL = 52; // real SOL at which a coin becomes a rider
const RIDER_TARGET_SOL = 1.0; // total SOL into one rider, across adds
const RIDER_CAP_FACTOR = 0.99; // buy at most this share of the per-reply cap
const RIDER_TP1 = 0.3; // partial take-profit at cost * 1.30
const RIDER_TP1_PART = 0.5; // share of tokens sold at the partial
const RIDER_TP_FULL = 0.6; // sell all at cost * 1.60
const RIDER_STOP = 0.2; // sell all at cost * 0.80
const RIDER_TRAIL_ARM = 0.3; // arm the trailing stop at cost * 1.30
const RIDER_TRAIL = 0.15; // exit when value falls 15% below its peak
const RIDER_MAX_HOLD = 3600; // slots
const RIDER_STALE = 300; // exit when no trade for this many slots

// --- probe tunables ---------------------------------------------------------
const PROBE_STAKE = 0.02; // SOL per probe ticket
const PROBE_MAX_AGE = 60; // slots since first trade
const PROBE_MIN_RISE = 0.3; // up at least 30% from first-seen price
const PROBE_MIN_DIP = 0.02; // down at least 2% from its young high
const PROBE_MAX_DIP = 0.15; // no deeper than 15%
const PROBE_MIN_BUYERS = 3;
const PROBE_MIN_RECENT_BUYS = 3; // of the last 5 trades
const PROBE_MIN_REAL_SOL = 0.2;
const PROBE_MAX_REAL_SOL = 40;
const PROBE_TP = 0.04;
const PROBE_SL = 0.03;
const PROBE_MAX_HOLD = 120;
const PROBE_STALE = 60;
const PROBE_COOLDOWN = 100; // slots before a coin may be probed again
const PROBE_BUY_SLIP = 800;
const PROBE_SELL_SLIP = 10_000;

interface Coin {
  kind: 'probe' | 'rider' | null;
  // probe tape
  firstPrice: number;
  high: number;
  firstSlot: number;
  lastTradeSlot: number;
  recent: boolean[];
  buyers: Set<string>;
  creatorSold: boolean;
  cooldownUntil: number;
  // rider state
  crossed: boolean;
  invested: number; // SOL sent in rider buys
  peakValue: number;
  partialTaken: boolean;
  openedSlot: number;
  rejected: boolean;
}

function newCoin(): Coin {
  return {
    kind: null,
    firstPrice: 0,
    high: 0,
    firstSlot: -1,
    lastTradeSlot: -1,
    recent: [],
    buyers: new Set(),
    creatorSold: false,
    cooldownUntil: 0,
    crossed: false,
    invested: 0,
    peakValue: 0,
    partialTaken: false,
    openedSlot: -1,
    rejected: false,
  };
}

const coins = new Map<Pubkey, Coin>();

const bot: Bot = {
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const now = batch.slot;
    const coinOf = (mint: Pubkey): Coin => {
      let c = coins.get(mint);
      if (!c) { c = newCoin(); coins.set(mint, c); }
      return c;
    };
    const txFee = Number(state.txFeeLamports()) / LAM;
    const valueOf = (mint: Pubkey): number => {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (!pos || !curve) return 0;
      const tokens = Number(pos.token_amount);
      const vq = Number(curve.virtual_quote_reserves);
      const vt = Number(curve.virtual_token_reserves);
      return ((tokens * vq) / (vt + tokens) / LAM) * (1 - CURVE_FEE) - txFee;
    };
    const cap = state.hello.caps.max_orders_per_batch;
    const orders: OrderInput[] = [];
    const pending = new Set<Pubkey>();
    for (const po of state.pending.values()) pending.add(po.order.mint);

    for (const f of batch.fills) {
      if (f.status === 'rejected' && f.side === 'buy') coinOf(f.mint).rejected = true;
    }

    // Fold the batch into per-coin tapes. TradeEventRecord carries is_buy,
    // user, virtual_*_reserves and real_quote_reserves; there is no .side
    // or .price_sol_per_token on the events the harness sends.
    for (const e of batch.events) {
      if (e.event !== 'TradeEvent') continue;
      const c = coinOf(e.mint);
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (c.firstSlot < 0) { c.firstSlot = e.slot; c.firstPrice = price; c.high = price; }
      if (price > c.high) c.high = price;
      c.lastTradeSlot = e.slot;
      if (e.is_buy) {
        c.buyers.add(e.user);
        c.recent.push(true);
      } else {
        c.recent.push(false);
        const curve = state.curves.get(e.mint);
        if (curve && e.user === curve.creator) c.creatorSold = true;
      }
      if (c.recent.length > 5) c.recent.shift();
      if (Number(e.real_quote_reserves) / LAM >= RIDER_THRESHOLD_SOL) c.crossed = true;
    }

    const openRiders = () => [...state.positions.keys()].filter((m) => coinOf(m).kind === 'rider').length;
    const openProbes = () => [...state.positions.keys()].filter((m) => coinOf(m).kind === 'probe').length;
    // Entries placed this batch are not in state.positions yet; count them
    // too, so one busy batch can never promise more slots than exist.
    let placedRiders = 0;
    let placedProbes = 0;

    // --- rider exits and adds (priority) ---
    for (const [mint, pos] of state.positions) {
      const c = coinOf(mint);
      if (c.kind !== 'rider') continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const value = valueOf(mint);
      const cost = Number(pos.cost_lamports) / LAM;
      if (value > c.peakValue) c.peakValue = value;
      let share = 0;
      if (value >= cost * (1 + RIDER_TP_FULL)) share = 1;
      else if (!c.partialTaken && value >= cost * (1 + RIDER_TP1)) share = RIDER_TP1_PART;
      else if (value <= cost * (1 - RIDER_STOP)) share = 1;
      else if (c.peakValue >= cost * (1 + RIDER_TRAIL_ARM) && value <= c.peakValue * (1 - RIDER_TRAIL)) share = 1;
      else if (now - c.openedSlot > RIDER_MAX_HOLD) share = 1;
      else if (now - c.lastTradeSlot > RIDER_STALE) share = 1;
      if (share > 0) {
        if (pending.has(mint) || orders.length >= cap) continue;
        const tokens = BigInt(pos.token_amount);
        const amount = share >= 1 ? tokens : (tokens * BigInt(Math.round(share * 1000))) / 1000n;
        if (amount <= 0n) continue;
        orders.push({ side: 'sell', mint, token_amount: amount, max_slippage_bps: PROBE_SELL_SLIP });
        if (share < 1) c.partialTaken = true;
        continue;
      }
      if (c.rejected || c.invested >= RIDER_TARGET_SOL) continue;
      if (pending.has(mint) || orders.length >= cap) continue;
      const rq = Number(curve.real_quote_reserves) / LAM;
      if (rq < RIDER_THRESHOLD_SOL) continue;
      const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAM) * RIDER_CAP_FACTOR;
      let amount = Math.min(capSol, RIDER_TARGET_SOL - c.invested);
      const free = Number(state.freeCashLamports()) / LAM;
      if (amount > free - txFee) amount = free - txFee;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: 1500 });
      c.invested += amount;
    }

    // --- probe exits ---
    for (const [mint, pos] of state.positions) {
      const c = coinOf(mint);
      if (c.kind !== 'probe') continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const value = valueOf(mint);
      const cost = Number(pos.cost_lamports) / LAM;
      const stale = now - c.lastTradeSlot > PROBE_STALE;
      const held = now - c.openedSlot > PROBE_MAX_HOLD;
      if (value >= cost * (1 + PROBE_TP) || value <= cost * (1 - PROBE_SL) || stale || held) {
        if (pending.has(mint) || orders.length >= cap) continue;
        orders.push({ side: 'sell', mint, token_amount: BigInt(pos.token_amount), max_slippage_bps: PROBE_SELL_SLIP });
        c.cooldownUntil = now + PROBE_COOLDOWN;
        c.kind = null;
      }
    }

    // --- rider fresh entries ---
    let free = Number(state.freeCashLamports()) / LAM;
    for (const e of batch.events) {
      if (orders.length >= cap) break;
      if (e.event !== 'TradeEvent') continue;
      const mint = e.mint;
      const c = coins.get(mint);
      if (!c || !c.crossed || c.invested > 0 || c.rejected || c.kind !== null) continue;
      if (state.positions.has(mint) || pending.has(mint)) continue;
      if (openRiders() + placedRiders + openProbes() + placedProbes >= MAX_POSITIONS) break;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const rq = Number(curve.real_quote_reserves) / LAM;
      if (rq < RIDER_THRESHOLD_SOL) continue;
      const capSol = (Math.floor(Number(state.maxBuyLamports(mint))) / LAM) * RIDER_CAP_FACTOR;
      let amount = Math.min(capSol, RIDER_TARGET_SOL);
      if (amount > free - txFee) amount = free - txFee;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: 1500 });
      free -= amount + txFee;
      placedRiders += 1;
      c.invested += amount;
      c.openedSlot = now;
      c.peakValue = 0;
      c.kind = 'rider';
    }

    // --- probe fresh entries ---
    for (const e of batch.events) {
      if (orders.length >= cap) break;
      if (e.event !== 'TradeEvent') continue;
      if (openProbes() + placedProbes >= MAX_PROBE_POSITIONS) break;
      if (openRiders() + placedRiders + openProbes() + placedProbes >= MAX_POSITIONS) break;
      const mint = e.mint;
      const c = coins.get(mint);
      if (!c || c.kind !== null || c.invested > 0) continue;
      if (c.crossed) continue; // rider territory, not a probe
      if (state.positions.has(mint) || pending.has(mint)) continue;
      if (now < c.cooldownUntil) continue;
      if (!e.is_buy) continue;
      if (c.creatorSold) continue;
      const age = now - c.firstSlot;
      if (age < 0 || age > PROBE_MAX_AGE) continue;
      const curve = state.curves.get(mint);
      if (!curve || curve.complete) continue;
      const rq = Number(curve.real_quote_reserves) / LAM;
      if (rq < PROBE_MIN_REAL_SOL || rq > PROBE_MAX_REAL_SOL) continue;
      const price = Number(e.virtual_quote_reserves) / Number(e.virtual_token_reserves);
      if (c.firstPrice <= 0) continue;
      const rise = price / c.firstPrice - 1;
      if (rise < PROBE_MIN_RISE) continue;
      const dip = 1 - price / c.high;
      if (dip < PROBE_MIN_DIP || dip > PROBE_MAX_DIP) continue;
      if (c.buyers.size < PROBE_MIN_BUYERS) continue;
      if (c.recent.filter(Boolean).length < PROBE_MIN_RECENT_BUYS) continue;
      const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAM;
      let amount = Math.min(capSol, PROBE_STAKE);
      if (amount > free - txFee) amount = free - txFee;
      if (amount < 0.01) continue;
      orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAM)), max_slippage_bps: PROBE_BUY_SLIP });
      free -= amount + txFee;
      placedProbes += 1;
      c.openedSlot = now;
      c.kind = 'probe';
    }

    return orders;
  },
};

await runBot(bot);
