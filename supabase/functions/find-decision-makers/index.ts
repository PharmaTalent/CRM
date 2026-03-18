import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import {
  createClient, SearchPerson, PreFilteredPerson, EnrichedPerson, DatabasePerson, CompanyRecord,
  RAPIDAPI_KEY, RAPIDAPI_HOST, _diag,
  normalizeCompanyName, delay, extractLinkedInUsername, corsHeaders
} from "./types.ts";
import { setupCompanyAndTA, searchAllPeople, expandKeywords } from "./search.ts";

// ============================================================================
// v21: STRICT DECISION-MAKER FOCUS
//
// Changes from v20:
// 1. Hardcoded REJECT patterns — instantly remove MSLs, Marketing, HR, etc.
// 2. Hardcoded BOOST patterns — CMO, CSO, VP Clinical, Head of R&D get +50
// 3. Rewritten AI pre-filter prompt — laser-focused on pipeline DMs
// 4. Pre-filter now happens AFTER hard reject (saves AI tokens)
// ============================================================================

// ============================================================================
// HARD REJECT — these people are NEVER relevant, skip immediately
// ============================================================================
const HARD_REJECT_PATTERNS = [
  /\bmedical\s+science\s+liaison\b/i,
  /\bMSL\b/,
  /\bfield\s+medical\b/i,
  /\b(sales|marketing|commercial|brand|market\s+access|communications|PR|public\s+relations|investor\s+relations)\s*(director|vp|head|manager|lead|representative|executive)\b/i,
  /\b(director|vp|head|svp|evp)\s*(of\s+)?(sales|marketing|commercial|brand|communications|PR|public\s+relations|investor\s+relations)\b/i,
  /\b(chief\s+commercial|chief\s+marketing|chief\s+revenue|chief\s+business)\b/i,
  /\b(key\s+account|account\s+executive|territory\s+manager|brand\s+manager)\b/i,
  /\bKAM\b/,
  /\b(HR|human\s+resources|talent\s+acquisition|recruiter|people\s+operations)\b/i,
  /\b(legal|general\s+counsel|compliance\s+officer|patent)\b/i,
  /\b(finance|accounting|controller|treasurer|CFO|CIO|CHRO)\b/i,
  /\b(IT\s+|information\s+technology|data\s+engineer|software\s+engineer|devops|cloud)\b/i,
  /\b(supply\s+chain|logistics|procurement|warehouse|facilities)\b/i,
  /\b(intern|trainee|apprentice|student|junior|entry[\s-]level|graduate\s+program)\b/i,
  /\b(coordinator|specialist|analyst|associate(?!\s+director)|assistant|administrator|clerk)\b/i,
  /\bHEOR\b/i,
  /\breal[\s-]world\s+evidence\b/i,
  /\b(medical\s+writer|medical\s+information|medical\s+advisor)\b/i,
];

// ============================================================================
// BOOST PATTERNS — these are exactly who we want, boost their score
// ============================================================================
const BOOST_PATTERNS: { pattern: RegExp; boost: number; label: string }[] = [
  // C-suite — top priority
  { pattern: /\b(CEO|Chief\s+Executive)\b/i, boost: 60, label: "CEO" },
  { pattern: /\b(CMO|Chief\s+Medical\s+Officer)\b/i, boost: 60, label: "CMO" },
  { pattern: /\b(CSO|Chief\s+Scien(ce|tific)\s+Officer)\b/i, boost: 60, label: "CSO" },
  { pattern: /\bPresident\b/i, boost: 50, label: "President" },

  // VP/Head of pipeline functions — exactly who hires
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?Clinical\s+(Dev|Development)\b/i, boost: 55, label: "VP/Head Clinical Dev" },
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?(Research|R&D|Discovery)\b/i, boost: 55, label: "VP/Head R&D" },
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?Regulatory\b/i, boost: 50, label: "VP/Head Regulatory" },
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?Translational\b/i, boost: 50, label: "VP/Head Translational" },
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?(Neurology|Neuroscience|Neuromuscular)\b/i, boost: 55, label: "VP/Head Neuro" },
  { pattern: /\b(VP|SVP|Head)\s*(of\s+)?Medical\s+Affairs\b/i, boost: 40, label: "VP/Head Medical Affairs" },

  // Director-level pipeline roles
  { pattern: /\b(Senior\s+Director|Sr\.?\s+Director|Executive\s+Director)\s*(of\s+)?Clinical\b/i, boost: 45, label: "Sr Director Clinical" },
  { pattern: /\b(Senior\s+Director|Sr\.?\s+Director|Executive\s+Director)\s*(of\s+)?(Research|R&D)\b/i, boost: 45, label: "Sr Director R&D" },
  { pattern: /\bMedical\s+Director\b/i, boost: 35, label: "Medical Director" },

  // Neuromuscular/neurology keywords in any leadership title
  { pattern: /\b(neuro(muscular|logy|science)|NMD|ALS|SMA|DMD|myasthenia|neuropathy)\b/i, boost: 30, label: "NMD keyword" },
];

