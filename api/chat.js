const crypto = require('crypto');

const cache = new Map();
const stats = { l0: 0, l2: 0, l3: 0, l4_gate: 0, l4_groq: 0, l4_error: 0 };

const HARD = /\b(prove|legal|lawsuit|hipaa|medical diagnos|multi-step|architect|refactor|prove that|why does|compare and|derive)\b/i;
const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const PHONE = /\b(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s]?)\d{3}[-.\s]?\d{4}\b/g;

function scrub(text) {
  const map = {};
  let i = 0;
  let out = text.replace(EMAIL, (m) => {
    const t = `[EMAIL_${++i}]`;
    map[t] = m;
    return t;
  });
  out = out.replace(PHONE, (m) => {
    const t = `[PHONE_${++i}]`;
    map[t] = m;
    return t;
  });
  return { out, map };
}

function restore(text, map) {
  let out = text;
  for (const [t, raw] of Object.entries(map)) out = out.split(t).join(raw);
  return out;
}

// Collapse whitespace + invisible/soft-hyphen + curly apostrophe/prime + quote wrappers + trailing punct/ellipsis/dashes + case so format variants reuse L0.
function normalizeAsk(s) {
  return s
    .replace(/[\u200B\u200C\u200D\uFEFF\u00AD]/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\u2018\u2019\u02BC\u2032]/gu, "'")
    .replace(/^["'\u201c\u201d\u2018\u2019]+|["'\u201c\u201d\u2018\u2019]+$/gu, '')
    .trim()
    .replace(/[?.!;:\u2026\u2014\u2013\u2212\-]+$/u, '')
    .toLowerCase();
}

function twinA(q) {
  if (q.length < 80 && !HARD.test(q)) {
    return { escalate: false, text: `Twin-A: ${q.replace(/\?+$/, '')}. Cached path stays local when the ask is bounded.` };
  }
  return { escalate: true, text: 'ESCALATE: ambiguous or high-stakes slice — consult Twin-B' };
}

function twinB(q, a) {
  if (HARD.test(q) || q.length > 220) {
    return { escalate: true, text: 'ESCALATE: Twin-B will not guess on this slice' };
  }
  return { escalate: false, text: `CONFIRM: ${a.text.replace(/^Twin-A:\s*/, '')}` };
}

async function groq(prompt, key) {
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 400,
    }),
  });
  if (!r.ok) throw new Error('groq ' + r.status);
  const j = await r.json();
  return j.choices[0].message.content;
}

module.exports = async (req, res) => {
  if (req.method === 'GET') {
    res.status(200).json({ stats, cache_size: cache.size });
    return;
  }
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const message = String(body.message || '').slice(0, 4000);
  const localOnly = !!body.local_only;
  if (!message) {
    res.status(400).json({ error: 'message required' });
    return;
  }

  // Key + store on scrubbed+normalized tokens so PII/format variants reuse L0.
  const { out: scrubbed0, map } = scrub(message);
  const scrubbed = normalizeAsk(scrubbed0);
  const h = crypto.createHash('sha256').update(scrubbed + '|' + localOnly).digest('hex');
  if (cache.has(h)) {
    stats.l0 += 1;
    res.status(200).json({ layer: 'L0 cache', answer: restore(cache.get(h), map) + '\n\n_[cached]_' });
    return;
  }

  const a = twinA(scrubbed);
  if (!a.escalate) {
    cache.set(h, a.text);
    const ans = restore(a.text, map);
    stats.l2 += 1;
    res.status(200).json({ layer: 'L2 Twin-A', answer: ans });
    return;
  }

  const b = twinB(scrubbed, a);
  if (!b.escalate) {
    cache.set(h, b.text);
    const ans = restore(b.text, map);
    stats.l3 += 1;
    res.status(200).json({ layer: 'L3 Twin-B', answer: ans });
    return;
  }

  const key = process.env.GROQ_API_KEY;
  if (localOnly || !key) {
    // Reuse L0 for repeat escalate+local_only (or no key) — gate answer is stable.
    const ans = 'L4 blocked — LOCAL_ONLY or no GROQ_API_KEY on this host. Rephrase smaller, or set the key and turn LOCAL_ONLY off.';
    cache.set(h, ans);
    stats.l4_gate += 1;
    res.status(200).json({ layer: 'L4 gate', answer: ans });
    return;
  }

  try {
    const big = await groq(scrubbed, key);
    cache.set(h, big + '\n\n_[escalated]_');
    const ans = restore(big, map) + '\n\n_[escalated]_';
    stats.l4_groq += 1;
    res.status(200).json({ layer: 'L4 Groq', answer: ans });
  } catch (e) {
    stats.l4_error += 1;
    res.status(200).json({ layer: 'L4 error', answer: String(e.message || e) });
  }
};
