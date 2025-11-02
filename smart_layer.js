// smart_layer.js
// CommonJS version
function evaluateSignal(item, type, config) {
  // config: dynamic_config.json content
  // stats: optional from learning engine (winrates etc.)
  const out = { confirm: false, score: 0, reasons: [] };

  // SAFE default thresholds (will be overridden by config.FUTURE if exists)
  const FUT = (config.FUTURE || {});
  const VOL_MULT_SAFE = FUT.VOL_MULT_SAFE ?? 1.8;
  const VOL_MULT_AGGR = FUT.VOL_MULT_AGGR ?? 1.4;
  const FUNDING_MAX_SAFE = FUT.FUNDING_MAX_SAFE ?? 0.005;
  const FUNDING_MAX_AGGR = FUT.FUNDING_MAX_AGGR ?? 0.01;
  const RSI_MIN = FUT.RSI_MIN ?? 55;
  const EMA_SL_BUFFER = FUT.EMA_SL_BUFFER ?? 0.015;
  const LEADER_MIN = (config.LEADER_MIN || 0.5);

  // gather input
  const price = Number(item.price || 0);
  const ema20 = Number(item.ema20 || price);
  const ema50 = Number(item.ema50 || price);
  const vol = Number(item.vol || 0);
  const volAvg20 = Number(item.volAvg20 || 1);
  const rsi = Number(item.rsi_h1 || item.rsi || 50);
  const funding = Number(item.funding || 0);
  const oi = Number(item.oi || 0);
  const oiPrev = Number(item.oiPrev || oi);
  const taker = Number(item.takerBuyRatio || 0);
  const leaderScore = Number(item.leaderScore || 0);

  // quick helpers
  const volRatio = volAvg20 > 0 ? vol / volAvg20 : 1;
  const breakEMA = price > ema20 && ema20 > ema50;
  const oiUp = oiPrev > 0 ? (oi / oiPrev) : 1;

  // Score components (0..1)
  let score = 0;
  // 1) Price structure (EMA break)
  if (breakEMA) { score += 0.25; out.reasons.push('EMA break'); }

  // 2) Volume (higher weight)
  if (volRatio >= VOL_MULT_AGGR) { score += 0.3; out.reasons.push('Vol strong (aggr)'); }
  else if (volRatio >= VOL_MULT_SAFE) { score += 0.18; out.reasons.push('Vol strong (safe)'); }

  // 3) RSI
  if (rsi >= RSI_MIN) { score += 0.12; out.reasons.push(`RSI ${rsi}`); }

  // 4) Funding / OI behaviour (smartmoney)
  // prefer funding negative or lightly positive but OI rising: accumulation -> flip pattern
  if (funding < 0 && oiUp > 1.02) { score += 0.18; out.reasons.push('Funding neg + OI up'); }
  else if (funding >= 0 && funding <= FUNDING_MAX_AGGR && oiUp >= 1.01) { score += 0.12; out.reasons.push('Funding flip / OI up'); }
  else if (funding > FUNDING_MAX_SAFE) { score -= 0.15; out.reasons.push('Funding high (FOMO)'); }

  // 5) Taker buy ratio (market aggression)
  if (taker >= 0.58) { score += 0.08; out.reasons.push(`TakerBuy ${Math.round(taker*100)}%`); }

  // 6) Leader score (optional)
  if (leaderScore && leaderScore >= LEADER_MIN) { score += 0.12; out.reasons.push('LeaderScore OK'); }

  // normalize score roughly to 0..1.2
  if (score < 0) score = Math.max(0, score);
  if (score > 1.2) score = 1.2;
  out.score = Math.round(score * 100) / 100;

  // Decide confirm rules based on type + two-mode (aggressive / safe)
  // If "FUTURE" detection type, use FUT thresholds; else use generic thresholds
  const confirmThresholdSafe = config.CONFIRM_SAFE_THRESHOLD ?? 0.7; // require >=0.7
  const confirmThresholdAgg = config.CONFIRM_AGGR_THRESHOLD ?? 0.55; // more lenient

  // Determine mode guess (if volRatio >= aggr -> aggressive candidate)
  const modeGuess = volRatio >= VOL_MULT_AGGR ? 'AGGRESSIVE' : (volRatio >= VOL_MULT_SAFE ? 'SAFE' : 'NONE');

  // Final decision
  if (modeGuess === 'AGGRESSIVE' && out.score >= confirmThresholdAgg) {
    out.confirm = true;
    out.mode = 'AGGRESSIVE';
  } else if (modeGuess === 'SAFE' && out.score >= confirmThresholdSafe) {
    out.confirm = true;
    out.mode = 'SAFE';
  } else {
    out.confirm = false;
    out.mode = modeGuess;
  }

  // Extra tag: if funding flip and score decent -> boost reason
  if ((funding >= 0 && funding <= FUNDING_MAX_AGGR) && oiUp > 1.03) {
    out.reasons.push('Funding flip + OI strong');
    out.score = Math.min(1.2, out.score + 0.08);
  }

  // Provide quick guidance for trade size (simple)
  if (out.mode === 'AGGRESSIVE') out.recommendSize = 'small';
  else if (out.mode === 'SAFE') out.recommendSize = 'normal';
  else out.recommendSize = 'hold';

  return out;
}
export { evaluateSignal };
