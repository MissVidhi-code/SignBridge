/**
 * asl.js — ASL Fingerspelling Classifier 
 *
 * Input : the 21 MediaPipe hand landmarks (each has x, y, z, values 0-1).
 * Output: { letter: 'A', confidence: 0.85 }  or  { letter: null, confidence: 0 }
 *
 * Landmark numbers:
 *   0 wrist
 *   1-4   thumb   (cmc, mcp, ip, tip)
 *   5-8   index   (mcp, pip, dip, tip)
 *   9-12  middle
 *   13-16 ring
 *   17-20 pinky
 *
 * HONEST LIMITS
 *  - A, S, E, T, N, M are all "fists" that differ only by where the thumb is
 *    tucked. A single camera cannot always separate them. Treat these as the
 *    least reliable; the Teach mode in app.js is the fix for any letter
 *    that keeps being misread for YOUR hand.
 *  - Thresholds below are sensible starting values. Tune them for your camera.
 */

// ── Tunable thresholds ─────────────────────────────────────────────────────
const ASL_UP          = 1.55;  // finger counts as "extended" above this ratio
const ASL_BENT_MIN    = 1.25;  // between this and ASL_UP = bent (hooked / curved)
const ASL_CURVE_MIN   = 1.30;  // curved-hand (C, O) average ratio range
const ASL_CURVE_MAX   = 1.75;
const ASL_CURVE_SPREAD= 0.35;  // fingers must be curved about equally for C / O
const ASL_THUMB_OUT   = 0.65;  // thumb tip this far (in hand sizes) from index knuckle = "out"
const ASL_TOUCH       = 0.32;  // tips closer than this count as touching
const ASL_TOGETHER    = 0.30;  // two fingertips closer than this = held together (U vs V)

const ASL_TRAIL_MS    = 1400;  // how much finger motion is remembered
const ASL_LATCH_MS    = 1700;  // a detected J / Z stays reported this long, so the
                               // 1.5 s hold timer in app.js can finish

// ── Small geometry helpers ─────────────────────────────────────────────────
function aslD(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);        // 2D: MediaPipe's z is noisy
}

// Which way a finger points on screen: 'up', 'down' or 'side'.
function aslDirection(lm, mcp, tip) {
  const dx = lm[tip].x - lm[mcp].x;
  const dy = lm[tip].y - lm[mcp].y;
  const len = Math.hypot(dx, dy) || 1e-6;
  if (dy / len < -0.6) return 'up';
  if (dy / len >  0.6) return 'down';
  return 'side';
}

// ── Measure the hand once per frame ────────────────────────────────────────
function aslMeasure(lm) {
  const S = aslD(lm[0], lm[9]) || 1e-6;                  // hand size: wrist -> middle knuckle
  const n = (a, b) => aslD(lm[a], lm[b]) / S;            // distance in "hand sizes"

  // Extension ratio per finger: (wrist -> tip) / (wrist -> knuckle).
  //   ~0.8-1.2 = curled into the palm,  ~1.8 = fully straight.
  const ratioOf = (mcp, tip) => aslD(lm[0], lm[tip]) / (aslD(lm[0], lm[mcp]) || 1e-6);
  const r  = [ratioOf(5, 8), ratioOf(9, 12), ratioOf(13, 16), ratioOf(17, 20)];
  const up = r.map(v => v > ASL_UP);
  const avg    = (r[0] + r[1] + r[2] + r[3]) / 4;
  const spreadR = Math.max(...r) - Math.min(...r);

  // Thumb position INSIDE the palm, so it does not depend on which hand it is:
  //   tv: 0 = at the index knuckle, 1 = at the pinky knuckle (negative = outside the palm)
  //   tu: 0 = at the wrist,         1 = at the knuckle line  (bigger = toward fingertips)
  const ux = (lm[9].x - lm[0].x) / S, uy = (lm[9].y - lm[0].y) / S;
  const wx = lm[17].x - lm[5].x,      wy = lm[17].y - lm[5].y;
  const W  = Math.hypot(wx, wy) || 1e-6;
  const vx = wx / W, vy = wy / W;
  const tv = ((lm[4].x - lm[5].x) * vx + (lm[4].y - lm[5].y) * vy) / W;
  const tu = ((lm[4].x - lm[0].x) * ux + (lm[4].y - lm[0].y) * uy) / S;

  // Is the thumb in FRONT of the fingers (closer to the camera)? Used for S.
  const pipZ = (lm[6].z + lm[10].z + lm[14].z + lm[18].z) / 4;
  const dz   = (lm[4].z - pipZ) / S;                      // negative = nearer camera

  return {
    S, n, r, up, avg, spreadR, tu, tv, dz,
    thumbOut: n(4, 5) > ASL_THUMB_OUT,
    dirIdx: aslDirection(lm, 5, 8)
  };
}