function applyHardFilters(people: SearchPerson[]): { kept: SearchPerson[]; rejected: number } {
  let rejected = 0;
  const kept: SearchPerson[] = [];

  for (const person of people) {
    const text = `${person.fullName} ${person.headline}`;
    let isRejected = false;

    for (const pattern of HARD_REJECT_PATTERNS) {
      if (pattern.test(text)) {
        isRejected = true;
        rejected++;
        console.log(`[REJECT] ${person.fullName}: "${person.headline}" — matched ${pattern}`);
        break;
      }
    }

    if (!isRejected) {
      // Apply boosts
      for (const { pattern, boost, label } of BOOST_PATTERNS) {
        if (pattern.test(text)) {
          person.scoringBoost += boost;
          console.log(`[BOOST +${boost}] ${person.fullName}: ${label}`);
        }
      }
      kept.push(person);
    }
  }

  return { kept, rejected };
}

// ============================================================================
// STAGE 2: AI PRE-FILTER (REWRITTEN — strict pipeline focus)
// ============================================================================

async function preFilterPeople(
  people: SearchPerson[],
  enrichTopCount: number,
  expandedKeywords: string[]
): Promise<PreFilteredPerson[]> {
  console.log(`[STAGE 2] Pre-filtering ${people.length} people with GPT-4o...`);

  const peopleDisplay = people
    .map((p) => {
      let displayHeadline = p.headline;
      if (p.searchRound === "leadership_page") {
        displayHeadline = `⭐ From Leadership Page: ${displayHeadline}`;
      }
      if (p.searchRound === "job_informed") {
        displayHeadline = `🎯 Job-Informed Match: ${displayHeadline}`;
      }
      if (p.scoringBoost >= 25) {
        displayHeadline = `🔑 Boosted (${p.scoringBoost}): ${displayHeadline}`;
      }
      return `- ${p.fullName}: ${displayHeadline} (found in: ${p.searchRound}, boost: ${p.scoringBoost})`;
    })
    .join("\n");

  const userPrompt = `Here are ${people.length} people from LinkedIn:\n\n${peopleDisplay}\n\nSelect the top ${Math.min(enrichTopCount, people.length)} DECISION-MAKERS for our neuromuscular disease executive search firm. Return valid JSON only: { selected: [ { name, headline, profileUrl, pre_filter_score (1-100), rationale } ] }`;

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
          {
            role: "system",
            content: `You are a senior pharmaceutical executive search analyst for PharmaTalent, a headhunting firm specializing in neuromuscular disease (NMD).

YOUR ONLY JOB: Identify the DECISION MAKERS — the people who HIRE physicians, scientists, and clinical leaders in drug development.

== WHO WE WANT (ALWAYS SELECT) ==
Tier 1 (score 90-100):
- CMO, CSO, CEO, COO at any pharma/biotech with NMD pipeline
- VP/SVP/Head of Clinical Development
- VP/SVP/Head of Research & Development / R&D
- VP/SVP/Head of Neurology / Neuroscience / Neuromuscular
- President of R&D or Therapeutics

Tier 2 (score 75-89):
- VP/Head of Translational Medicine
- VP/Head of Regulatory Affairs
- Senior Director / Executive Director of Clinical Development
- Senior Director / Executive Director of R&D / Research
- Medical Director (ONLY if in clinical development or neurology context)

Tier 3 (score 60-74):
- Director of Clinical Development / Clinical Operations (senior level)
- Director of Research / R&D
- Director of Regulatory Affairs
- Program/Asset Lead for NMD programs

== WHO WE DO NOT WANT (NEVER SELECT) ==
- MSL / Medical Science Liaison — ANY level, ANY company. These are field roles. REJECT.
- VP/Director of Marketing, Commercial, Sales, Brand, Market Access
- VP/Director of Manufacturing, CMC, Technical Ops, Quality, Supply Chain
- VP/Director of HR, Legal, Finance, IT, Communications
- Medical Affairs generalists without clear clinical dev oversight
- Medical Advisor, Medical Writer, Medical Information
- HEOR, Real-World Evidence, Outcomes Research
- Any coordinator, specialist, analyst, associate (unless Associate Director)
- Business Development, Licensing, Corporate Strategy

== SCORING RULES ==
- People marked with ⭐ (leadership page) get +15 to base score
- People marked with 🎯 (job-informed match) get +20 to base score
- People marked with 🔑 (keyword boosted) — trust the boost score
- "Head of R&D" at a small biotech = treat as C-suite (score 95)
- Medical Director = ONLY keep if headline explicitly mentions clinical trials, clinical development, neurology, or a therapeutic area
- Any doubt about Medical Affairs vs Clinical Dev → REJECT

Return only valid JSON.`,
          },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 4000,
        response_format: { type: "json_object" },
      }),
    });

    if (!response.ok) {
      throw new Error(`OpenAI returned ${response.status}`);
    }

    const data = await response.json();
    const content = data.choices?.[0]?.message?.content || "{}";

    let jsonStr = content;
    const jsonMatch = content.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const parsed = JSON.parse(jsonStr);
    const selected = (parsed.selected || []) as PreFilteredPerson[];

    console.log(`[STAGE 2] AI selected ${selected.length} people for enrichment`);

    return selected;
  } catch (error) {
    console.error("[STAGE 2] Pre-filter error:", error);
    return people
      .sort((a, b) => b.scoringBoost - a.scoringBoost)
      .slice(0, enrichTopCount)
      .map((p) => ({
        name: p.fullName,
        headline: p.headline,
        profileUrl: p.profileURL,
        pre_filter_score: 50 + p.scoringBoost,
        rationale: "Fallback selection",
      }));
  }
}

