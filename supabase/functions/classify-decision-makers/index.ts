import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================================
// classify-decision-makers v4
//
// STRICT 5-CATEGORY CLASSIFICATION focused on pipeline decision-makers only.
//
// WHO WE WANT (the people who HIRE in drug development):
//   - CMO, CSO, CEO, COO, CTO at biotech/pharma
//   - VP/SVP/Head of Clinical Development, R&D, Research, Translational Med
//   - VP/Head of Regulatory Affairs
//   - Medical Directors (Clinical Development context only)
//   - Director+ in Clinical Dev, R&D, Translational, Regulatory
//
// WHO WE DO NOT WANT (immediate delete):
//   - MSL, Medical Science Liaison (any level)
//   - VP Marketing, VP Commercial, VP Sales, VP Communications
//   - Medical Affairs (unless Director+ with clinical oversight)
//   - HR, Legal, Finance, IT, Supply Chain, Manufacturing, QA/QC
//   - Field Medical, KAM, Brand Manager, Market Access
//   - Any non-pipeline function regardless of seniority
// ============================================================================

const BATCH_SIZE = 20;
const DEFAULT_LIMIT = 100;

const VALID_CATEGORIES = [
  "research_discovery",
  "translational",
  "development",
  "regulatory_affairs",
  "clevel_biotech",
] as const;

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type",
  };
}

// ============================================================================
// HARDCODED REJECT — these titles are NEVER relevant, skip AI entirely
// ============================================================================
const HARD_REJECT_PATTERNS = [
  // MSL and field medical — ALWAYS irrelevant for us
  /\bmedical\s+science\s+liaison\b/i,
  /\bMSL\b/,
  /\bfield\s+medical\b/i,
  /\bmedical\s+advisor\b/i, // unless Senior/Lead, but too noisy

  // Commercial/Sales/Marketing — never relevant
  /\b(VP|SVP|Head|Director|Sr\.?\s*Director|Senior\s+Director)[\s,]*(of\s+)?(Commercial|Marketing|Sales|Brand|Market\s+Access|Business\s+Development|Corporate\s+Strategy|Communications|PR|Public\s+Relations|Investor\s+Relations)\b/i,
  /\b(Chief\s+Commercial|Chief\s+Marketing|Chief\s+Business|Chief\s+Revenue)\b/i,
  /\b(Key\s+Account|Account\s+Executive|Territory|Brand\s+Manager|Product\s+Manager(?!\s*[-—]\s*Clinical))\b/i,
  /\bKAM\b/,

  // HR/Legal/Finance/IT/Admin
  /\b(VP|SVP|Head|Director|Chief)[\s,]*(of\s+)?(Human\s+Resources|HR|People|Talent\s+Acquisition|Legal|Finance|Financial|Accounting|Information\s+Technology|IT\s+|Digital\s+Transformation|Data\s+(?!Science)|Engineering(?!\s+[-—]\s*(Bio|Drug|Process)))\b/i,
  /\bCHRO\b/i,
  /\bCFO\b/i,
  /\bCIO\b/i,
  /\bGeneral\s+Counsel\b/i,

  // Supply Chain/Manufacturing/CMC/QA — manufacturing ops, not pipeline
  /\b(VP|SVP|Head|Director)[\s,]*(of\s+)?(Supply\s+Chain|Logistics|Procurement|Facilities|Manufacturing(?!\s+Science)|Quality\s+(?:Assurance|Control)|QA\/QC|CMC|Technical\s+Operations|Drug\s+Product|Drug\s+Substance|Process\s+Development)\b/i,

  // Junior/support roles
  /\b(intern|trainee|apprentice|student|coordinator|specialist|analyst|associate(?!\s+director)|assistant|administrator|clerk)\b/i,

  // HEOR/RWE — post-market, not pipeline hiring
  /\bHEOR\b/i,
  /\bReal[\s-]World\s+Evidence\b/i,
  /\bOutcomes\s+Research\b/i,
];

// ============================================================================
// HARDCODED KEEP — these are exactly who we want, classify without AI
// ============================================================================
interface QuickClassification {
  category: typeof VALID_CATEGORIES[number];
  confidence: number;
  reason: string;
}