// ── Static (hand-shape) rules ──────────────────────────────────────────────
// Returns {letter, confidence} and, for motion letters, a `motion` hint:
//   motion: 'J' -> this is an "I" shape that might be drawing a J
//   motion: 'Z' -> this is a pointing finger (or a D) that might be drawing a Z
function aslClassifyStatic(lm, m) {
  const tI = m.n(4, 8);     // thumb tip -> index tip
  const tM = m.n(4, 12);    // thumb tip -> middle tip
  const tR = m.n(4, 16);    // thumb tip -> ring tip
  const none = { letter: null, confidence: 0 };

  // ── C and O: the whole hand is curved, all four fingers about equally ──
  if (m.avg >= ASL_CURVE_MIN && m.avg <= ASL_CURVE_MAX && m.spreadR < ASL_CURVE_SPREAD) {
    if (tI < 0.38)  return { letter: 'O', confidence: 0.80 };   // fingertips meet the thumb
    if (tI <= 1.20) return { letter: 'C', confidence: 0.78 };   // open "C" gap
  }

  // ── X: only the index finger is hooked (bent), the rest are in a fist ──
  // (upper bound is ASL_UP so "hooked" never overlaps "extended")
  if (m.r[0] >= ASL_BENT_MIN && m.r[0] < ASL_UP &&
      m.r[1] < ASL_BENT_MIN && m.r[2] < ASL_BENT_MIN && m.r[3] < ASL_BENT_MIN) {
    return { letter: 'X', confidence: 0.72 };
  }

  // Group everything else by WHICH fingers are extended (index, middle, ring, pinky).
  const key = m.up.map(v => (v ? 1 : 0)).join('');

  switch (key) {

    // Only the index finger extended: D, L, G, Q (or a pointer for Z)
    case '1000':
      if (m.dirIdx === 'down') return { letter: 'Q', confidence: 0.70 };  // G pointing down
      if (m.dirIdx === 'side') return { letter: 'G', confidence: 0.74 };  // index sideways
      if (m.thumbOut)          return { letter: 'L', confidence: 0.86 };  // 90-degree L
      // D and Z start from the same hand shape (index pointing, thumb on the
      // other fingers). Report D, but keep tracking the index tip so a Z
      // drawn in the air can override it.
      if (tM < 0.40)           return { letter: 'D', confidence: 0.80, motion: 'Z' };
      return { letter: null, confidence: 0, motion: 'Z' };                // maybe drawing Z

    // Index + middle extended: H, P, R, K, U, V
    case '1100': {
      const gap = m.n(8, 12);
      if (m.dirIdx === 'down') return { letter: 'P', confidence: 0.72 };  // K pointing down
      if (m.dirIdx === 'side') {
        return gap < ASL_TOGETHER ? { letter: 'H', confidence: 0.75 } : none;
      }
      // Crossed fingers: the tips are in the opposite left/right order to the knuckles.
      const crossed = (lm[5].x - lm[9].x) * (lm[8].x - lm[12].x) < 0 && gap < 0.35;
      if (crossed) return { letter: 'R', confidence: 0.77 };
      // K: spread like a V but the thumb touches the middle finger.
      if (gap > ASL_TOGETHER && m.n(4, 10) < 0.45) return { letter: 'K', confidence: 0.74 };
      return gap < ASL_TOGETHER ? { letter: 'U', confidence: 0.80 }
                                : { letter: 'V', confidence: 0.82 };
    }

    // Index + middle + ring extended
    case '1110':
      return { letter: 'W', confidence: 0.80 };

    // Index NOT extended (touching thumb), the other three up
    case '0111':
      return tI < ASL_TOUCH ? { letter: 'F', confidence: 0.75 } : none;

    // Only the pinky extended: Y (thumb out) or I (maybe drawing J)
    case '0001':
      if (m.thumbOut) return { letter: 'Y', confidence: 0.83 };
      return { letter: 'I', confidence: 0.84, motion: 'J' };

    // All four extended: B (thumb folded across the palm)
    case '1111':
      return m.thumbOut ? none : { letter: 'B', confidence: 0.83 };

    // Fist family: A, S, E, T, N, M, told apart by where the thumb sits.
    case '0000':
      if (m.tv < 0.10 && m.tu > 0.70) return { letter: 'A', confidence: 0.80 };  // thumb along the side
      if (m.dz < -0.15)               return { letter: 'S', confidence: 0.72 };  // thumb across the front
      if (tI < 0.35 && tM < 0.35 && tR < 0.40 && m.tu < 0.90)
                                      return { letter: 'E', confidence: 0.70 };  // fingertips on thumb
      if (m.tv < 0.32)                return { letter: 'T', confidence: 0.70 };  // thumb between index & middle
      if (m.tv < 0.55)                return { letter: 'N', confidence: 0.70 };  // thumb under two fingers
      return { letter: 'M', confidence: 0.70 };                                  // thumb under three fingers
  }

  return none;
}