// ============================================================================
// STAGE 3: DEEP ENRICHMENT (v19: parallel in batches of 3)
// ============================================================================

async function enrichPerson(
  person: PreFilteredPerson,
  allPeople: Map<string, SearchPerson>
): Promise<EnrichedPerson | null> {
  console.log(`[STAGE 3] Enriching: ${person.name}`);

  try {
    const profileUrl = new URL(
      `https://${RAPIDAPI_HOST}/get-profile-data-by-url`
    );
    profileUrl.searchParams.set("url", person.profileUrl);

    const profileResponse = await fetch(profileUrl.toString(), {
      method: "GET",
      headers: {
        "x-rapidapi-key": RAPIDAPI_KEY,
        "x-rapidapi-host": RAPIDAPI_HOST,
      },
    });

    if (!profileResponse.ok) {
      console.warn(`[STAGE 3] Failed to fetch profile for ${person.name}`);
      return null;
    }

    const profileData = await profileResponse.json();
    const profile = profileData?.data || profileData;

    const enrichmentPrompt = `Analyze this LinkedIn profile for a NEUROMUSCULAR DISEASE executive search firm. We recruit decision-makers who HIRE in the drug development pipeline.

Return valid JSON:
{
  current_title: string,
  current_company: string,
  seniority_level: one of "C-suite", "SVP", "VP", "Senior Director", "Director", "Associate Director", "Manager", "Other",
  years_experience: integer estimate,
  education: [{degree, field, school}],
  clinical_trials_experience: boolean,
  leadership_experience: boolean,
  neuromuscular_experience: boolean,
  neurology_experience: boolean,
  therapeutic_areas: [strings],
  key_skills: [strings],
  career_highlights: "2-3 sentences focusing on pipeline leadership, clinical programs managed, and team-building experience",
  ai_analysis: "3-4 sentences on why this person is relevant as a HIRING decision-maker in NMD drug development. What teams do they build? What programs do they oversee?",
  ai_fit_score: 1-10 (10 = CMO/CSO/VP Clinical at NMD company, 1 = irrelevant),
  outreach_hook: "one sentence connecting their specific work to our NMD talent expertise — reference a specific asset, program, or milestone if visible",
  role_category: one of "c_suite", "vp_leadership", "director", "associate_director", "other",
  indication_specialty: "specific disease area if visible",
  kol_score: 0-10
}

SCORING GUIDANCE:
- 9-10: C-suite or VP/Head at company with NMD pipeline, directly oversees hiring
- 7-8: Senior Director+ in Clinical/R&D at pharma with NMD relevance
- 5-6: Director-level in pipeline function, some NMD adjacency
- 3-4: Pipeline-relevant but no NMD connection
- 1-2: Not a pipeline decision-maker

Profile:
${JSON.stringify(profile, null, 2).slice(0, 4000)}`;

    const enrichResponse = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${Deno.env.get("OPENAI_API_KEY")}`,
      },
      body: JSON.stringify({
        model: "gpt-4o",
        messages: [
          { role: "system", content: "You analyze LinkedIn profiles for a neuromuscular disease executive search firm. Return valid JSON only." },
          { role: "user", content: enrichmentPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      }),
    });

    if (!enrichResponse.ok) {
      console.warn(`[STAGE 3] OpenAI enrichment failed for ${person.name}`);
      return null;
    }

    const enrichData = await enrichResponse.json();
    const enrichContent = enrichData.choices?.[0]?.message?.content || "{}";

    let jsonStr = enrichContent;
    const jsonMatch = enrichContent.match(/```json\n?([\s\S]*?)\n?```/);
    if (jsonMatch) {
      jsonStr = jsonMatch[1];
    }

    const enriched = JSON.parse(jsonStr) as EnrichedPerson;

    console.log(
      `[STAGE 3] Successfully enriched ${person.name} with score ${enriched.ai_fit_score}`
    );

    return enriched;
  } catch (error) {
    console.error(`[STAGE 3] Error enriching ${person.name}:`, error);
    return null;
  }
}

// ============================================================================
// STAGE 4: SAVE TO DATABASE
// ============================================================================

async function savePeople(
  supabase: ReturnType<typeof createClient>,
  companyName: string,
  taId: string,
  allPeople: SearchPerson[],
  selectedForEnrichment: Map<string, { person: PreFilteredPerson; enriched: EnrichedPerson }>,
  allPeopleMap: Map<string, SearchPerson>
): Promise<{ saved: number; updated: number; errors: number }> {
  console.log("[STAGE 4] Saving people to database...");

  let savedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  function scaleScore(score100: number): number {
    const scaled = Math.round(score100 / 10);
    return Math.max(1, Math.min(10, scaled));
  }

  // Save enriched people (batch upserts for speed)
  const enrichedRecords: DatabasePerson[] = [];
  for (const [, { person, enriched }] of selectedForEnrichment) {
    const original = Array.from(allPeopleMap.values()).find(
      (p) =>
        p.fullName.toLowerCase() === person.name.toLowerCase() ||
        (p.profileURL && person.profileUrl && p.profileURL.includes(person.profileUrl))
    );

    if (!original) continue;

    enrichedRecords.push({
      dm_id: crypto.randomUUID(),
      company_name: companyName,
      therapeutic_area_id: taId,
      full_name: person.name,
      headline: person.headline,
      profile_url: person.profileUrl,
      profile_picture: original.profilePicture,
      location: original.location,
      username: extractLinkedInUsername(person.profileUrl),
      summary: original.summary,
      relevance_score: scaleScore(person.pre_filter_score),
      role_category: enriched.role_category,
      search_round: original.searchRound,
      source_query: original.searchRound,
      is_enriched: true,
      enriched_at: new Date().toISOString(),
      current_title: enriched.current_title,
      current_company: enriched.current_company,
      seniority_level: enriched.seniority_level,
      years_experience: enriched.years_experience,
      education: enriched.education,
      clinical_trials_experience: enriched.clinical_trials_experience,
      leadership_experience: enriched.leadership_experience,
      neuromuscular_experience: enriched.neuromuscular_experience,
      neurology_experience: enriched.neurology_experience,
      therapeutic_areas: enriched.therapeutic_areas,
      key_skills: enriched.key_skills,
      career_highlights: enriched.career_highlights,
      ai_analysis: enriched.ai_analysis,
      ai_fit_score: Math.max(1, Math.min(10, enriched.ai_fit_score || 1)),
      outreach_hook: enriched.outreach_hook,
    });
  }

  // Batch upsert enriched records
  for (let i = 0; i < enrichedRecords.length; i += 10) {
    const batch = enrichedRecords.slice(i, i + 10);
    try {
      const { error } = await supabase
        .from("decision_makers")
        .upsert(batch, { onConflict: "profile_url" });

      if (error) {
        console.error(`[STAGE 4] Batch upsert error:`, JSON.stringify(error));
        errorCount += batch.length;
      } else {
        updatedCount += batch.length;
        console.log(`[STAGE 4] Batch saved ${batch.length} enriched people`);
      }
    } catch (error) {
      console.error(`[STAGE 4] Batch exception:`, error);
      errorCount += batch.length;
    }
  }

  // Save non-enriched people (batch upserts) — only people who passed hard filter
  const pendingRecords: DatabasePerson[] = [];
  for (const person of allPeople) {
    if (selectedForEnrichment.has(extractLinkedInUsername(person.profileURL))) {
      continue;
    }

    pendingRecords.push({
      dm_id: crypto.randomUUID(),
      company_name: companyName,
      therapeutic_area_id: taId,
      full_name: person.fullName,
      headline: person.headline,
      profile_url: person.profileURL,
      profile_picture: person.profilePicture,
      location: person.location,
      username: extractLinkedInUsername(person.profileURL),
      summary: person.summary,
      relevance_score: 1,
      role_category: "pending_enrichment",
      search_round: person.searchRound,
      source_query: person.searchRound,
      is_enriched: false,
    });
  }

  for (let i = 0; i < pendingRecords.length; i += 25) {
    const batch = pendingRecords.slice(i, i + 25);
    try {
      const { error } = await supabase
        .from("decision_makers")
        .upsert(batch, { onConflict: "profile_url" });

      if (error) {
        console.error(`[STAGE 4] Pending batch error:`, JSON.stringify(error));
        errorCount += batch.length;
      } else {
        savedCount += batch.length;
      }
    } catch (error) {
      console.error(`[STAGE 4] Pending batch exception:`, error);
      errorCount += batch.length;
    }
  }

  console.log(`[STAGE 4] Saved: ${savedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`);
  return { saved: savedCount, updated: updatedCount, errors: errorCount };
}

// ============================================================================
// MAIN HANDLER
// ============================================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  const url = new URL(req.url);
  const company = url.searchParams.get("company");
  const ta_id = url.searchParams.get("ta_id");
  const enrichTop = parseInt(url.searchParams.get("enrich_top") || "25", 10);
  const keywords = url.searchParams.get("keywords");

  console.log(`[MAIN] Starting find-decision-makers v21 (strict DM focus)`);
  console.log(
    `[MAIN] Params: company=${company}, ta_id=${ta_id}, enrich_top=${enrichTop}, keywords=${keywords}`
  );

  if (!company || !ta_id) {
    return new Response(
      JSON.stringify({ success: false, error: "Missing required parameters: company and ta_id" }),
      { status: 400, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }

  const startTime = Date.now();

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

    if (!supabaseUrl || !supabaseKey) {
      throw new Error("Missing Supabase credentials");
    }

    const supabase = createClient(supabaseUrl, supabaseKey);

    // Stage 0: Setup
    const { company: companyRecord, isNMFocused } = await setupCompanyAndTA(supabase, company, ta_id);
    const normalizedName = normalizeCompanyName(company);
    const expandedKeywords = expandKeywords(keywords || undefined);

    // Stage 1: Search people
    const allPeopleRaw = await searchAllPeople(
      company, normalizedName, ta_id, keywords, companyRecord, isNMFocused, supabase
    );

    const searchDuration = Math.round((Date.now() - startTime) / 1000);
    console.log(`[MAIN] Search complete in ${searchDuration}s, found ${allPeopleRaw.length} raw results`);

    // Stage 1.5: HARD FILTER (NEW in v21)
    const { kept: allPeople, rejected: hardRejectedCount } = applyHardFilters(allPeopleRaw);
    console.log(`[MAIN] Hard filter: ${hardRejectedCount} rejected, ${allPeople.length} kept`);

    const stats = {
      total_people_found_raw: allPeopleRaw.length,
      hard_rejected: hardRejectedCount,
      total_after_filter: allPeople.length,
      from_leadership_page: allPeople.filter((p) => p.searchRound === "leadership_page").length,
      from_job_informed: allPeople.filter((p) => p.searchRound === "job_informed").length,
      from_user_keywords: allPeople.filter((p) => p.scoringBoost >= 25 && p.searchRound !== "job_informed" && p.searchRound !== "leadership_page").length,
      from_linkedin_search: allPeople.filter(
        (p) => p.searchRound !== "leadership_page" && p.searchRound !== "job_informed" && p.scoringBoost < 25
      ).length,
      search_duration_seconds: searchDuration,
    };

    console.log(`[MAIN] Search stats:`, stats);

    // Stage 2: Pre-filter (now on cleaner input)
    const preFiltered = await preFilterPeople(allPeople, enrichTop, expandedKeywords);
    console.log(`[MAIN] Pre-filter selected ${preFiltered.length} people`);

    // Stage 3: Deep enrichment (parallel in batches of 3)
    const enrichedMap = new Map<string, { person: PreFilteredPerson; enriched: EnrichedPerson }>();
    let enrichmentAttempted = 0;
    let enrichmentSuccess = 0;

    const allPeopleMap = new Map(
      allPeople.map((p) => [extractLinkedInUsername(p.profileURL), p])
    );

    const ENRICH_BATCH_SIZE = 3;
    for (let i = 0; i < preFiltered.length; i += ENRICH_BATCH_SIZE) {
      const batch = preFiltered.slice(i, i + ENRICH_BATCH_SIZE);
      console.log(`[MAIN] Enrichment batch ${Math.floor(i / ENRICH_BATCH_SIZE) + 1}/${Math.ceil(preFiltered.length / ENRICH_BATCH_SIZE)}`);

      const results = await Promise.allSettled(
        batch.map(person => enrichPerson(person, allPeopleMap))
      );

      for (let j = 0; j < results.length; j++) {
        enrichmentAttempted++;
        const result = results[j];
        if (result.status === "fulfilled" && result.value) {
          enrichedMap.set(batch[j].name, { person: batch[j], enriched: result.value });
          enrichmentSuccess++;
        }
      }

      if (i + ENRICH_BATCH_SIZE < preFiltered.length) {
        await delay(100);
      }
    }

    console.log(`[MAIN] Enrichment: ${enrichmentSuccess}/${enrichmentAttempted} successful`);

    // Stage 4: Save
    const saveResult = await savePeople(supabase, companyRecord.company_name, ta_id, allPeople, enrichedMap, allPeopleMap);

    // Top targets
    const topTargets = Array.from(enrichedMap.values())
      .filter((item) => item.enriched.ai_fit_score >= 7)
      .sort((a, b) => b.enriched.ai_fit_score - a.enriched.ai_fit_score)
      .slice(0, 5)
      .map((item) => ({
        name: item.person.name,
        headline: item.person.headline,
        score: item.enriched.ai_fit_score,
        seniority: item.enriched.seniority_level,
        outreach_hook: item.enriched.outreach_hook,
      }));

    const duration = Math.round((Date.now() - startTime) / 1000);

    const response = {
      success: true,
      company: companyRecord.company_name,
      company_id: companyRecord.company_id,
      version: 21,
      pipeline: {
        stage_1_search: stats,
        stage_2_prefilter: { ai_selected: preFiltered.length },
        stage_3_enrichment: {
          attempted: enrichmentAttempted,
          success: enrichmentSuccess,
          failed: enrichmentAttempted - enrichmentSuccess,
        },
        saved: saveResult,
      },
      user_keywords: expandedKeywords,
      nm_focused_company: isNMFocused,
      duration_seconds: duration,
      top_targets: topTargets,
      _debug: {
        normalized_company: normalizedName,
        api_rounds: _diag.rounds,
        first_raw_response: _diag.firstRawResponse,
        leadership_page: _diag.leadershipPage,
        errors: _diag.errors,
      },
    };

    // Save diagnostics
    try {
      await supabase.from("edge_function_diagnostics").insert({
        function_name: "find-decision-makers",
        version: 21,
        company_name: company,
        diagnostics: {
          normalized_company: normalizedName,
          api_rounds: _diag.rounds,
          first_raw_response: _diag.firstRawResponse,
          leadership_page: _diag.leadershipPage,
          errors: _diag.errors,
          pipeline: response.pipeline,
          duration_seconds: duration,
        },
      });
    } catch (diagErr) {
      console.error("[DIAG] Failed to save diagnostics:", diagErr);
    }

    console.log(`[MAIN] Complete. Duration: ${duration}s`);

    return new Response(JSON.stringify(response), {
      status: 200,
      headers: { ...corsHeaders(), "Content-Type": "application/json" },
    });
  } catch (error) {
    const errorMsg = (error as Error).message || "Unknown error";
    console.error("[MAIN] Fatal error:", error);

    return new Response(
      JSON.stringify({
        success: false, error: errorMsg, version: 21,
        _debug: { api_rounds: _diag.rounds, first_raw_response: _diag.firstRawResponse, errors: _diag.errors },
      }),
      { status: 500, headers: { ...corsHeaders(), "Content-Type": "application/json" } }
    );
  }
});