function tryQuickClassify(headline: string, title: string | null): QuickClassification | null {
  const h = (headline || "").toLowerCase();
  const t = (title || "").toLowerCase();
  const text = `${h} ${t}`;

  // C-suite at biotech/pharma
  if (/\b(ceo|chief\s+executive)\b/i.test(text)) {
    return { category: "clevel_biotech", confidence: 9, reason: "CEO" };
  }
  if (/\b(cmo|chief\s+medical\s+officer)\b/i.test(text) && !/chief\s+marketing/i.test(text)) {
    return { category: "clevel_biotech", confidence: 9, reason: "CMO — Chief Medical Officer" };
  }
  if (/\b(cso|chief\s+scien(ce|tific)\s+officer)\b/i.test(text)) {
    return { category: "clevel_biotech", confidence: 9, reason: "CSO" };
  }
  if (/\b(cto|chief\s+technical\s+officer|chief\s+technology\s+officer)\b/i.test(text)) {
    return { category: "clevel_biotech", confidence: 8, reason: "CTO" };
  }
  if (/\bcoo\b/i.test(text) && /\b(pharma|biotech|therapeutics|biosciences)\b/i.test(text)) {
    return { category: "clevel_biotech", confidence: 8, reason: "COO at pharma/biotech" };
  }
  if (/\bpresident\b/i.test(text) && /\b(r&d|research|development|pipeline|therapeutics)\b/i.test(text)) {
    return { category: "clevel_biotech", confidence: 9, reason: "President R&D" };
  }

  // Clinical Development (Phase III pipeline people)
  if (/\b(vp|svp|evp|head|senior\s+vice\s+president|vice\s+president)[\s,]*(of\s+)?clinical\s+(development|dev)\b/i.test(text)) {
    return { category: "development", confidence: 9, reason: "VP/Head Clinical Development" };
  }
  if (/\b(director|sr\.?\s+director|senior\s+director|executive\s+director)[\s,]*(of\s+)?clinical\s+(development|dev|operations|ops)\b/i.test(text)) {
    return { category: "development", confidence: 8, reason: "Director Clinical Dev/Ops" };
  }
  if (/\bmedical\s+director\b/i.test(text) && /\b(clinical|development|neurology|neuromuscular|trial|program)\b/i.test(text)) {
    return { category: "development", confidence: 8, reason: "Medical Director — Clinical context" };
  }

  // Research & Discovery (Phase I / Preclinical)
  if (/\b(vp|svp|head|vice\s+president)[\s,]*(of\s+)?(research|r&d|discovery|biology|preclinical|pharmacology|drug\s+discovery)\b/i.test(text)) {
    return { category: "research_discovery", confidence: 9, reason: "VP/Head of Research/R&D" };
  }
  if (/\b(director|sr\.?\s+director|senior\s+director)[\s,]*(of\s+)?(research|r&d|discovery|biology|preclinical|pharmacology)\b/i.test(text)) {
    return { category: "research_discovery", confidence: 8, reason: "Director Research/R&D" };
  }

  // Translational Medicine (Phase II bridge)
  if (/\b(vp|svp|head|director|sr\.?\s+director|senior\s+director)[\s,]*(of\s+)?(translational|biomarker|clinical\s+pharmacology|proof\s+of\s+concept)\b/i.test(text)) {
    return { category: "translational", confidence: 8, reason: "Translational Medicine leader" };
  }

  // Regulatory Affairs (post Phase III)
  if (/\b(vp|svp|head|director|sr\.?\s+director|senior\s+director)[\s,]*(of\s+)?regulatory\b/i.test(text)) {
    return { category: "regulatory_affairs", confidence: 8, reason: "Regulatory Affairs leader" };
  }

  return null;
}

// ============================================================================
// AI CLASSIFICATION — only for ambiguous cases
// ============================================================================

interface ProfileForClassification {
  dm_id: string;
  full_name: string;
  headline: string;
  current_title: string | null;
  company_name: string;
  ai_analysis: string | null;
  seniority_level: string | null;
  role_category: string | null;
}

interface ClassificationResult {
  dm_id: string;
  category: string;
  confidence: number;
  reason: string;
}

