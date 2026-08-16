/**
 * llm.js
 * ------
 * JS port of the Python llm_service.py pipeline: decompose input text into
 * short atomic claims, search per-claim evidence, judge each claim against
 * its own evidence, then synthesize a markdown report + numeric trust score.
 *
 * Runs directly on the Render middleware (no laptop/vision-node needed) —
 * this is why text fact-checking stays available even when the image
 * pipeline is offline.
 */

const Groq = require('groq-sdk');
const axios = require('axios');

const GROQ_MODEL = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
// URL of the small ddgs_service.py FastAPI wrapper (see ddgs_service.py).
// Runs as its own lightweight service — no torch, no GPU — so it can
// live on Render alongside/independent of the main middleware.
const DDGS_SERVICE_URL = process.env.DDGS_SERVICE_URL;
const DDGS_SERVICE_SECRET = process.env.DDGS_SERVICE_SECRET;

let _client = null;
function getClient() {
  if (!_client) {
    if (!process.env.GROQ_API_KEY) {
      throw new Error('GROQ_API_KEY is not set in this process\'s environment.');
    }
    _client = new Groq({ apiKey: process.env.GROQ_API_KEY });
  }
  return _client;
}

async function groqJsonCall(prompt) {
  const client = getClient();
  const completion = await client.chat.completions.create({
    model: GROQ_MODEL,
    messages: [{ role: 'user', content: prompt }],
    temperature: 0.0,
    response_format: { type: 'json_object' },
  });
  const raw = completion.choices[0].message.content;
  return JSON.parse(raw);
}

async function decomposeClaim(claimText) {
  const prompt = `Break the following text down into 2 to 5 'Atomic Claims'.

RULES for atomic claims:
- Each claim must be a SHORT, single-fact sentence (under 20 words).
- Each claim must be independently verifiable on its own — do not require context from other claims to understand it (e.g. spell out names/dates instead of using pronouns).
- Strip out incidental/navigational text (e.g. Wikipedia sidebar content, citation markers like [1], 'From Wikipedia' boilerplate) and only extract genuine factual assertions.
- For EACH claim, also write a short, targeted web search query (3-8 words) that would find sources to verify that SPECIFIC claim.

Target Text: "${claimText}"

Respond ONLY with a valid JSON object matching this schema:
{"claims": [{"claim": "string", "search_query": "string"}]}`;

  try {
    const parsed = await groqJsonCall(prompt);
    let claims = parsed.claims;
    if (!Array.isArray(claims) || claims.length === 0) {
      throw new Error('empty claims list');
    }
    claims = claims.filter((c) => c && c.claim && c.search_query);
    if (claims.length === 0) {
      throw new Error('no valid claim/search_query pairs');
    }
    return claims;
  } catch (err) {
    const fallbackClaim = claimText.trim().slice(0, 150);
    return [{ claim: fallbackClaim, search_query: fallbackClaim.slice(0, 60) }];
  }
}