// ── Motion tracking for J and Z ────────────────────────────────────────────
let aslTrail = [];        // recent fingertip positions {t, x, y} (x, y in hand sizes)
let aslTrailKey = null;   // 'J' or 'Z' while tracking
let aslLatch = null;      // { letter, confidence, until }

function aslTrackReset() { aslTrail = []; aslTrailKey = null; }

function aslTrack(key, tip, S) {
  if (aslTrailKey !== key) { aslTrail = []; aslTrailKey = key; }
  const now = Date.now();
  aslTrail.push({ t: now, x: tip.x / S, y: tip.y / S });
  while (aslTrail.length && now - aslTrail[0].t > ASL_TRAIL_MS) aslTrail.shift();
}

// Z = three strokes: across, diagonal back, across again (either direction).
function aslLooksLikeZ(p) {
  if (p.length < 12) return false;
  const a = p[0];
  const b = p[Math.floor(p.length / 3)];
  const c = p[Math.floor((2 * p.length) / 3)];
  const d = p[p.length - 1];
  const dx1 = b.x - a.x, dx2 = c.x - b.x, dx3 = d.x - c.x;
  const dy2 = c.y - b.y, dyAll = d.y - a.y;
  return Math.abs(dx1) > 0.3 && Math.abs(dx2) > 0.3 && Math.abs(dx3) > 0.3 &&
         Math.sign(dx1) === Math.sign(dx3) && Math.sign(dx1) === -Math.sign(dx2) &&
         dy2 > 0.12 && dyAll > 0.15;                 // diagonal goes DOWN
}

// J = pinky goes down, then hooks back up and sideways.
function aslLooksLikeJ(p) {
  if (p.length < 10) return false;
  let iB = 0;
  for (let i = 1; i < p.length; i++) if (p[i].y > p[iB].y) iB = i;   // lowest point
  const last = p[p.length - 1];
  const down = p[iB].y - p[0].y;
  const hookX = Math.abs(last.x - p[iB].x);
  const hookUp = p[iB].y - last.y;
  return iB < p.length - 2 && down > 0.45 && hookX > 0.20 && hookUp > 0.08;
}

// ── Public function used by app.js ─────────────────────────────
function classifyASL(lm) {
  const now = Date.now();

  // A recently detected J / Z keeps being reported so the hold timer can finish.
  if (aslLatch && now < aslLatch.until) {
    return { letter: aslLatch.letter, confidence: aslLatch.confidence };
  }
  aslLatch = null;

  const m = aslMeasure(lm);
  const res = aslClassifyStatic(lm, m);

  if (res.motion) {
    const tipIdx = res.motion === 'J' ? 20 : 8;        // pinky tip for J, index tip for Z
    aslTrack(res.motion, lm[tipIdx], m.S);
    const found = res.motion === 'J' ? aslLooksLikeJ(aslTrail) : aslLooksLikeZ(aslTrail);
    if (found) {
      aslLatch = { letter: res.motion, confidence: 0.82, until: now + ASL_LATCH_MS };
      aslTrackReset();
      return { letter: res.motion, confidence: 0.82 };
    }
  } else {
    aslTrackReset();
  }
  return { letter: res.letter, confidence: res.confidence };
}