async function classifyBatch(
  profiles: ProfileForClassification[]
): Promise<ClassificationResult[]> {
  const profilesList = profiles
    .map(
      (p, i) =>
        `${i + 1}. [ID: ${p.dm_id}] ${p.full_name} — "${p.headline || "No headline"}" | Title: ${p.current_title || "unknown"} | Company: ${p.company_name} | Seniority: ${p.seniority_level || "unknown"} | Current category: ${p.role_category || "none"} | AI analysis: ${(p.ai_analysis || "").slice(0, 120)}`
    )
    .join("\n");

  const systemPrompt = `You are a pharma executive search classifier for PharmaTalent, a headhunting firm specialized in neuromuscular disease.

We ONLY care about people who are DECISION MAKERS in the drug development pipeline — the people who HIRE scientists, physicians, and clinical leaders.

Classify each profile into EXACTLY one of these 5 categories, or "other" (= DELETE):

1. "research_discovery" — Phase I / Preclinical leaders: VP/Head/Director of Research, R&D, Discovery, Biology, Pharmacology, Preclinical, Drug Discovery. People who oversee early pipeline.

2. "translational" — Phase II bridge: VP/Head/Director of Translational Medicine, Biomarkers, Clinical Pharmacology, Proof of Concept, DMPK. People bridging discovery to clinical.

3. "development" — Phase III / Clinical: VP/Head/Director of Clinical Development, Clinical Operations, Medical Directors (in clinical dev context), Biostatistics heads. People running clinical programs.

4. "regulatory_affairs" — Post Phase III: VP/Head/Director of Regulatory Affairs, Regulatory Strategy, Submissions only. NOT Medical Affairs generalists. NOT MSLs.

5. "clevel_biotech" — C-suite ONLY: CEO, CSO, CMO (Chief Medical Officer), COO, CTO, President at pharma/biotech. Must be CLEARLY C-suite with pipeline oversight.

"other" = DELETE IMMEDIATELY. This includes ALL of the following:
- MSL / Medical Science Liaison (ANY level — these are field roles, not hiring decision makers)
- Medical Affairs (unless clearly Director+ with clinical development oversight)
- VP/Head of Marketing, Commercial, Sales, Brand, Market Access
- VP/Head of Manufacturing, CMC, Technical Operations, Quality, Supply Chain
- VP/Head of HR, Legal, Finance, IT, Communications, PR, Investor Relations
- HEOR, Real-World Evidence, Outcomes Research
- Field Medical, KAM, Account Managers
- Any title with: coordinator, specialist, analyst, associate (unless Associate Director)
- Business Development, Corporate Strategy, Licensing

CRITICAL RULES:
- "Medical Director" → KEEP only if headline mentions clinical trials, development, neurology, or a specific therapeutic area. DELETE if it's Medical Affairs/MSL context.
- "Head of R&D" at small biotech → "clevel_biotech" (they oversee everything)
- SVP/VP of Clinical → "development" (NOT clevel_biotech)
- Chief Business/Commercial Officer → "other" (DELETE)
- When in doubt about Medical Affairs roles → DELETE. We don't want MSLs.
- Seniority minimum: Associate Director for big pharma, Director for biotech.

Return JSON: {"results": [{"dm_id": "...", "category": "...", "confidence": 1-10, "reason": "short"}]}`;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Classify these ${profiles.length} profiles:\n\n${profilesList}` },
        ],
        temperature: 0,
        max_tokens: 3000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      console.error(`[CLASSIFY] OpenAI ${response.status}`);
      return [];
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";
    const parsed = JSON.parse(content);
    const results: ClassificationResult[] = Array.isArray(parsed)
      ? parsed
      : parsed.results || parsed.classifications || parsed.data || [];

    return results;
  } catch (error) {
    console.error("[CLASSIFY] Error:", error);
    return [];
  }
}

// ============================================================================
// MAIN
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const company = url.searchParams.get("company");
  const ta_id = url.searchParams.get("ta_id");
  const dryRun = url.searchParams.get("dry_run") === "true";
  const limit = Math.min(parseInt(url.searchParams.get("limit") || String(DEFAULT_LIMIT)), 200);
  const offset = parseInt(url.searchParams.get("offset") || "0");

  console.log(`[MAIN] classify-decision-makers v4 | limit=${limit} offset=${offset} dry_run=${dryRun} company=${company}`);

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
    if (!supabaseUrl || !supabaseKey) throw new Error("Missing Supabase credentials");

    const supabase = createClient(supabaseUrl, supabaseKey);

    // ── STEP 1: Count total for pagination ──
    let countQuery = supabase
      .from("decision_makers")
      .select("dm_id", { count: "exact", head: true });

    if (company) countQuery = countQuery.ilike("company_name", `%${company}%`);
    if (ta_id) countQuery = countQuery.eq("therapeutic_area_id", ta_id);

    const { count: totalCount } = await countQuery;

    // ── STEP 2: Fetch chunk of profiles ──
    let query = supabase
      .from("decision_makers")
      .select("dm_id, full_name, headline, current_title, company_name, ai_analysis, seniority_level, role_category")
      .order("created_at", { ascending: true })
      .range(offset, offset + limit - 1);

    if (company) query = query.ilike("company_name", `%${company}%`);
    if (ta_id) query = query.eq("therapeutic_area_id", ta_id);

    const { data: profiles, error: fetchError } = await query;
    if (fetchError) throw new Error(`DB fetch: ${fetchError.message}`);

    const allProfiles = (profiles || []) as ProfileForClassification[];
    console.log(`[MAIN] Fetched ${allProfiles.length} profiles (offset ${offset}, total ${totalCount})`);

    if (allProfiles.length === 0) {
      return new Response(
        JSON.stringify({
          success: true, version: 4, message: "No more profiles to classify",
          pagination: { offset, limit, total: totalCount || 0, has_more: false },
        }),
        { status: 200, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
      );
    }

    // ── STEP 3: Three-pass classification ──
    const hardRejected: { profile: ProfileForClassification; reason: string }[] = [];
    const quickClassified: { profile: ProfileForClassification; result: QuickClassification }[] = [];
    const needsAI: ProfileForClassification[] = [];

    for (const p of allProfiles) {
      const headline = p.headline || "";
      const title = p.current_title || "";
      const fullText = `${headline} ${title}`;

      // Pass 1: Hard reject
      let rejected = false;
      for (const pattern of HARD_REJECT_PATTERNS) {
        if (pattern.test(fullText)) {
          hardRejected.push({ profile: p, reason: `Hard reject: ${pattern}` });
          rejected = true;
          break;
        }
      }
      if (rejected) continue;

      // Pass 2: Quick classify known-good titles
      const quick = tryQuickClassify(headline, title);
      if (quick) {
        quickClassified.push({ profile: p, result: quick });
        continue;
      }

      // Pass 3: Needs AI
      needsAI.push(p);
    }

    console.log(`[MAIN] Hard rejected: ${hardRejected.length}, Quick classified: ${quickClassified.length}, Needs AI: ${needsAI.length}`);

    // ── STEP 4: AI classify ambiguous profiles ──
    const aiClassifications: ClassificationResult[] = [];
    const totalBatches = Math.ceil(needsAI.length / BATCH_SIZE);

    for (let i = 0; i < needsAI.length; i += BATCH_SIZE) {
      const batch = needsAI.slice(i, i + BATCH_SIZE);
      const batchNum = Math.floor(i / BATCH_SIZE) + 1;
      console.log(`[CLASSIFY] Batch ${batchNum}/${totalBatches} (${batch.length} profiles)`);

      const results = await classifyBatch(batch);
      aiClassifications.push(...results);

      if (i + BATCH_SIZE < needsAI.length) {
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // ── STEP 5: Merge all results ──
    const toKeep: { dm_id: string; category: string; confidence: number; reason: string }[] = [];
    const toDelete: { dm_id: string; name: string; headline: string; reason: string }[] = [];

    // Add quick-classified as keeps
    for (const { profile, result } of quickClassified) {
      toKeep.push({
        dm_id: profile.dm_id,
        category: result.category,
        confidence: result.confidence,
        reason: `Quick: ${result.reason}`,
      });
    }

    // Add hard-rejected as deletes
    for (const { profile, reason } of hardRejected) {
      toDelete.push({
        dm_id: profile.dm_id,
        name: profile.full_name,
        headline: profile.headline || "",
        reason,
      });
    }

    // Process AI results
    const aiMap = new Map(aiClassifications.map(c => [c.dm_id, c]));
    for (const p of needsAI) {
      const classification = aiMap.get(p.dm_id);
      if (!classification) {
        // Unclassified by AI — conservative delete
        toDelete.push({ dm_id: p.dm_id, name: p.full_name, headline: p.headline || "", reason: "AI did not classify — ambiguous profile" });
        continue;
      }

      if (VALID_CATEGORIES.includes(classification.category as any)) {
        toKeep.push(classification);
      } else {
        toDelete.push({ dm_id: p.dm_id, name: p.full_name, headline: p.headline || "", reason: classification.reason || "AI classified as other" });
      }
    }

    console.log(`[MAIN] Keep: ${toKeep.length}, Delete: ${toDelete.length}`);

    // ── STEP 6: Apply changes ──
    let updatedCount = 0;
    let deletedCount = 0;
    let updateErrors = 0;

    // Update keepers
    for (let i = 0; i < toKeep.length; i += 10) {
      const batch = toKeep.slice(i, i + 10);
      const promises = batch.map((c) =>
        supabase
          .from("decision_makers")
          .update({
            profile_category: c.category,
            role_category: c.category,
            updated_at: new Date().toISOString(),
          })
          .eq("dm_id", c.dm_id)
      );

      const results = await Promise.allSettled(promises);
      for (const r of results) {
        if (r.status === "fulfilled" && !r.value.error) updatedCount++;
        else updateErrors++;
      }
    }

    // Delete others
    if (!dryRun && toDelete.length > 0) {
      for (let i = 0; i < toDelete.length; i += 30) {
        const batch = toDelete.slice(i, i + 30);
        const ids = batch.map((c) => c.dm_id);
        const { error } = await supabase.from("decision_makers").delete().in("dm_id", ids);
        if (error) {
          console.error(`[DELETE] ${error.message}`);
          updateErrors++;
        } else {
          deletedCount += batch.length;
        }
      }
    }

    // ── STEP 7: Response ──
    const categoryBreakdown: Record<string, number> = {};
    for (const c of toKeep) {
      categoryBreakdown[c.category] = (categoryBreakdown[c.category] || 0) + 1;
    }

    const deletionSample = toDelete.slice(0, 20).map((d) => ({
      name: d.name,
      headline: d.headline,
      reason: d.reason,
    }));

    const duration = Math.round((Date.now() - startTime) / 1000);
    const hasMore = offset + limit < (totalCount || 0);

    const response = {
      success: true,
      version: 4,
      dry_run: dryRun,
      company_filter: company || "all",
      total_profiles_in_chunk: allProfiles.length,
      classification_method: {
        hard_rejected: hardRejected.length,
        quick_classified: quickClassified.length,
        ai_classified: aiClassifications.length,
        ai_unclassified: needsAI.length - aiClassifications.length,
      },
      pagination: {
        offset,
        limit,
        total: totalCount || 0,
        has_more: hasMore,
        next_offset: hasMore ? offset + limit : null,
      },
      results: {
        kept: toKeep.length,
        deleted: dryRun ? 0 : deletedCount,
        would_delete: dryRun ? toDelete.length : undefined,
        update_errors: updateErrors,
      },
      category_breakdown: {
        research_discovery: categoryBreakdown["research_discovery"] || 0,
        translational: categoryBreakdown["translational"] || 0,
        development: categoryBreakdown["development"] || 0,
        regulatory_affairs: categoryBreakdown["regulatory_affairs"] || 0,
        clevel_biotech: categoryBreakdown["clevel_biotech"] || 0,
      },
      deletion_sample: deletionSample,
      duration_seconds: duration,
    };

    // Save diagnostics
    try {
      await supabase.from("edge_function_diagnostics").insert({
        function_name: "classify-decision-makers",
        version: 4,
        company_name: company || `ALL (offset ${offset})`,
        diagnostics: response,
      });
    } catch (_e) { /* ignore */ }

    console.log(`[MAIN] Done. ${duration}s. Has more: ${hasMore}`);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[MAIN] Fatal:", error);
    return new Response(
      JSON.stringify({ success: false, error: (error as Error).message, version: 4 }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }
});