async function fetchWebEvidence(searchQuery, maxResults = 3) {
  if (!searchQuery) return [];
  if (!DDGS_SERVICE_URL) {
    console.error('[llm.js] DDGS_SERVICE_URL is not set — cannot fetch web evidence.');
    return [];
  }

  // Render free-tier services occasionally return an instant 502 on
  // inter-service calls even when the target service is fully healthy
  // (confirmed by comparing ddgs_service's own logs, which show zero
  // failures for the exact same requests — this is a Render-side
  // networking quirk between two free-tier services, not a real outage
  // or cold start). A short delay + a few quick retries handles this
  // far better than a long timeout, since these failures happen in
  // under 50ms — waiting longer doesn't help, retrying does.
  const TRANSIENT_HTTP_STATUSES = new Set([502, 503, 504]);
  const TRANSIENT_ERROR_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ECONNABORTED']);
  const attempts = [
    { timeoutMs: 20000, delayBeforeMs: 0 },
    { timeoutMs: 20000, delayBeforeMs: 300 },
    { timeoutMs: 45000, delayBeforeMs: 800 }, // longer budget as a last resort, in case it IS a real cold start
  ];

  let lastErrorDetail = null;

  for (let i = 0; i < attempts.length; i++) {
    const { timeoutMs, delayBeforeMs } = attempts[i];
    if (delayBeforeMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, delayBeforeMs));
    }
    const attemptStart = Date.now();
    try {
      console.log(
        `[llm.js] ddgs_service attempt ${i + 1}/${attempts.length} for "${searchQuery}" (timeout ${timeoutMs}ms)`
      );
      const resp = await axios.post(
        `${DDGS_SERVICE_URL}/search`,
        { query: searchQuery, max_results: maxResults },
        {
          headers: DDGS_SERVICE_SECRET ? { 'X-Service-Secret': DDGS_SERVICE_SECRET } : {},
          timeout: timeoutMs,
        }
      );

      const elapsedMs = Date.now() - attemptStart;
      console.log(`[llm.js] ddgs_service attempt ${i + 1} succeeded in ${elapsedMs}ms`);

      const { results, note } = resp.data;
      if (note) {
        console.log(`[llm.js] ddgs_service note for "${searchQuery}": ${note}`);
      }
      return (results || []).map((r) => ({ title: r.title, url: r.url, body: r.body }));
    } catch (err) {
      const elapsedMs = Date.now() - attemptStart;
      const httpStatus = err.response ? err.response.status : null;
      lastErrorDetail = err.response
        ? `HTTP ${httpStatus}`
        : `${err.code || 'unknown'}: ${err.message}`;

      console.error(
        `[llm.js] ddgs_service attempt ${i + 1} FAILED after ${elapsedMs}ms — ${lastErrorDetail}`
      );

      const isTransient =
        (httpStatus && TRANSIENT_HTTP_STATUSES.has(httpStatus)) ||
        (err.code && TRANSIENT_ERROR_CODES.has(err.code));
      const hasAttemptsLeft = i < attempts.length - 1;

      if (isTransient && hasAttemptsLeft) {
        console.log(`[llm.js] Treating "${lastErrorDetail}" as transient (likely cold start) — retrying...`);
        continue;
      }
      break;
    }
  }

  console.error(`[llm.js] ddgs_service request ultimately failed for "${searchQuery}": ${lastErrorDetail}`);
  return [];
}

async function evaluateSingleClaim(claim, evidenceList) {
  const contextStr = evidenceList.length === 0
    ? 'No web results were found for this claim.'
    : evidenceList
        .map((item, idx) => `\n[Source #${idx + 1}]: ${item.title}\nURL: ${item.url}\nContent: ${item.body}\n---`)
        .join('');

  const prompt = `You are a strict Natural Language Inference (NLI) judge. Your core directive is to PREVENT hallucination.

CLAIM TO VERIFY:
${claim}

WEB EVIDENCE (specific to this claim):
${contextStr}

RULES: Assign ONE status:
- SUPPORTED: The evidence explicitly proves the claim.
- REFUTED: The evidence explicitly contradicts the claim.
- NOT_ENOUGH_INFO: The evidence is irrelevant or lacks data to prove the claim.

Respond ONLY with a valid JSON object matching this exact schema:
{"status": "SUPPORTED|REFUTED|NOT_ENOUGH_INFO", "rationale": "Brief explanation of your ruling, referencing which source (if any)", "source_quote": "The exact sentence/quote from the evidence that proves your point (or empty string if none)"}`;

  try {
    const parsed = await groqJsonCall(prompt);
    let status = parsed.status;
    if (!['SUPPORTED', 'REFUTED', 'NOT_ENOUGH_INFO'].includes(status)) {
      status = 'NOT_ENOUGH_INFO';
    }
    return {
      claim,
      status,
      rationale: parsed.rationale || '',
      source_quote: parsed.source_quote || '',
    };
  } catch (err) {
    return {
      claim,
      status: 'NOT_ENOUGH_INFO',
      rationale: `Evaluation stage failed to return a structured verdict: ${err.message}`,
      source_quote: '',
    };
  }
}

function computeTrustScore(evaluatedClaims) {
  if (!evaluatedClaims || evaluatedClaims.length === 0) {
    return { score: null, label: 'NO_CLAIMS', coverage: 0 };
  }

  const total = evaluatedClaims.length;
  const supported = evaluatedClaims.filter((c) => c.status === 'SUPPORTED').length;
  const refuted = evaluatedClaims.filter((c) => c.status === 'REFUTED').length;
  const unverified = total - supported - refuted;

  const rawScore = 50 + (supported / total) * 50 - (refuted / total) * 70;
  const score = Math.max(0, Math.min(100, Math.round(rawScore)));
  const coverage = Math.round(((supported + refuted) / total) * 100) / 100;

  let label;
  if (refuted > 0) {
    label = 'LOW_TRUST';
  } else if (coverage < 0.34) {
    label = 'INSUFFICIENT_EVIDENCE';
  } else if (score >= 75) {
    label = 'HIGH_TRUST';
  } else if (score >= 50) {
    label = 'MODERATE_TRUST';
  } else {
    label = 'LOW_TRUST';
  }

  return {
    score,
    label,
    coverage,
    supported_count: supported,
    refuted_count: refuted,
    unverified_count: unverified,
    total_claims: total,
  };
}

function synthesizeReport(evaluatedClaims) {
  let report = '## \u{1F4CB} VERDICT STATUS\n\n';
  const statuses = evaluatedClaims.map((c) => c.status);

  if (statuses.includes('REFUTED')) {
    report += '**\u{1F6A8} CONTAINS FALSEHOODS** - One or more claims were explicitly refuted by the evidence.\n\n';
  } else if (statuses.length > 0 && statuses.every((s) => s === 'SUPPORTED')) {
    report += '**\u2705 VERIFIED** - All extracted claims are securely supported by the web evidence.\n\n';
  } else if (statuses.includes('SUPPORTED')) {
    report += '**\u26A0\uFE0F PARTIALLY VERIFIED** - Some claims are supported, but others lack sufficient evidence in the current index.\n\n';
  } else {
    report += '**\u2753 UNVERIFIED** - The search returned irrelevant data or lacks enough specific information to prove the claims.\n\n';
  }

  report += '---\n\n## \u2696\uFE0F EVIDENCE ANALYSIS\n\n';
  for (const item of evaluatedClaims) {
    const icon = item.status === 'SUPPORTED' ? '\u2705' : item.status === 'REFUTED' ? '\u274C' : '\u26A0\uFE0F';
    report += `### ${icon} ${item.status}\n`;
    report += `**Claim:** ${item.claim}\n`;
    report += `**Rationale:** ${item.rationale}\n`;
    const quote = (item.source_quote || '').trim();
    if (quote) report += `> ${quote}\n`;

    if (item.evidence && item.evidence.length > 0) {
      report += '\n**Sources checked for this claim:**\n';
      item.evidence.forEach((ev, idx) => {
        report += `${idx + 1}. [${ev.title}](${ev.url})\n`;
      });
    }
    report += '\n---\n\n';
  }

  return report;
}

/**
 * Full pipeline entry point. Returns { report, trustScore, claims }.
 */
async function runFactCheck(claimText) {
  const claims = await decomposeClaim(claimText);

  const evaluatedClaims = [];
  for (const item of claims) {
    const evidenceList = await fetchWebEvidence(item.search_query);
    const result = await evaluateSingleClaim(item.claim, evidenceList);
    result.evidence = evidenceList;
    evaluatedClaims.push(result);
  }

  const report = synthesizeReport(evaluatedClaims);
  const trustScore = computeTrustScore(evaluatedClaims);

  return { report, trustScore, claims: evaluatedClaims };
}

module.exports = { runFactCheck };